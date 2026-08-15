import type Database from "better-sqlite3";
import { parseTags } from "./tags.js";

export type TagBackfillProgress = {
  filesConsidered: number;
  filesUpdated: number;
  failures: number;
};

// Migration 0011 added release_date/bpm/label/release_type/genre as real
// columns, but a normal re-scan can't populate them for a library that was
// scanned before those columns existed: scanFile() short-circuits on any
// file whose mtime/size are unchanged, which is every file in an
// already-scanned library — confirmed by running a real re-scan against
// the actual /mnt/music library and finding these four columns still NULL
// on all 338 files afterward, track_no/disc_no aside (those came from
// 0011's own SQL backfill of the existing tags_raw blob, not a re-scan).
// Same shape as cover/backfill.ts for exactly the same reason.
export async function backfillTagColumns(
  db: Database.Database,
  onProgress?: (progress: TagBackfillProgress) => void,
): Promise<TagBackfillProgress> {
  const files = db
    .prepare(
      `SELECT id, file_path
         FROM files
        WHERE missing_since IS NULL AND release_date IS NULL AND bpm IS NULL AND label IS NULL
              AND release_type IS NULL AND genre IS NULL
        ORDER BY id`,
    )
    .all() as { id: number; file_path: string }[];

  const progress: TagBackfillProgress = { filesConsidered: 0, filesUpdated: 0, failures: 0 };

  const update = db.prepare(
    `UPDATE files SET release_date = ?, bpm = ?, label = ?, release_type = ?, genre = ?, tags_raw = ? WHERE id = ?`,
  );

  for (const file of files) {
    progress.filesConsidered++;

    try {
      const { tags } = await parseTags(file.file_path);
      update.run(
        tags.releaseDate,
        tags.bpm,
        tags.label,
        tags.releaseType,
        tags.genre ? JSON.stringify(tags.genre) : null,
        JSON.stringify(tags),
        file.id,
      );
      progress.filesUpdated++;
    } catch (err) {
      progress.failures++;
      console.warn(
        `tag column backfill failed for ${file.file_path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    onProgress?.(progress);
  }

  return progress;
}
