import type { Database } from "../sqlite.js";
import { addTracksToPlaylist, createPlaylist } from "../routes/playlists.js";
import { PLAYBACK_FILE_ORDER } from "../playbackFile.js";
import { readMusicLibrary, type MusicLibrary, type MusicTrack } from "./library.js";

// #133: Apple Music's play counts, ratings, date added and playlists,
// brought over from its Library.xml (library.ts reads the file).
//
// Each track in it is matched to a file Legato has scanned:
//   1. by location: the path Music has for the file is one Legato scanned;
//   2. by location under another folder: a library copied to a NAS keeps
//      its Artist/Album/file layout under a new root, so the folder each
//      side's paths share is read off files whose last three path segments
//      agree, and the rest of the paths are tried under it;
//   3. by metadata: artist and title, and a length within 2 s, as the M3U
//      import's fallback (routes/playlist-import.ts) matches. Cloud tracks
//      come here too: Legato may have a copy from somewhere else.
// A cloud track nothing matches is listed in the report as in the Apple
// Music library but not downloaded, never dropped quietly (H9).
//
// What's written, in one transaction:
//   - plays: one row per matched file holding Music's total (playCounts.ts
//     and migration 0056). Every earlier 'apple-music' row goes first, so an
//     import replaces Music's numbers rather than adding to them.
//   - imported_track_facts: rating and date added, replaced the same way.
//   - playlists: one per playlist the person made in Music, with the M3U
//     import's per-playlist report (playlist_imports), keyed by Music's
//     persistent id so a playlist already brought over isn't made twice.

const SOURCE = "apple-music";
const DURATION_TOLERANCE_MS = 2000;
// Unmatched paths sampled to find another root, and how many roots to try.
const REMAP_SAMPLE = 200;
const MAX_REMAPS = 3;
// How many cloud or missing tracks a report lists by name; the counts are
// always whole.
export const REPORT_LIST_LIMIT = 500;

export const CLOUD_REASON = "In your Apple Music library, but not downloaded to the Mac it came from";
const MISSING_REASON = "Not in Legato's library, by path or by artist, title and length";
const OTHER_REASON = "Not music Legato plays: a video, a podcast or a radio stream";

export type MatchHow = "location" | "metadata";
type Match = { fileId: number; recordingNodeId: number; how: MatchHow };

export type Remap = { from: string; to: string; tracks: number };
export type ListedTrack = { name: string | null; artist: string | null; album: string | null; location: string | null };
export type PlaylistPlan = {
  name: string;
  tracks: number;
  matched: number;
  status: "new" | "already-imported";
};

export type AppleMusicPreview = {
  // Music tracks: downloaded or not, podcasts, videos and radio aside.
  tracks: number;
  matchedByLocation: number;
  matchedByMetadata: number;
  notFound: number;
  cloudOnly: number;
  setAside: number;
  remaps: Remap[];
  plays: { tracks: number; total: number };
  ratings: number;
  datesAdded: number;
  playlists: PlaylistPlan[];
  skippedPlaylists: { smart: number; builtIn: number; folders: number };
};

export type AppleMusicImportResult = Omit<AppleMusicPreview, "playlists"> & {
  playlists: (PlaylistPlan & { playlistId: number | null })[];
  cloudOnlyTracks: ListedTrack[];
  notFoundTracks: ListedTrack[];
};

// Paths compared the way a Mac or Windows disk would: case-blind, one
// Unicode form (Music's URLs keep a Mac's decomposed accents, the scan may
// have stored the composed ones) and forward slashes. A key is its shown
// form lower-cased, so a length counted on one is a cut in the other.
function shownPath(path: string): string {
  return path.normalize("NFC").replace(/\\/g, "/");
}

function pathKey(path: string): string {
  return shownPath(path).toLowerCase();
}

