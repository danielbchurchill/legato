import { describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { NODE_LOOKUP_SQL } from "./edges.js";

// Issue #189: findOrCreateNode runs this lookup several times per file in
// both the 'collapse' stage and recompute(). Without migration 0030's
// expression index it scans the whole nodes table every time, which is
// what made both stages grow with the square of the library.
describe("findOrCreateNode's title lookup", () => {
  it("is answered from migration 0030's expression index, not a table scan", () => {
    const db = openDb(":memory:");
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${NODE_LOOKUP_SQL}`).all("artist", "The Beatles") as { detail: string }[])
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toMatch(/^SEARCH nodes USING (COVERING )?INDEX nodes_type_title_lookup_idx/m);
    expect(plan).not.toMatch(/^SCAN nodes$/m);
  });
});
