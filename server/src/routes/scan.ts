import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import {
  createScanJob,
  executeScan,
  requestCancelScanJob,
  requestPauseScanJob,
  resumeScanJob,
  type ScanMode,
} from "../scan/scanner.js";
import { watchLibraryRoot } from "../scan/watcher.js";
import { broadcast } from "../ws.js";

type LibraryRootRow = { id: number; path: string; enabled: number };

// executeScan records its own failures on the job row rather than
// throwing — an unreachable library root (issue #192) is the one that
// matters, carrying the H9 message the client shows. Reported as an
// error, not 'done', and without starting the watcher on a root that
// isn't there.
function reportErroredScan(db: Database, root: LibraryRootRow, jobId: number) {
  const { error_message } = db.prepare("SELECT error_message FROM scan_jobs WHERE id = ?").get(jobId) as {
    error_message: string | null;
  };
  broadcast("scan:error", { jobId, libraryRootId: root.id, error: error_message ?? "scan failed" });
}

// executeScan (issue #123) no longer always runs to completion — it can
// also stop early because a pause or cancel was requested mid-run, in
// which case it returns normally rather than throwing. The three outcomes
// need three different broadcasts (and only 'done' should start
// watching), so the job's final status — persisted by executeScan itself —
// is what decides which one fires, not whether the promise resolved.
function runInBackground(db: Database, root: LibraryRootRow, jobId: number, mode: ScanMode) {
  executeScan(db, jobId, root.id, root.path, (progress) => broadcast("scan:progress", progress), mode)
    .then(() => {
      const { status } = db.prepare("SELECT status FROM scan_jobs WHERE id = ?").get(jobId) as { status: string };
      if (status === "paused") {
        broadcast("scan:paused", { jobId, libraryRootId: root.id });
      } else if (status === "canceled") {
        broadcast("scan:canceled", { jobId, libraryRootId: root.id });
      } else if (status === "error") {
        reportErroredScan(db, root, jobId);
      } else {
        watchLibraryRoot(db, root.id, root.path);
        broadcast("scan:done", { jobId, libraryRootId: root.id });
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      broadcast("scan:error", { jobId, libraryRootId: root.id, error: message });
    });
}

// Same three-way branch as runInBackground, for a resumed job — used by
// the /resume route below. Kept separate rather than folded into
// runInBackground since a resume already has its job row (no createScanJob
// call) and calls resumeScanJob, not executeScan, to get there.
function resumeInBackground(db: Database, root: LibraryRootRow, jobId: number) {
  resumeScanJob(db, jobId, (progress) => broadcast("scan:progress", progress))
    .then(() => {
      const { status } = db.prepare("SELECT status FROM scan_jobs WHERE id = ?").get(jobId) as { status: string };
      if (status === "paused") {
        broadcast("scan:paused", { jobId, libraryRootId: root.id });
      } else if (status === "canceled") {
        broadcast("scan:canceled", { jobId, libraryRootId: root.id });
      } else if (status === "error") {
        reportErroredScan(db, root, jobId);
      } else {
        watchLibraryRoot(db, root.id, root.path);
        broadcast("scan:done", { jobId, libraryRootId: root.id });
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      broadcast("scan:error", { jobId, libraryRootId: root.id, error: message });
    });
}

export function scanRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    // Fires the scan in the background and returns job ids immediately —
    // callers poll GET /scan-jobs/:id rather than blocking on the full walk.
    // mode defaults to 'full' (today's behavior, untouched); 'incremental'
    // (issue #28) only picks up files the DB has never seen — see
    // scan/scanner.ts's executeScan for what that does and doesn't touch.
    app.post<{ Body: { libraryRootId?: number; mode?: ScanMode } }>("/scan", async (request, reply) => {
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

      const mode: ScanMode = request.body?.mode === "incremental" ? "incremental" : "full";

      const jobIds = roots.map((root) => {
        const jobId = createScanJob(db, root.id, mode);
        runInBackground(db, root, jobId, mode);
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
      // Per-file problems (H9) — a corrupt file, a permissions error —
      // surface here rather than stopping the scan. Most recent first, same
      // as scan-jobs' own ordering, so "the last few things that went
      // wrong" is what a client sees without paging.
      const errors = db
        .prepare("SELECT file_path, stage, reason, created_at FROM scan_file_errors WHERE job_id = ? ORDER BY id DESC")
        .all(request.params.id);
      return { ...(row as object), errors };
    });

    // Pause stops the run after its current file and persists exactly
    // where it stopped (scan_jobs.stage/cursor) — survives a server
    // restart because that persisted checkpoint is all resume needs, not
    // any in-memory state.
    app.post<{ Params: { id: string } }>("/scan-jobs/:id/pause", async (request, reply) => {
      const jobId = Number(request.params.id);
      const result = requestPauseScanJob(db, jobId);
      if (!result.ok) {
        reply.code(409);
        return { error: result.error };
      }
      return { ok: true };
    });

    // Resume re-enters executeScan for a paused job, which picks up from
    // its persisted stage/cursor rather than re-walking or re-matching
    // anything already checkpointed.
    app.post<{ Params: { id: string } }>("/scan-jobs/:id/resume", async (request, reply) => {
      const jobId = Number(request.params.id);
      const job = db
        .prepare("SELECT status, library_root_id FROM scan_jobs WHERE id = ?")
        .get(jobId) as { status: string; library_root_id: number } | undefined;
      if (!job) {
        reply.code(404);
        return { error: "not found" };
      }
      if (job.status !== "paused") {
        reply.code(409);
        return { error: `cannot resume a job with status '${job.status}'` };
      }
      const root = db.prepare("SELECT id, path, enabled FROM library_roots WHERE id = ?").get(job.library_root_id) as
        | LibraryRootRow
        | undefined;
      if (!root) {
        reply.code(404);
        return { error: "library root not found" };
      }
      resumeInBackground(db, root, jobId);
      return { ok: true };
    });

    // Cancel keeps everything indexed so far (#123) — it only stops the run
    // and marks it canceled, never rolls back nodes/files already written.
    // A running job is signalled and finalizes itself; a paused job (no
    // live loop to signal) is finalized synchronously by
    // requestCancelScanJob itself — see its own comment.
    app.post<{ Params: { id: string } }>("/scan-jobs/:id/cancel", async (request, reply) => {
      const jobId = Number(request.params.id);
      const result = requestCancelScanJob(db, jobId);
      if (!result.ok) {
        reply.code(409);
        return { error: result.error };
      }
      if (result.finalizedNow) {
        const row = db.prepare("SELECT library_root_id FROM scan_jobs WHERE id = ?").get(jobId) as {
          library_root_id: number;
        };
        broadcast("scan:canceled", { jobId, libraryRootId: row.library_root_id });
      }
      return { ok: true };
    });
  };
}

export { runInBackground as triggerBackgroundScan };
