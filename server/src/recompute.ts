import type { Database } from "./sqlite.js";
import { deriveLocalEdges } from "./match/edges.js";
import {
  enqueueArtistImageLookupIfNeeded,
  enqueueArtistMemberLookupIfNeeded,
  enqueueDescriptionLookupIfNeeded,
  enqueueEnrichmentIfNeeded,
} from "./enrich/queue.js";
import { recomputeEntities } from "./entities/aggregate.js";
import { recomputeCollaborationEdges } from "./entities/collaboration.js";
import { recomputeAllLayouts } from "./layout/seed.js";
import { recomputeSimilarityFeatures } from "./similarity/similarity.js";
import { recomputeArticles } from "./articles/recompute.js";

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
export function recompute(db: Database): void {
  const files = db.prepare("SELECT id FROM files WHERE missing_since IS NULL").all() as { id: number }[];
  for (const { id } of files) {
    deriveLocalEdges(db, id);
  }

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
  for (const { id } of neverAttempted) {
    enqueueEnrichmentIfNeeded(db, id);
  }

  // Same order scanner.ts's executeScan already established: entities before
  // collaboration edges (collaboration reads albums.primary_artist_node_id),
  // both before layout (clustering uses the collaboration edges) and before
  // similarity (artist-cluster feature group) and articles (reads all of
  // the above).
  recomputeEntities(db);
  recomputeCollaborationEdges(db);
  recomputeAllLayouts(db);
  recomputeSimilarityFeatures(db);
  recomputeArticles(db);

  // Artist photos and encyclopedia descriptions — queued after
  // recomputeEntities, because artist and release nodes are what it creates.
  // Both helpers are one-shot per node (see enrich/queue.ts), so running this
  // on every recompute costs a pair of indexed lookups per node rather than a
  // network request.
  const enrichable = db
    .prepare("SELECT id, type FROM nodes WHERE type IN ('artist','release')")
    .all() as { id: number; type: string }[];
  for (const node of enrichable) {
    if (node.type === "artist") {
      enqueueArtistImageLookupIfNeeded(db, node.id);
      // Issue #61: an artist's "member of band" relations — every artist
      // node gets this queued the same one-shot way as the photo lookup
      // above, so a member/group node created mid-enrichment (see
      // worker.ts's processArtistMemberLookup) still gets its own lookup
      // the next time this runs, even on a machine where the cascade
      // inside that job never got to it directly.
      enqueueArtistMemberLookupIfNeeded(db, node.id);
    }
    enqueueDescriptionLookupIfNeeded(db, node.id);
  }
}