function textKey(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function lastSegments(key: string, count: number): string | null {
  const parts = key.split("/");
  return parts.length > count ? parts.slice(-count).join("/") : null;
}

type FileRow = { id: number; recording_node_id: number; file_path: string };

type Index = {
  byPath: Map<string, FileRow>;
  bySuffix: Map<string, FileRow[]>;
  byTitle: Map<string, { nodeId: number; durationMs: number | null }[]>;
  fileFor: Map<number, number>;
};

// The whole library read once, so matching tens of thousands of tracks is
// lookups rather than a query apiece.
function loadIndex(db: Database): Index {
  const byPath = new Map<string, FileRow>();
  const bySuffix = new Map<string, FileRow[]>();
  for (const row of db.prepare("SELECT id, recording_node_id, file_path FROM files").all() as FileRow[]) {
    const key = pathKey(row.file_path);
    byPath.set(key, row);
    const suffix = lastSegments(key, 3);
    if (suffix) bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), row]);
  }

  // The file a recording plays from (playbackFile.ts's order), which is
  // the one a metadata match's plays are recorded against.
  const fileFor = new Map<number, number>();
  for (const row of db
    .prepare(
      `SELECT recording_node_id AS rec, id FROM files
       ORDER BY recording_node_id, missing_since IS NOT NULL, ${PLAYBACK_FILE_ORDER}`,
    )
    .all() as { rec: number; id: number }[]) {
    if (!fileFor.has(row.rec)) fileFor.set(row.rec, row.id);
  }

  // Recordings by artist and title: the performed_by edge match/edges.ts
  // derives, as the M3U import's metadata fallback reads it.
  const byTitle = new Map<string, { nodeId: number; durationMs: number | null }[]>();
  for (const row of db
    .prepare(
      `SELECT n.id AS nodeId, n.title AS title, a.title AS artist,
              COALESCE(r.canonical_duration_ms,
                       (SELECT duration_ms FROM files WHERE recording_node_id = n.id LIMIT 1)) AS durationMs
       FROM nodes n
       JOIN recordings r ON r.node_id = n.id
       JOIN edges e ON e.from_node = n.id AND e.type = 'performed_by'
       JOIN nodes a ON a.id = e.to_node AND a.type = 'artist'
       WHERE n.type = 'recording'`,
    )
    .all() as { nodeId: number; title: string; artist: string; durationMs: number | null }[]) {
    if (!fileFor.has(row.nodeId)) continue;
    const key = `${textKey(row.artist)}\u0000${textKey(row.title)}`;
    byTitle.set(key, [...(byTitle.get(key) ?? []), { nodeId: row.nodeId, durationMs: row.durationMs }]);
  }
  return { byPath, bySuffix, byTitle, fileFor };
}

// The folders two copies of a library sit under, read off unmatched paths
// whose last three segments (Artist/Album/file) name exactly one scanned
// file. The pair most of them agree on wins.
type FolderPair = { from: string; to: string; fromKey: string; toKey: string };

function discoverRemap(index: Index, unmatched: MusicTrack[]): FolderPair | null {
  const votes = new Map<string, FolderPair & { votes: number }>();
  for (const track of unmatched.slice(0, REMAP_SAMPLE)) {
    const shown = shownPath(track.location!);
    const suffix = lastSegments(shown.toLowerCase(), 3);
    const hits = suffix ? index.bySuffix.get(suffix) : undefined;
    if (!suffix || hits?.length !== 1) continue;
    const file = shownPath(hits[0]!.file_path);
    const from = shown.slice(0, shown.length - suffix.length);
    const to = file.slice(0, file.length - suffix.length);
    const pair = { from, to, fromKey: from.toLowerCase(), toKey: to.toLowerCase() };
    const id = `${pair.fromKey}\u0000${pair.toKey}`;
    const seen = votes.get(id);
    if (seen) seen.votes++;
    else votes.set(id, { ...pair, votes: 1 });
  }
  return [...votes.values()].sort((a, b) => b.votes - a.votes)[0] ?? null;
}

function byMetadata(index: Index, track: MusicTrack): Match | null {
  if (track.durationMs == null || !track.name) return null;
  let best: { nodeId: number; delta: number } | null = null;
  for (const artist of [track.artist, track.albumArtist]) {
    if (!artist) continue;
    for (const candidate of index.byTitle.get(`${textKey(artist)}\u0000${textKey(track.name)}`) ?? []) {
      if (candidate.durationMs == null) continue;
      const delta = Math.abs(candidate.durationMs - track.durationMs);
      if (delta <= DURATION_TOLERANCE_MS && (!best || delta < best.delta)) best = { nodeId: candidate.nodeId, delta };
    }
    if (best) break;
  }
  return best ? { fileId: index.fileFor.get(best.nodeId)!, recordingNodeId: best.nodeId, how: "metadata" } : null;
}

type Plan = {
  library: MusicLibrary;
  matches: Map<number, Match>;
  remaps: Remap[];
  preview: AppleMusicPreview;
};

