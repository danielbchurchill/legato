import type Database from "better-sqlite3";
import { parseTags } from "../scan/tags.js";
import { attachCoverForFile, coverTargetNode, resolveCover } from "./extract.js";

export type BackfillProgress = {
  filesConsidered: number;
  coversAdded: number;
  albumsSkipped: number;
  failures: number;
};

// Attaches art to a library that was scanned before cover extraction existed.
//
// A normal re-scan cannot do this: scanFile() short-circuits on any file whose
// mtime and size are unchanged, which is every file in an already-scanned
// library. Touching them all to force a re-read would be far more destructive
// than a one-off pass that only reads what it needs.
//
// Files are walked in id order but art resolves per *album*, so the first
// track of a release supplies the cover and its remaining tracks are skipped
// without ever being opened. On a typical library that means roughly one file
// read per album rather than one per track.
export async function backfillCovers(
  db: Database.Database,
  onProgress?: (progress: BackfillProgress) => void,
): Promise<BackfillProgress> {
  const files = db
    .prepare(
      `SELECT id, file_path, recording_node_id
         FROM files
        WHERE missing_since IS NULL
        ORDER BY id`,
    )
    .all() as { id: number; file_path: string; recording_node_id: number }[];

  const progress: BackfillProgress = {
    filesConsidered: 0,
    coversAdded: 0,
    albumsSkipped: 0,
    failures: 0,
  };

  for (const file of files) {
    progress.filesConsidered++;

    const nodeId = coverTargetNode(db, file.recording_node_id);
    if (resolveCover(db, nodeId)) {
      progress.albumsSkipped++;
      onProgress?.(progress);
      continue;
    }

    try {
      const { picture } = await parseTags(file.file_path);
      const source = await attachCoverForFile(
        db,
        { id: file.id, path: file.file_path, recordingNodeId: file.recording_node_id },
        picture,
      );
      if (source) progress.coversAdded++;
    } catch (err) {
      progress.failures++;
      console.warn(
        `cover backfill failed for ${file.file_path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    onProgress?.(progress);
  }

  return progress;
}
