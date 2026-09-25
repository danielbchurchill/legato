import { openDb } from "../db.js";
import { backfillFuzzyIndex } from "./backfill-fuzzy-index.js";

// One-off entry point: `npm --prefix server run backfill:fuzzy-index`.
//
// Only needed for a library scanned before migration 0028 landed — see
// backfill-fuzzy-index.ts and 0028_fuzzy_match_index.sql for why a plain
// re-scan doesn't reach already-unchanged files.
const db = openDb();

const count = backfillFuzzyIndex(db);

console.log(`populated normalized fuzzy-match columns for ${count} files`);

db.close();
