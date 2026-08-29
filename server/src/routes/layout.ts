import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { recomputeAllLayouts } from "../layout/seed.js";

// Manual trigger — the combined graph's seeds recompute automatically at
// the end of every scan (see scan/scanner.ts), this is for dev/testing
// convenience.
export function layoutRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.post("/layout/recompute", async () => {
      recomputeAllLayouts(db);
      return { ok: true };
    });
  };
}
