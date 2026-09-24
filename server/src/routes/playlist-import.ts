import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { broadcast } from "../ws.js";
import { addTrackToPlaylist, createPlaylist, type PlaylistRow } from "./playlists.js";
import { longestCommonPathPrefix, normalizeSeparators, parseM3U } from "./m3u-parse.js";

// #124: import a playlist exported on another machine. The paths inside
// almost always point somewhere this server can't see (`D:\Music\…`,
// `/Volumes/Music/…`) — see docs/plans/04-library-and-scan.md's "M3U /
// M3U8 import" section, which this module implements in full:
//
//   1. Try each entry's path as-is (normalized to forward slashes) against
//      files.file_path.
//   2. For whatever's left unmatched, offer to replace the longest common
//      prefix of those paths with a library root, previewing how many of
//      them would then match before anything is committed.
//   3. Whatever's still unmatched after that falls back to artist + title +
//      duration (±2s) from the file's #EXTINF lines, if it had any.
//   4. The playlist is created from whatever matched; a permanent report —
//      matched by path / matched by metadata / missing, with a reason for
//      every miss — is stored alongside it (0025_playlist_imports.sql) so
//      it stays viewable after the fact, not just in the import response.

export type PathRemap = { from: string; to: string };

export type ImportEntryResult = {
  position: number;
  rawPath: string;
  extinfArtist: string | null;
  extinfTitle: string | null;
  extinfDurationSeconds: number | null;
  matchType: "path" | "metadata" | "missing";
  matchedNodeId: number | null;
  reason: string | null;
};

export type PrefixSuggestion = {
  libraryRootId: number;
  libraryRootPath: string;
  replacement: string;
  previewMatchCount: number;
};

export type ImportPreview = {
  totalEntries: number;
  matchedByPath: number;
  unmatchedByPath: number;
  commonPrefix: string | null;
  suggestions: PrefixSuggestion[];
};

export type ImportResult = {
  importId: number;
  playlist: PlaylistRow;
  entries: ImportEntryResult[];
  matchedByPathCount: number;
  matchedByMetadataCount: number;
  missingCount: number;
};

export type ImportReport = {
  importId: number;
  playlistId: number;
  sourceFilename: string;
  createdAt: string;
  entries: ImportEntryResult[];
};

// files.file_path is UNIQUE (0002_scan.sql), so a hit here is always
// exactly one file — and therefore one recording node, which is what a
// playlist track actually points at (playlists.ts's addTrackToPlaylist).
// Case-insensitive: the whole point of this importer is paths that
// originated on a different OS, and NTFS/APFS are both case-insensitive by
// default even though the library itself was very likely scanned on Linux.
function findFileByPath(db: Database, filePath: string): { recording_node_id: number } | undefined {
  return db.prepare("SELECT recording_node_id FROM files WHERE lower(file_path) = lower(?)").get(filePath) as
    | { recording_node_id: number }
    | undefined;
}

// Applies a prefix remap to one already-normalized (forward-slash) path,
// or returns null if the path doesn't start with `from` — same shape a
// plain String.replace(prefix, "") + concat would give, kept as its own
// function since both the preview and commit paths need exactly this once
// each, on top of the same normalization.
function applyRemap(normalizedPath: string, remap: PathRemap): string | null {
  const from = normalizeSeparators(remap.from);
  if (!normalizedPath.toLowerCase().startsWith(from.toLowerCase())) return null;
  const to = normalizeSeparators(remap.to).replace(/\/+$/, "/");
  return to + normalizedPath.slice(from.length).replace(/^\/+/, "");
}

// True if this path (after an optional remap) resolves to a real file.
function resolveByPath(db: Database, rawPath: string, remap: PathRemap | null): number | null {
  const normalized = normalizeSeparators(rawPath);
  const direct = findFileByPath(db, normalized);
  if (direct) return direct.recording_node_id;

  if (remap) {
    const remapped = applyRemap(normalized, remap);
    if (remapped) {
      const viaRemap = findFileByPath(db, remapped);
      if (viaRemap) return viaRemap.recording_node_id;
    }
  }
  return null;
}

const DURATION_TOLERANCE_MS = 2000;

type MetadataCandidate = { nodeId: number; durationMs: number | null };

