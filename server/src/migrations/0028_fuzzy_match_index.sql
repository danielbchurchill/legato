-- Issue #173: tryFuzzyMatch (match/collapse.ts) used to select every
-- still-unmatched, MBID-less file and normalize+compare its tags_raw in
-- JavaScript, once per candidate, on every call — an unindexed scan over a
-- set that only grows as a scan progresses. #123's 100k-file benchmark
-- (PR #171) measured the match stage alone at ~3.57h, a near-perfect n²
-- fit against a 20k-file re-run.
--
-- normalized_title/normalized_artist store the exact same
-- normalizeForFuzzyMatch() output tryFuzzyMatch already computed inline,
-- just persisted once per file instead of recomputed per comparison. The
-- partial index lets the fuzzy lookup become a single indexed equality
-- query instead of a table scan: it only covers rows still eligible as a
-- fuzzy candidate (files.match_source IN ('unmatched', 'fuzzy_pending')),
-- which is also the set tryFuzzyMatch's WHERE clause already restricts to,
-- so the index stays small relative to a fully-matched library.
--
-- No backfill here — a plain SQL migration can't run the JS
-- normalization (NFKD + accent stripping has no SQLite equivalent without
-- a registered ICU extension, and bun:sqlite doesn't expose custom
-- function registration; see server/src/sqlite.ts). collapseFile() writes
-- both columns itself the next time a file reaches tier 3 (tryFuzzyMatch),
-- so any file re-scanned (or scanned fresh) after this migration is
-- self-healing. A library upgraded in place, whose files won't naturally
-- get re-scanned (unchanged mtime/size short-circuits scanFile()), needs
-- `npm --prefix server run backfill:fuzzy-index` once — the same shape as
-- 0011_tag_columns.sql's backfill:tags and backfill:edges before it.
ALTER TABLE files ADD COLUMN normalized_title TEXT;
ALTER TABLE files ADD COLUMN normalized_artist TEXT;

CREATE INDEX files_fuzzy_match_idx ON files (normalized_title, normalized_artist)
  WHERE match_source IN ('unmatched', 'fuzzy_pending');
