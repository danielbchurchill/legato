import { openDb } from "../db.js";
import { recomputeCollaborationEdges } from "../entities/collaboration.js";
import { recomputeEntities } from "../entities/aggregate.js";
import { recomputeAllLayouts } from "../layout/seed.js";
import { backfillLocalEdges } from "./backfill-edges.js";

// One-off entry point: `npm --prefix server run backfill:edges`.
//
// Re-derives every file's local edges, then recomputes everything
// downstream of them (entity aggregates, collaboration edges, all three
// layouts) — the same order scan/scanner.ts uses after a real scan.
const db = openDb();

const count = backfillLocalEdges(db);
recomputeEntities(db);
recomputeCollaborationEdges(db);
recomputeAllLayouts(db);

console.log(`re-derived local edges for ${count} files; recomputed entities, collaboration edges, and all layouts`);

db.close();
