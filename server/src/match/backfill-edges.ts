import type Database from "better-sqlite3";
import { deriveLocalEdges } from "./edges.js";

// Re-derives every file's local edges from tags_raw already sitting in the
// DB — no file I/O, unlike cover/backfill.ts and scan/backfill-tags.ts.
// Exists for the same structural reason those two do: deriveLocalEdges
// only runs from inside scanFile()'s per-file path, which short-circuits
// on any file whose mtime/size are unchanged. Whenever deriveLocalEdges's
// own logic changes (as it just did in session 4 — label/producer/
// engineer/featured-artist edges), every already-scanned file needs its
// edges re-derived, and a normal re-scan can't reach them. Confirmed live:
// running a fresh re-scan against the real /mnt/music library after
// widening deriveLocalEdges produced zero released_on/produced_by/
// engineered_by/featured_artist/collaborated_with edges, despite 221/338
// files already carrying a label in tags_raw.
export function backfillLocalEdges(db: Database.Database): number {
  const files = db.prepare("SELECT id FROM files WHERE missing_since IS NULL").all() as { id: number }[];
  for (const file of files) deriveLocalEdges(db, file.id);
  return files.length;
}
