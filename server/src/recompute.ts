import type { Database } from "./sqlite.js";
import { deriveLocalEdges } from "./match/edges.js";
import { mergeDuplicatePeople } from "./match/people.js";
import { enqueueEnrichmentIfNeeded, enqueueLookupsInBound } from "./enrich/queue.js";
import { recomputeEntities } from "./entities/aggregate.js";
import { recomputeCollaborationEdges } from "./entities/collaboration.js";
import { recomputeAllLayouts } from "./layout/seed.js";
import { recomputeSimilarityFeatures } from "./similarity/similarity.js";
import { recomputeArticles } from "./articles/recompute.js";
import { writeInChunks } from "./writeInChunks.js";

// B-1: three sessions in a row hit the same bug shape and each got its own
// one-off backfill script — scanFile()'s unchanged-mtime/size short-circuit
// (scan/scanner.ts) is what makes an incremental re-scan cheap, but it also
// means anything computed only from inside that per-file path silently
// never runs again for a file that was already scanned before the logic
// existed. Scan answers "what files exist and what do their tags say" and
// keeps that short-circuit; this answers "given what's currently in the
// files table, what should be derived from it" and runs unconditionally,
// for every file currently in the library — not just the ones that
// changed this run. Meant to be the last one of these ever needed: the
// next derived field lands here, not in a fifth backfill script.
//
// Issue #281: callers run this through recomputeOffThread() below, never
// directly, so that the request loop keeps answering while it works.
export function recompute(db: Database): void {
  const files = db.prepare("SELECT id FROM files WHERE missing_since IS NULL").all() as { id: number }[];
  // Each file is its own transaction (match/edges.ts); a piece of them
  // commits together, rather than every statement on its own.
  writeInChunks(db, files, ({ id }) => deriveLocalEdges(db, id));

  // Issue #273: one node per person. New credits already land on the artist
  // (match/edges.ts's findOrCreatePerson); this catches an artist node the
  // membership crawl created for someone who was already a credit node.
  mergeDuplicatePeople(db);

  // Only recordings that have genuinely never had a lookup attempted —
  // enqueueEnrichmentIfNeeded's own queued/running check exists to stop a
  // duplicate of an in-flight job, not to gate a wholesale sweep, so
  // calling it unconditionally here for every recording on every recompute
  // would re-queue a fresh MusicBrainz request for every file that already
  // came back ambiguous or unmatched — hammering the API on every no-op
  // re-scan. Re-trying those is a deliberate, one-time action (Phase 3's
  // own "re-run and count" step, or M-5's candidate picker), not something
  // that should happen silently on every scan.
  const neverAttempted = db
    .prepare(
      `SELECT DISTINCT f.recording_node_id AS id
       FROM files f
       WHERE f.missing_since IS NULL
         AND f.match_source != 'mbid'
         AND NOT EXISTS (SELECT 1 FROM enrich_jobs ej WHERE ej.node_id = f.recording_node_id)`,
    )
    .all() as { id: number }[];
  // In pieces, like everything recompute writes: a first scan of a large
  // library queues a lookup for every recording (writeInChunks.ts).
  writeInChunks(db, neverAttempted, ({ id }) => enqueueEnrichmentIfNeeded(db, id));

  // Same order scanner.ts's executeScan already established: entities before
  // collaboration edges (collaboration reads albums.primary_artist_node_id)
  // and layout (it seeds releases and artists from the albums and artists
  // tables), collaboration edges before similarity (its artist-cluster
  // feature group reads them), and articles last (reads all of the above).
  recomputeEntities(db);
  recomputeCollaborationEdges(db);
  recomputeAllLayouts(db);
  recomputeSimilarityFeatures(db);
  recomputeArticles(db);

  // Artist photos, members and encyclopedia descriptions — queued after
  // recomputeEntities, because artist and release nodes are what it creates.
  // Each is one-shot per node (see enrich/queue.ts), so running this on
  // every recompute costs three statements rather than a network request.
  // Issue #269: only for artists inside the membership crawl's bound.
  enqueueLookupsInBound(db);
}

// Issue #281: recompute() is synchronous, as bun:sqlite is, and it used to
// run on the request loop: for four minutes on the Pi, with nothing
// answering, not /health and not a stream. It now runs on a Worker
// (recomputeWorker.ts) with a connection of its own. WAL lets the request
// loop go on reading while it works, and every write transaction it holds
// is short (writeInChunks.ts), so a write here waits a few milliseconds at
// most for one to finish (db.ts's BUSY_TIMEOUT_MS).
//
// The promise resolves once every write has been committed, so what a
// caller broadcasts after awaiting it (scan:done, enrich:applied) sends
// clients to refetch data that's already there.
//
// One runs at a time. A call made while one is running gets the run after
// it, shared with every other call made meanwhile: a recompute derives
// from what the database holds when it starts, so the one already running
// may have read too early for this caller, and one more run covers them all.
export type RecomputeRequest = { dbPath: string };
export type RecomputeResult = { ok: true } | { ok: false; message: string };

let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;

export function recomputeOffThread(db: Database): Promise<void> {
  if (queued) return queued;
  if (running) {
    queued = running
      .catch(() => {})
      .then(() => {
        queued = null;
        return recomputeOffThread(db);
      });
    return queued;
  }
  running = runRecompute(db).finally(() => {
    running = null;
  });
  return running;
}

function runRecompute(db: Database): Promise<void> {
  // An in-memory database, which is what the specs use, can't be opened a
  // second time, so it's recomputed here.
  if (db.filename === ":memory:" || db.filename === "") {
    try {
      recompute(db);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // A new Worker for each run, ended once it reports: the heap a large
  // library's recompute builds goes with it rather than staying resident.
  // The compiled binary finds it through scripts/compile.ts, which embeds
  // it at the place this URL points to inside the binary.
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./recomputeWorker.ts", import.meta.url).href);
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    worker.onmessage = (event: MessageEvent<RecomputeResult>) =>
      settle(event.data.ok ? undefined : new Error(event.data.message));
    worker.onerror = (event) => settle(new Error(`recompute worker failed: ${event.message}`));
    worker.addEventListener("close", () => settle(new Error("recompute worker exited before it finished")));
    worker.postMessage({ dbPath: db.filename } satisfies RecomputeRequest);
  });
}
