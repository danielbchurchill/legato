import type Database from "better-sqlite3";
import { parseTags } from "./tags.js";

export type TagBackfillProgress = {
  filesConsidered: number;
  filesUpdated: number;
  failures: number;
};

// Re-parses every file and refreshes both its tag columns and tags_raw
// from what's actually on disk — the general fix for a structural gap:
// scanFile() short-circuits on any file whose mtime/size are unchanged,
// which is every file in an already-scanned library, so normalizeTags
// (scan/tags.ts) growing a new field is otherwise invisible to a library
// that was scanned before that field existed. Confirmed twice on the real
// /mnt/music library — once when migration 0011 added release_date/bpm/
// label/release_type/genre, again in session 4 when producer/engineer/
// featuredArtists were added and this tool's own earlier skip-if-populated
// check (based only on the four session-3 columns) meant a second run
// silently did nothing, even though real files had producer tags waiting
// to be picked up. No skip check now, for exactly that reason: this is a
// manual maintenance tool run occasionally, not a hot path, and correctness
// under a growing tag vocabulary matters more than avoiding a few seconds
// of re-parsing an already-current library.
export async function backfillTagColumns(
  db: Database.Database,
  onProgress?: (progress: TagBackfillProgress) => void,
): Promise<TagBackfillProgress> {
  const files = db.prepare("SELECT id, file_path FROM files WHERE missing_since IS NULL ORDER BY id").all() as {
    id: number;
    file_path: string;
  }[];

  const progress: TagBackfillProgress = { filesConsidered: 0, filesUpdated: 0, failures: 0 };

  const update = db.prepare(
    `UPDATE files SET
       track_no = ?, disc_no = ?, release_date = ?, bpm = ?, label = ?, release_type = ?, genre = ?, tags_raw = ?
     WHERE id = ?`,
  );

  for (const file of files) {
    progress.filesConsidered++;

    try {
      const { tags } = await parseTags(file.file_path);
      update.run(
        tags.trackNo,
        tags.discNo,
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
