import { existsSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { countLibraryRootContents, removeLibraryRootCascade } from "../library-roots.js";
import { recompute } from "../recompute.js";
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

    // Removing a root has to take everything hanging off it with it, in
    // foreign-key order. The original one-line DELETE could never succeed:
    // POST /library-roots creates a scan job the moment a root is added, and
    // scan_jobs.library_root_id is NOT NULL with no cascade, so every root
    // that had ever existed failed with SQLITE_CONSTRAINT_FOREIGNKEY and a
    // 500. files.library_root_id is the same shape, and files in turn carry
    // plays, tag_writes and merge_overrides. (cover_art is the one that
    // handles itself, via ON DELETE SET NULL.)
    //
    // Refuses by default when the root still holds files, because one of
    // those tables is the play history and no amount of re-scanning brings
    // it back. force=true is the caller saying so out loud; the 409 body
    // names what would be destroyed so the answer can be an informed one.
    app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
      "/library-roots/:id",
      async (request, reply) => {
        const id = Number(request.params.id);
        const root = db.prepare("SELECT id FROM library_roots WHERE id = ?").get(id);
        if (!root) {
          reply.code(404);
          return { error: "not found" };
        }

        const counts = countLibraryRootContents(db, id);

        if (counts.files > 0 && request.query.force !== "true") {
          reply.code(409);
          return {
            error: "library root still has files",
            ...counts,
            hint: "repeat with ?force=true to remove the root and everything derived from it",
          };
        }

        removeLibraryRootCascade(db, id);

        unwatchLibraryRoot(id);
        // Entity rows, positions and collaboration edges all outlive the
        // files they were derived from unless something recomputes — which
        // is exactly what leaves removed music sitting on the canvas.
        recompute(db);
        broadcast("scan:done", { jobId: null, libraryRootId: id });
        reply.code(204);
      },
    );
  };
}
