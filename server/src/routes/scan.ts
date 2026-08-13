import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createScanJob, executeScan } from "../scan/scanner.js";
import { watchLibraryRoot } from "../scan/watcher.js";
import { broadcast } from "../ws.js";

type LibraryRootRow = { id: number; path: string; enabled: number };

function runInBackground(db: Database.Database, root: LibraryRootRow, jobId: number) {
  executeScan(db, jobId, root.id, root.path, (progress) => broadcast("scan:progress", progress))
    .then(() => {
      watchLibraryRoot(db, root.id, root.path);
      broadcast("scan:done", { jobId, libraryRootId: root.id });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      broadcast("scan:error", { jobId, libraryRootId: root.id, error: message });
    });
}

export function scanRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    // Fires the scan in the background and returns job ids immediately —
    // callers poll GET /scan-jobs/:id rather than blocking on the full walk.
    app.post<{ Body: { libraryRootId?: number } }>("/scan", async (request, reply) => {
      const roots = request.body?.libraryRootId
        ? (db
            .prepare("SELECT id, path, enabled FROM library_roots WHERE id = ?")
            .all(request.body.libraryRootId) as LibraryRootRow[])
        : (db
            .prepare("SELECT id, path, enabled FROM library_roots WHERE enabled = 1")
            .all() as LibraryRootRow[]);

      if (roots.length === 0) {
        reply.code(400);
        return { error: "no matching enabled library root" };
      }

      const jobIds = roots.map((root) => {
        const jobId = createScanJob(db, root.id);
        runInBackground(db, root, jobId);
        return jobId;
      });

      return { jobIds };
    });

    app.get("/scan-jobs", async () =>
      db.prepare("SELECT * FROM scan_jobs ORDER BY id DESC LIMIT 50").all(),
    );

    app.get<{ Params: { id: string } }>("/scan-jobs/:id", async (request, reply) => {
      const row = db.prepare("SELECT * FROM scan_jobs WHERE id = ?").get(request.params.id);
      if (!row) {
        reply.code(404);
        return { error: "not found" };
      }
      return row;
    });
  };
}

export { runInBackground as triggerBackgroundScan };
