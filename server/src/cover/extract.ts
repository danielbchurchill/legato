import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Database } from "../sqlite.js";
import { storeCover } from "./store.js";

export type CoverSource = "embedded" | "folder" | "caa" | "manual" | "artist_image";

// Precedence when a node has art from several sources. A deliberate human
// choice always wins; art carried inside the file beats a loose image next to
// it (the file travels with its own art, a folder image may belong to a
// different edition); anything fetched from the network is the last resort.
//
// artist_image (a fetched artist photo, enrich/deezer.ts) sits directly
// under 'manual' rather than down with the other network sources: it only
// ever lands on an artist node, where the alternative isn't album art of
// its own but the borrowed most-represented-album cover coverTargetNode
// falls back to below — a real photo of the artist beats that outright. It
// still loses to a manual override, same as everything else.
const PRECEDENCE: CoverSource[] = ["manual", "artist_image", "embedded", "folder", "caa"];

const FOLDER_ART_STEMS = new Set(["cover", "folder", "front", "album", "albumart"]);
const FOLDER_ART_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// A multi-disc rip nests each disc in its own CD1/CD2/Disc 3 folder under one
// album root — real shape of e.g. "Wildflowers & All The Rest (Deluxe)"/CD4 —
// and the actual cover art sits once in that root, not copied into every
// disc folder. Matches the same cd/disc-number vocabulary sanityCheck.ts's
// REVERSED_VOLUME_PREFIX already uses for the tag-side version of this.
const DISC_SUBFOLDER = /^(cd|disc)\s*\d+$/i;

export type EmbeddedPicture = { data: Buffer; mime: string | null };

// music-metadata hands back every attached picture: front cover, back cover,
// artist photos, the lot. Take the one actually flagged as a front cover and
// only fall back to "the first one" when nothing is labelled, so an album with
// a back-cover scan doesn't end up displaying its own back cover.
export function pickFrontCover(
  pictures: { data: Uint8Array; format?: string; type?: string }[] | undefined,
): EmbeddedPicture | null {
  if (!pictures || pictures.length === 0) return null;

  const front = pictures.find((p) => p.type?.toLowerCase().includes("front"));
  const chosen = front ?? pictures[0];

  return { data: Buffer.from(chosen.data), mime: chosen.format ?? null };
}

// Looks for a loose cover image sitting next to the audio file — the normal
// shape of a ripped library, where the art is one cover.jpg per album folder
// rather than embedded in all twelve tracks.
export async function findFolderArt(audioFilePath: string): Promise<{ path: string } | null> {
  const dir = path.dirname(audioFilePath);
  const direct = await findArtInDir(dir);
  if (direct) return direct;

  // The disc folder itself came up empty — if it looks like "CD4" rather
  // than an album folder in its own right, the art most likely lives one
  // level up, shared across every disc.
  if (DISC_SUBFOLDER.test(path.basename(dir))) {
    return findArtInDir(path.dirname(dir));
  }

  return null;
}

async function findArtInDir(dir: string): Promise<{ path: string } | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  // Ordered by FOLDER_ART_STEMS preference rather than by directory order, so
  // a folder holding both cover.jpg and front.png resolves the same way every
  // time regardless of how the filesystem happens to list it.
  const candidates = entries
    .map((name) => ({ name, ext: path.extname(name).toLowerCase() }))
    .filter((e) => FOLDER_ART_EXTENSIONS.has(e.ext))
    // Sliced by length rather than path.basename(name, ext): basename matches
    // its suffix case-sensitively, so stripping ".jpg" from "Folder.JPG" is a
    // silent no-op and the stem never matches.
    .map((e) => ({ ...e, stem: e.name.slice(0, e.name.length - e.ext.length).toLowerCase() }))
    .filter((e) => FOLDER_ART_STEMS.has(e.stem));

  if (candidates.length === 0) return null;

  const best = [...FOLDER_ART_STEMS].reduce<(typeof candidates)[number] | null>(
    (found, stem) => found ?? candidates.find((c) => c.stem === stem) ?? null,
    null,
  );

  return best ? { path: path.join(dir, best.name) } : null;
}

