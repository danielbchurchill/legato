import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { recomputeAllSeeds } from "../layout/seed.js";

// Manual trigger — normally seeds recompute automatically at the end of
// every scan (see scan/scanner.ts), this is for dev/testing convenience.
export function layoutRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.post("/layout/recompute", async () => {
      recomputeAllSeeds(db);
      return { ok: true };
    });
  };
}
