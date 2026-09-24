import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { recomputeAllLayouts, rebuildLayout } from "../layout/seed.js";
import { broadcast } from "../ws.js";

export function layoutRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    // Manual trigger — the combined graph's seeds recompute automatically at
    // the end of every scan (see scan/scanner.ts), this is for dev/testing
    // convenience.
    app.post("/layout/recompute", async () => {
      recomputeAllLayouts(db);
      return { ok: true };
    });

    // #46 — "rebuild map" in the settings panel's "canvas" group. Unlike the
    // dev-only endpoint above, this is a real, user-facing, destructive
    // action: see rebuildLayout's own comment for what makes it different
    // from a routine recompute. The broadcast is what tells any open Canvas
    // to remount and pick the new positions up live (App.tsx) — plain
    // refetch never moves an already-tracked node.
    app.post("/layout/rebuild", async () => {
      rebuildLayout(db);
      broadcast("layout:rebuilt", {});
      return { ok: true };
    });
  };
}