// Cover art belongs to the album, not the track — twelve files in one folder
// should produce one cover, attached to the release they all point at. Loose
// files with no album tag have no release node, so their art attaches to the
// recording itself and still renders.
//
// G-7: an artist node has no release of its own to inherit art from via
// appears_on (only recordings carry that edge) — widened to fall through to
// their most-represented album (highest track_count, ties broken by lowest
// node id, matching albums' own primary_artist_node_id doc comment) when
// the recording path finds nothing. Safe for every other node type too:
// node ids are unique across types, so a release or label id never
// coincidentally matches an appears_on source or an albums.
// primary_artist_node_id, and both queries simply return nothing for one —
// falling through to the unchanged `?? nodeId` identity case.
export function coverTargetNode(db: Database, nodeId: number): number {
  const release = db
    .prepare("SELECT to_node FROM edges WHERE from_node = ? AND type = 'appears_on' LIMIT 1")
    .get(nodeId) as { to_node: number } | undefined;
  if (release) return release.to_node;

  const album = db
    .prepare("SELECT node_id FROM albums WHERE primary_artist_node_id = ? ORDER BY track_count DESC, node_id ASC LIMIT 1")
    .get(nodeId) as { node_id: number } | undefined;
  return album?.node_id ?? nodeId;
}

export function recordCover(
  db: Database,
  entry: {
    nodeId: number;
    source: CoverSource;
    hash: string;
    mime: string | null;
    originFileId?: number | null;
    originPath?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO cover_art (node_id, source, hash, mime, origin_file_id, origin_path)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (node_id, source) DO UPDATE SET
       hash = excluded.hash,
       mime = excluded.mime,
       origin_file_id = excluded.origin_file_id,
       origin_path = excluded.origin_path,
       updated_at = datetime('now')`,
  ).run(
    entry.nodeId,
    entry.source,
    entry.hash,
    entry.mime,
    entry.originFileId ?? null,
    entry.originPath ?? null,
  );
}

export type ResolvedCover = { hash: string; mime: string | null; source: CoverSource };

export function resolveCover(db: Database, nodeId: number): ResolvedCover | null {
  const rows = db
    .prepare("SELECT hash, mime, source FROM cover_art WHERE node_id = ?")
    .all(nodeId) as ResolvedCover[];

  for (const source of PRECEDENCE) {
    const match = rows.find((r) => r.source === source);
    if (match) return match;
  }
  return null;
}

// The whole resolution chain in one call: this node's own art, else whatever
// coverTargetNode walks to (a recording's release, an artist's most-
// represented album).
//
// The single answer to "what art does this node display", used by the image
// endpoint, the graph's node list and the similarity strip alike. Three
// places previously each re-derived it — routes/cover.ts in JS, routes/
// nodes.ts as a looser EXISTS in SQL, routes/similarity.ts in a third
// shape — and the SQL one already disagreed with the others about *which*
// of an artist's albums it borrowed from (G-7's own comment admits it).
// Divergence there is invisible until it isn't: the graph would render one
// album's cover on a node whose panel then shows a different one.
export function resolveCoverForNode(db: Database, nodeId: number): ResolvedCover | null {
  const direct = resolveCover(db, nodeId);
  if (direct) return direct;

  const target = coverTargetNode(db, nodeId);
  return target === nodeId ? null : resolveCover(db, target);
}

// Called from the scanner once a file's edges exist, so the release node it
// belongs to is already known.
//
// Deliberately never throws: a corrupt embedded image or an unreadable folder
// must not fail the scan of an otherwise perfectly good audio file. The caller
// logs; the file still ends up in the library, just without art.
export async function attachCoverForFile(
  db: Database,
  file: { id: number; path: string; recordingNodeId: number },
  embedded: EmbeddedPicture | null,
): Promise<CoverSource | null> {
  const nodeId = coverTargetNode(db, file.recordingNodeId);

  if (embedded) {
    const hash = await storeCover(embedded.data);
    recordCover(db, {
      nodeId,
      source: "embedded",
      hash,
      mime: embedded.mime,
      originFileId: file.id,
    });
    return "embedded";
  }

  // Only probe the directory when the file carried nothing itself — this runs
  // per file, and a readdir per track across a large library is not free.
  const folder = await findFolderArt(file.path);
  if (!folder) return null;

  const bytes = await readFile(folder.path);
  const hash = await storeCover(bytes);
  recordCover(db, {
    nodeId,
    source: "folder",
    hash,
    mime: null,
    originFileId: file.id,
    originPath: folder.path,
  });
  return "folder";
}