// Recording nodes credited (edges.type = 'performed_by', see match/edges.ts)
// to an artist of that name, titled to match — both comparisons
// case/whitespace-insensitive, same convention match/edges.ts's own
// findOrCreateNode uses for collapsing artist/release/year nodes. Duration
// isn't filtered in SQL: it needs the ±2s tolerance applied in JS anyway to
// pick the closest candidate when more than one title+artist pair matches
// (a live version and a studio version sharing a title, say).
function findMetadataCandidates(db: Database, artist: string, title: string): MetadataCandidate[] {
  return db
    .prepare(
      `SELECT DISTINCT n.id AS nodeId,
              COALESCE(r.canonical_duration_ms, (SELECT duration_ms FROM files WHERE recording_node_id = n.id LIMIT 1)) AS durationMs
       FROM nodes n
       JOIN recordings r ON r.node_id = n.id
       JOIN edges e ON e.from_node = n.id AND e.type = 'performed_by'
       JOIN nodes a ON a.id = e.to_node AND a.type = 'artist'
       WHERE n.type = 'recording'
         AND lower(trim(n.title)) = lower(trim(?))
         AND lower(trim(a.title)) = lower(trim(?))`,
    )
    .all(title, artist) as MetadataCandidate[];
}

function resolveByMetadata(db: Database, artist: string, title: string, durationSeconds: number): number | null {
  const targetMs = durationSeconds * 1000;
  let best: { nodeId: number; delta: number } | null = null;
  for (const candidate of findMetadataCandidates(db, artist, title)) {
    if (candidate.durationMs == null) continue;
    const delta = Math.abs(candidate.durationMs - targetMs);
    if (delta > DURATION_TOLERANCE_MS) continue;
    if (!best || delta < best.delta) best = { nodeId: candidate.nodeId, delta };
  }
  return best?.nodeId ?? null;
}

