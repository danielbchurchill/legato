-- field_provenance's original columns (value/source/confidence) have
-- nowhere to record *why* a lookup came up empty — a sanity-check failure,
-- a wide tie, and a genuine no-match all need different fixes, so the
-- distinction matters for a future hygiene view (M8), not just a
-- confidence=0 blob.
ALTER TABLE field_provenance ADD COLUMN note TEXT;
