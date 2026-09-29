import type { Database } from "../sqlite.js";
import { normalizeForFuzzyMatch, parseTagsRaw } from "./collapse.js";

// Populates normalized_title/normalized_artist (migration 0028) for every
// still-fuzzy-eligible file that doesn't have them yet — no file I/O,
// same shape as backfill-edges.ts, and for the same structural reason:
// tryFuzzyMatch only writes these columns from inside collapseFile()'s
// per-file path, which a normal re-scan never reaches for a file whose
// mtime/size haven't changed. index.ts already calls this once on every
// server start (cheap no-op once a library is caught up — the WHERE
// clause only matches rows still missing their normalized columns), so a
// library scanned before migration 0028 landed self-heals on its next
// boot without any manual step. The compiled-binary/Tauri-sidecar
// deployment (#102/#103) has no npm or server/ directory to run a CLI
// script from, which is why this can't be a manual-only fix. The CLI
// below is kept for a long-running server that shouldn't need a restart,
// or for scripting/ops convenience.
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