// Escapes LIKE's own wildcard characters ('%', '_') so a literal filename
// containing either — not rare, e.g. "Track_01.flac" — is searched for
// literally rather than as a pattern.
function escapeLikeLiteral(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

// The actual remap-discovery step. The naive version of this — replace the
// common prefix with each configured library root's own path — breaks the
// moment the *unmatched subset's* common prefix happens to be deeper than
// any root (e.g. an M3U that's a single album, whose unmatched paths share
// nothing shallower than that album's own folder): the root by itself is
// missing the artist/album segments in between, and a plain replace loses
// them. So instead of guessing from configured roots, this reads the
// answer out of the library directly — for each unmatched path's suffix
// past the common prefix (typically a filename, sometimes a few trailing
// path segments), it looks for a real file elsewhere in the library ending
// in exactly that suffix at a directory boundary, and takes whatever comes
// before it in *that* file's real path as the implied replacement. That
// self-corrects for however deep the common prefix turned out to be,
// including the top-level-root case the naive version handled by luck.
function discoverReplacements(
  db: Database,
  unmatchedPaths: string[],
  commonPrefix: string,
): { libraryRootId: number; libraryRootPath: string; replacement: string }[] {
  const roots = new Map(
    (db.prepare("SELECT id, path FROM library_roots WHERE enabled = 1").all() as { id: number; path: string }[]).map(
      (root) => [root.id, root.path] as const,
    ),
  );

  const findBySuffix = db.prepare("SELECT file_path, library_root_id FROM files WHERE file_path LIKE ? ESCAPE '\\'");

  const discovered = new Map<string, { libraryRootId: number; libraryRootPath: string; replacement: string }>();

  for (const path of unmatchedPaths) {
    const suffix = normalizeSeparators(path).slice(commonPrefix.length);
    if (!suffix) continue;

    const rows = findBySuffix.all(`%${escapeLikeLiteral(suffix)}`) as { file_path: string; library_root_id: number }[];
    for (const row of rows) {
      const normalizedFilePath = normalizeSeparators(row.file_path);
      const cut = normalizedFilePath.length - suffix.length;
      // Require the suffix to start right after a '/' (or be the whole
      // path) — otherwise "Police.flac" would "match" the tail of
      // "06 Karma Police.flac" without actually being the same file.
      if (cut > 0 && normalizedFilePath[cut - 1] !== "/") continue;
      if (cut < 0) continue;

      const replacement = normalizedFilePath.slice(0, cut);
      const rootPath = roots.get(row.library_root_id);
      if (!rootPath) continue;

      const key = `${row.library_root_id}::${replacement}`;
      if (!discovered.has(key)) {
        discovered.set(key, { libraryRootId: row.library_root_id, libraryRootPath: rootPath, replacement });
      }
    }
  }

  return [...discovered.values()];
}

// Given the paths still unmatched after step 1 and their common prefix,
// discovers candidate replacements from the library itself (see
// discoverReplacements above) and counts, for each, how many of *all* the
// unmatched paths would then resolve — not just the one(s) it was derived
// from. Only candidates that gain at least one match are worth surfacing;
// sorted best-first so the UI's "one-click suggestion" is unambiguous.
function suggestPrefixRemaps(db: Database, unmatchedPaths: string[], commonPrefix: string): PrefixSuggestion[] {
  return discoverReplacements(db, unmatchedPaths, commonPrefix)
    .map((candidate): PrefixSuggestion => {
      const remap: PathRemap = { from: commonPrefix, to: candidate.replacement };
      const previewMatchCount = unmatchedPaths.filter((p) => resolveByPath(db, p, remap) != null).length;
      return {
        libraryRootId: candidate.libraryRootId,
        libraryRootPath: candidate.libraryRootPath,
        replacement: candidate.replacement,
        previewMatchCount,
      };
    })
    .filter((s) => s.previewMatchCount > 0)
    .sort((a, b) => b.previewMatchCount - a.previewMatchCount);
}

// Read-only: parses and matches by path (optionally through a candidate
// remap) without touching the database, so the UI can iterate on a remap
// suggestion — or a hand-typed one — and see the match count update before
// committing to anything.
export function previewM3UImport(db: Database, content: string, remap: PathRemap | null): ImportPreview {
  const parsed = parseM3U(content);
  const unmatchedPaths: string[] = [];
  let matchedByPath = 0;

  for (const entry of parsed) {
    if (resolveByPath(db, entry.rawPath, remap) != null) matchedByPath++;
    else unmatchedPaths.push(entry.rawPath);
  }

  const commonPrefix = longestCommonPathPrefix(unmatchedPaths.map(normalizeSeparators)) || null;
  const suggestions = commonPrefix ? suggestPrefixRemaps(db, unmatchedPaths, commonPrefix) : [];

  return {
    totalEntries: parsed.length,
    matchedByPath,
    unmatchedByPath: unmatchedPaths.length,
    commonPrefix,
    suggestions,
  };
}

function reasonFor(entry: { extinfArtist: string | null; extinfTitle: string | null; extinfDurationSeconds: number | null }): string {
  if (entry.extinfArtist && entry.extinfTitle && entry.extinfDurationSeconds != null) {
    return "no library track matched artist, title, and duration within ±2s";
  }
  if (entry.extinfArtist && entry.extinfTitle) {
    return "path not found, and the playlist's #EXTINF had no duration to match by";
  }
  return "path not found, and the playlist has no #EXTINF metadata to fall back on";
}

// Parses, matches (path first, then the remap if one was chosen, then
// metadata for whatever's still unresolved), creates the playlist from
// whatever matched, and persists the full per-entry report — all in one
// transaction, so a half-imported playlist with no report row never exists.
export function importM3U(
  db: Database,
  filename: string,
  content: string,
  remap: PathRemap | null,
  playlistName?: string,
): ImportResult {
  const parsed = parseM3U(content);

  const results: ImportEntryResult[] = parsed.map((entry) => {
    const byPath = resolveByPath(db, entry.rawPath, remap);
    if (byPath != null) {
      return {
        position: entry.position,
        rawPath: entry.rawPath,
        extinfArtist: entry.extinfArtist,
        extinfTitle: entry.extinfTitle,
        extinfDurationSeconds: entry.extinfDurationSeconds,
        matchType: "path",
        matchedNodeId: byPath,
        reason: null,
      };
    }

    const byMetadata =
      entry.extinfArtist && entry.extinfTitle && entry.extinfDurationSeconds != null
        ? resolveByMetadata(db, entry.extinfArtist, entry.extinfTitle, entry.extinfDurationSeconds)
        : null;

    return {
      position: entry.position,
      rawPath: entry.rawPath,
      extinfArtist: entry.extinfArtist,
      extinfTitle: entry.extinfTitle,
      extinfDurationSeconds: entry.extinfDurationSeconds,
      matchType: byMetadata != null ? "metadata" : "missing",
      matchedNodeId: byMetadata,
      reason: byMetadata != null ? null : reasonFor(entry),
    };
  });

  const name = playlistName?.trim() || filename.replace(/\.m3u8?$/i, "").trim() || "Imported playlist";

  const insertEntry = db.prepare(
    `INSERT INTO playlist_import_entries
       (import_id, position, raw_path, extinf_artist, extinf_title, extinf_duration_seconds, match_type, matched_node_id, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const commit = db.transaction(() => {
    const playlist = createPlaylist(db, name);

    for (const result of results) {
      if (result.matchedNodeId != null) addTrackToPlaylist(db, playlist.id, result.matchedNodeId);
    }

    const importRow = db
      .prepare("INSERT INTO playlist_imports (playlist_id, source_filename) VALUES (?, ?) RETURNING id")
      .get(playlist.id, filename) as { id: number };

    for (const result of results) {
      insertEntry.run(
        importRow.id,
        result.position,
        result.rawPath,
        result.extinfArtist,
        result.extinfTitle,
        result.extinfDurationSeconds,
        result.matchType,
        result.matchedNodeId,
        result.reason,
      );
    }

    return { playlist, importId: importRow.id };
  });

  const { playlist, importId } = commit();
  broadcast("playlist:changed", { id: playlist.id });

  return {
    importId,
    playlist,
    entries: results,
    matchedByPathCount: results.filter((r) => r.matchType === "path").length,
    matchedByMetadataCount: results.filter((r) => r.matchType === "metadata").length,
    missingCount: results.filter((r) => r.matchType === "missing").length,
  };
}

// The most recent import for a playlist — the report "stays viewable"
// (#124's third done-when item) by being re-fetchable here, not just in
// the POST /playlists/import response. Most playlists will only ever have
// one, but nothing stops re-importing into the same playlist, so this
// reads the latest rather than assuming exactly one row exists.
export function getImportReport(db: Database, playlistId: number): ImportReport | null {
  const importRow = db
    .prepare("SELECT id, source_filename, created_at FROM playlist_imports WHERE playlist_id = ? ORDER BY id DESC LIMIT 1")
    .get(playlistId) as { id: number; source_filename: string; created_at: string } | undefined;
  if (!importRow) return null;

  const rows = db
    .prepare(
      `SELECT position, raw_path, extinf_artist, extinf_title, extinf_duration_seconds, match_type, matched_node_id, reason
       FROM playlist_import_entries WHERE import_id = ? ORDER BY position`,
    )
    .all(importRow.id) as {
    position: number;
    raw_path: string;
    extinf_artist: string | null;
    extinf_title: string | null;
    extinf_duration_seconds: number | null;
    match_type: ImportEntryResult["matchType"];
    matched_node_id: number | null;
    reason: string | null;
  }[];

  return {
    importId: importRow.id,
    playlistId,
    sourceFilename: importRow.source_filename,
    createdAt: importRow.created_at,
    entries: rows.map((row) => ({
      position: row.position,
      rawPath: row.raw_path,
      extinfArtist: row.extinf_artist,
      extinfTitle: row.extinf_title,
      extinfDurationSeconds: row.extinf_duration_seconds,
      matchType: row.match_type,
      matchedNodeId: row.matched_node_id,
      reason: row.reason,
    })),
  };
}

export function playlistImportRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.post<{ Body: { content?: string; remap?: PathRemap } }>("/playlists/import/preview", async (request, reply) => {
      const content = request.body?.content;
      if (!content?.trim()) {
        reply.code(400);
        return { error: "content must not be empty" };
      }
      return previewM3UImport(db, content, request.body?.remap ?? null);
    });

    app.post<{ Body: { filename?: string; content?: string; remap?: PathRemap; playlistName?: string } }>(
      "/playlists/import",
      async (request, reply) => {
        const { filename, content, remap, playlistName } = request.body ?? {};
        if (!filename || !content?.trim()) {
          reply.code(400);
          return { error: "filename and content are required" };
        }
        return importM3U(db, filename, content, remap ?? null, playlistName);
      },
    );

    app.get<{ Params: { id: string } }>("/playlists/:id/import-report", async (request, reply) => {
      const report = getImportReport(db, Number(request.params.id));
      if (!report) {
        reply.code(404);
        return { error: "no import report for this playlist" };
      }
      return report;
    });
  };
}