function plan(db: Database, xml: string): Plan {
  const library = readMusicLibrary(xml);
  const index = loadIndex(db);
  const matches = new Map<number, Match>();
  const music = [...library.tracks.values()].filter((t) => t.kind !== "other");

  // 1. By location.
  let unmatched: MusicTrack[] = [];
  for (const track of music) {
    if (track.kind !== "local") continue;
    const hit = index.byPath.get(pathKey(track.location!));
    if (hit) matches.set(track.trackId, { fileId: hit.id, recordingNodeId: hit.recording_node_id, how: "location" });
    else unmatched.push(track);
  }

  // 2. By location under another folder.
  const remaps: Remap[] = [];
  for (let i = 0; i < MAX_REMAPS && unmatched.length > 0; i++) {
    const remap = discoverRemap(index, unmatched);
    if (!remap) break;
    let found = 0;
    unmatched = unmatched.filter((track) => {
      const key = pathKey(track.location!);
      if (!key.startsWith(remap.fromKey)) return true;
      const hit = index.byPath.get(remap.toKey + key.slice(remap.fromKey.length));
      if (!hit) return true;
      matches.set(track.trackId, { fileId: hit.id, recordingNodeId: hit.recording_node_id, how: "location" });
      found++;
      return false;
    });
    if (found === 0) break;
    remaps.push({ from: remap.from, to: remap.to, tracks: found });
  }

  // 3. By metadata, for what's left and for every cloud track.
  for (const track of music) {
    if (matches.has(track.trackId)) continue;
    const hit = byMetadata(index, track);
    if (hit) matches.set(track.trackId, hit);
  }

  const matched = music.filter((t) => matches.has(t.trackId));
  const played = matched.filter((t) => t.playCount > 0);
  const existing = new Set(
    (
      db.prepare("SELECT source_key FROM playlist_imports WHERE source_key IS NOT NULL").all() as {
        source_key: string;
      }[]
    ).map((row) => row.source_key),
  );
  const userPlaylists = library.playlists.filter((p) => p.kind === "user");
  const preview: AppleMusicPreview = {
    tracks: music.length,
    matchedByLocation: matched.filter((t) => matches.get(t.trackId)!.how === "location").length,
    matchedByMetadata: matched.filter((t) => matches.get(t.trackId)!.how === "metadata").length,
    notFound: music.filter((t) => t.kind === "local" && !matches.has(t.trackId)).length,
    cloudOnly: music.filter((t) => t.kind === "cloud" && !matches.has(t.trackId)).length,
    setAside: library.tracks.size - music.length,
    remaps,
    plays: { tracks: played.length, total: played.reduce((sum, t) => sum + t.playCount, 0) },
    ratings: matched.filter((t) => t.rating != null).length,
    datesAdded: matched.filter((t) => t.dateAdded != null).length,
    playlists: userPlaylists.map((p) => ({
      name: p.name,
      tracks: p.trackIds.length,
      matched: p.trackIds.filter((id) => matches.has(id)).length,
      status: p.persistentId && existing.has(sourceKey(p.persistentId)) ? "already-imported" : "new",
    })),
    skippedPlaylists: {
      smart: library.playlists.filter((p) => p.kind === "smart").length,
      builtIn: library.playlists.filter((p) => p.kind === "built-in").length,
      folders: library.playlists.filter((p) => p.kind === "folder").length,
    },
  };
  return { library, matches, remaps, preview };
}

function sourceKey(persistentId: string): string {
  return `${SOURCE}:${persistentId}`;
}

/** What an import would do, read-only. */
export function previewAppleMusicImport(db: Database, xml: string): AppleMusicPreview {
  return plan(db, xml).preview;
}

