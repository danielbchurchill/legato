import type { Database } from "../sqlite.js";
import { normalizeForFuzzyMatch, parseTagsRaw } from "./collapse.js";

// Populates normalized_title/normalized_artist (migration 0028) for every
// still-fuzzy-eligible file that doesn't have them yet — no file I/O,
// same shape as backfill-edges.ts, and for the same structural reason:
// tryFuzzyMatch only writes these columns from inside collapseFile()'s
// per-file path, which a normal re-scan never reaches for a file whose
// mtime/size haven't changed. A library scanned before this migration
// landed needs this run once so its existing unmatched/fuzzy_pending
// files become indexed fuzzy candidates immediately, rather than only as
// they're individually touched by a future rescan.
export function backfillFuzzyIndex(db: Database): number {
  const files = db
    .prepare(
      `SELECT id, tags_raw FROM files
       WHERE match_source IN ('unmatched', 'fuzzy_pending')
         AND normalized_title IS NULL
         AND normalized_artist IS NULL`,
    )
    .all() as { id: number; tags_raw: string | null }[];

  const update = db.prepare("UPDATE files SET normalized_title = ?, normalized_artist = ? WHERE id = ?");
  let updated = 0;
  for (const file of files) {
    const tags = parseTagsRaw(file.tags_raw);
    if (!tags?.title || !tags?.artist) continue;
    update.run(normalizeForFuzzyMatch(tags.title), normalizeForFuzzyMatch(tags.artist), file.id);
    updated++;
  }
  return updated;
}
