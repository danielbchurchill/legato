import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { runDueJobs } from "../enrich/worker.js";

export function enrichRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/enrich-jobs", async () =>
      db.prepare("SELECT * FROM enrich_jobs ORDER BY id DESC LIMIT 100").all(),
    );

    app.get<{ Params: { id: string } }>("/enrich-jobs/:id", async (request, reply) => {
      const row = db.prepare("SELECT * FROM enrich_jobs WHERE id = ?").get(request.params.id);
      if (!row) {
        reply.code(404);
        return { error: "not found" };
      }
      return row;
    });

    // Manual nudge — the background poller (index.ts) already drains due
    // jobs on its own interval; this is for tests/dev convenience when
    // waiting for the next tick would be slower than useful.
    app.post("/enrich/run", async () => {
      void runDueJobs(db);
      return { ok: true };
    });
  };
}
