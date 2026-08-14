import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { storeCover } from "./store.js";

export type CoverSource = "embedded" | "folder" | "caa" | "manual";

// Precedence when a node has art from several sources. A deliberate human
// choice always wins; art carried inside the file beats a loose image next to
// it (the file travels with its own art, a folder image may belong to a
// different edition); anything fetched from the network is the last resort.
const PRECEDENCE: CoverSource[] = ["manual", "embedded", "folder", "caa"];

const FOLDER_ART_STEMS = new Set(["cover", "folder", "front", "album", "albumart"]);
const FOLDER_ART_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

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
export function coverTargetNode(db: Database.Database, recordingNodeId: number): number {
  const release = db
    .prepare("SELECT to_node FROM edges WHERE from_node = ? AND type = 'appears_on' LIMIT 1")
    .get(recordingNodeId) as { to_node: number } | undefined;
  return release?.to_node ?? recordingNodeId;
}

export function recordCover(
  db: Database.Database,
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

export function resolveCover(db: Database.Database, nodeId: number): ResolvedCover | null {
  const rows = db
    .prepare("SELECT hash, mime, source FROM cover_art WHERE node_id = ?")
    .all(nodeId) as ResolvedCover[];

  for (const source of PRECEDENCE) {
    const match = rows.find((r) => r.source === source);
    if (match) return match;
  }
  return null;
}

// Called from the scanner once a file's edges exist, so the release node it
// belongs to is already known.
//
// Deliberately never throws: a corrupt embedded image or an unreadable folder
// must not fail the scan of an otherwise perfectly good audio file. The caller
// logs; the file still ends up in the library, just without art.
export async function attachCoverForFile(
  db: Database.Database,
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
