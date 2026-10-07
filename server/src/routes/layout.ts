import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { recomputeAllLayouts, rebuildLayout } from "../layout/seed.js";
import { isSettledPositionList, saveSettledPositions } from "../layout/settled.js";
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

    // #274: where the map came to rest, saved once per settle by the client
    // (layout/settled.ts). Its own body limit: /nodes serves up to 20,000
    // nodes, and a first settle sends all of them at about 60 bytes each,
    // which would go past Fastify's 1 MiB default.
    app.put<{ Body: { positions?: unknown } }>(
      "/layout/settled",
      { bodyLimit: 4 * 1024 * 1024 },
      async (request, reply) => {
        const positions = request.body?.positions;
        if (!isSettledPositionList(positions)) {
          reply.code(400);
          return { error: "positions must be a list of { id, x, y } with finite numbers" };
        }
        return { saved: saveSettledPositions(db, positions) };
      },
    );
  };
}
