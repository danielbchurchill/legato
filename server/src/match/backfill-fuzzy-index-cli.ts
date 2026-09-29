import { openDb } from "../db.js";
import { backfillFuzzyIndex } from "./backfill-fuzzy-index.js";

// Manual entry point: `npm --prefix server run backfill:fuzzy-index`.
//
// index.ts already runs this same backfill automatically on every server
// start, so this script isn't required for a normal deployment — it's
// here for a long-running server you'd rather not restart, or for
// scripting/ops use. See backfill-fuzzy-index.ts and
// 0028_fuzzy_match_index.sql for why the backfill exists at all.
const db = openDb();

const count = backfillFuzzyIndex(db);

console.log(`populated normalized fuzzy-match columns for ${count} files`);

db.close();