function listed(tracks: MusicTrack[]): ListedTrack[] {
  return tracks
    .slice()
    .sort(
      (a, b) =>
        (a.albumArtist ?? a.artist ?? "").localeCompare(b.albumArtist ?? b.artist ?? "") ||
        (a.album ?? "").localeCompare(b.album ?? "") ||
        (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
        (a.trackNumber ?? 0) - (b.trackNumber ?? 0) ||
        (a.name ?? "").localeCompare(b.name ?? ""),
    )
    .slice(0, REPORT_LIST_LIMIT)
    .map((t) => ({ name: t.name, artist: t.artist, album: t.album, location: t.location }));
}

export function importAppleMusicLibrary(db: Database, filename: string, xml: string): AppleMusicImportResult {
  const { library, matches, preview } = plan(db, xml);
  const music = [...library.tracks.values()].filter((t) => t.kind !== "other");

  // One total per file: two Music tracks can be the same file (a
  // duplicate entry), and their plays are that file's plays.
  const perFile = new Map<
    number,
    { rec: number; plays: number; lastPlayedAt: string | null; rating: number | null; dateAdded: string | null }
  >();
  for (const track of music) {
    const match = matches.get(track.trackId);
    if (!match) continue;
    const had = perFile.get(match.fileId);
    if (!had) {
      perFile.set(match.fileId, {
        rec: match.recordingNodeId,
        plays: track.playCount,
        lastPlayedAt: track.lastPlayedAt,
        rating: track.rating,
        dateAdded: track.dateAdded,
      });
      continue;
    }
    had.plays += track.playCount;
    if (track.lastPlayedAt && (!had.lastPlayedAt || track.lastPlayedAt > had.lastPlayedAt))
      had.lastPlayedAt = track.lastPlayedAt;
    had.rating ??= track.rating;
    if (track.dateAdded && (!had.dateAdded || track.dateAdded < had.dateAdded)) had.dateAdded = track.dateAdded;
  }

  const commit = db.transaction(() => {
    db.prepare("DELETE FROM plays WHERE source = ?").run(SOURCE);
    const insertPlays = db.prepare(
      `INSERT INTO plays (recording_node_id, file_id, started_at, ms_played, source, play_count)
       VALUES (?, ?, ?, 0, ?, ?)`,
    );
    db.prepare("DELETE FROM imported_track_facts WHERE source = ?").run(SOURCE);
    const insertFacts = db.prepare(
      "INSERT INTO imported_track_facts (file_id, source, rating, date_added) VALUES (?, ?, ?, ?)",
    );
    for (const [fileId, facts] of perFile) {
      if (facts.plays > 0) insertPlays.run(facts.rec, fileId, facts.lastPlayedAt ?? "", SOURCE, facts.plays);
      if (facts.rating != null || facts.dateAdded != null)
        insertFacts.run(fileId, SOURCE, facts.rating, facts.dateAdded);
    }

    const insertImport = db.prepare(
      "INSERT INTO playlist_imports (playlist_id, source_filename, source_key) VALUES (?, ?, ?) RETURNING id",
    );
    const insertEntry = db.prepare(
      `INSERT INTO playlist_import_entries
         (import_id, position, raw_path, extinf_artist, extinf_title, extinf_duration_seconds, match_type, matched_node_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const userPlaylists = library.playlists.filter((p) => p.kind === "user");
    return userPlaylists.map((playlist, i) => {
      const planned = preview.playlists[i]!;
      if (planned.status === "already-imported") return { ...planned, playlistId: null };
      const created = createPlaylist(db, playlist.name);
      const nodes = playlist.trackIds.flatMap((id) => {
        const match = matches.get(id);
        return match ? [match.recordingNodeId] : [];
      });
      if (nodes.length > 0) addTracksToPlaylist(db, created.id, nodes);
      const importId = (
        insertImport.get(created.id, filename, playlist.persistentId ? sourceKey(playlist.persistentId) : null) as {
          id: number;
        }
      ).id;
      playlist.trackIds.forEach((id, position) => {
        const track = library.tracks.get(id);
        const match = matches.get(id);
        insertEntry.run(
          importId,
          position + 1,
          track?.location ?? "",
          track?.artist ?? null,
          track?.name ?? null,
          track?.durationMs != null ? Math.round(track.durationMs / 1000) : null,
          match ? (match.how === "location" ? "path" : "metadata") : "missing",
          match?.recordingNodeId ?? null,
          match
            ? null
            : !track || track.kind === "other"
              ? OTHER_REASON
              : track.kind === "cloud"
                ? CLOUD_REASON
                : MISSING_REASON,
        );
      });
      return { ...planned, playlistId: created.id };
    });
  });

  const playlists = commit();
  return {
    ...preview,
    playlists,
    cloudOnlyTracks: listed(music.filter((t) => t.kind === "cloud" && !matches.has(t.trackId))),
    notFoundTracks: listed(music.filter((t) => t.kind === "local" && !matches.has(t.trackId))),
  };
}
