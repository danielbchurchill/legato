import { existsSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createScanJob, executeScan } from "../scan/scanner.js";
import { unwatchLibraryRoot, watchLibraryRoot } from "../scan/watcher.js";
import { broadcast } from "../ws.js";

type LibraryRoot = {
  id: number;
  path: string;
  label: string | null;
  enabled: number;
  added_at: string;
};

export function libraryRootsRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/library-roots", async () =>
      db.prepare("SELECT * FROM library_roots ORDER BY id").all() as LibraryRoot[],
    );

    app.post<{ Body: { path: string; label?: string } }>(
      "/library-roots",
      async (request, reply) => {
        const { path: rootPath, label } = request.body;
        if (!rootPath || !existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
          reply.code(400);
          return { error: "path must be an existing directory" };
        }
        const row = db
          .prepare(
            `INSERT INTO library_roots (path, label) VALUES (?, ?)
             ON CONFLICT(path) DO UPDATE SET label = excluded.label
             RETURNING *`,
          )
          .get(rootPath, label ?? null) as LibraryRoot;

        // A newly configured library should be usable the first time it's
        // added, not after a separate manual "now scan it" step — so the
        // initial scan kicks off automatically, in the background. The
        // response returns as soon as the row exists; the client polls
        // GET /scan-jobs or listens on /ws for progress.
        const jobId = createScanJob(db, row.id);
        executeScan(db, jobId, row.id, row.path, (progress) => broadcast("scan:progress", progress))
          .then(() => {
            watchLibraryRoot(db, row.id, row.path);
            broadcast("scan:done", { jobId, libraryRootId: row.id });
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            broadcast("scan:error", { jobId, libraryRootId: row.id, error: message });
          });

        return row;
      },
    );

    app.delete<{ Params: { id: string } }>("/library-roots/:id", async (request, reply) => {
      const result = db
        .prepare("DELETE FROM library_roots WHERE id = ?")
        .run(request.params.id);
      if (result.changes === 0) {
        reply.code(404);
        return { error: "not found" };
      }
      unwatchLibraryRoot(Number(request.params.id));
      reply.code(204);
    });
  };
}
