import type { Database } from "../sqlite.js";

// Auto-queues on scan, gated by one global switch — no per-node consent
// prompts. Missing the setting entirely means enabled: a new library
// should start enriching itself the first time it's scanned, per
// Legato.md's consent model, not wait for an explicit opt-in.
export function isEnrichmentEnabled(db: Database): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'enrichmentEnabled'").get() as
    | { value: string }
    | undefined;
  return row?.value !== "false";
}

// Only nodes without a confident local mbid actually need a MusicBrainz
// lookup — tier 1 already resolved the rest (match/collapse.ts) without
// spending a rate-limited request. Skips enqueueing a duplicate if one is
// already queued/running for this node.
export function enqueueEnrichmentIfNeeded(db: Database, nodeId: number): void {
  if (!isEnrichmentEnabled(db)) return;

  const file = db.prepare("SELECT match_source FROM files WHERE recording_node_id = ? LIMIT 1").get(nodeId) as
    | { match_source: string }
    | undefined;
  if (file?.match_source === "mbid") return;

  const existing = db
    .prepare("SELECT id FROM enrich_jobs WHERE node_id = ? AND status IN ('queued','running')")
    .get(nodeId);
  if (existing) return;

  db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'recording_lookup', 'queued')").run(
    nodeId,
  );
}

// One job per node per type, ever, unless something deletes the row.
//
// Deliberately keyed on "has a job of this type ever existed" rather than "is
// one in flight", which is the opposite of enqueueEnrichmentIfNeeded's check
// above and the same policy recompute.ts applies to recording lookups: these
// run on every scan, and a node whose lookup came back empty would otherwise
// spend a rate-limited request re-learning that on every no-op re-scan. Asking
// again is a deliberate act (delete the job row, or the eventual refresh
// action in the maintenance view), not a side effect of pressing scan.
function enqueueOnce(db: Database, nodeId: number, jobType: string): void {
  if (!isEnrichmentEnabled(db)) return;

  const existing = db
    .prepare("SELECT id FROM enrich_jobs WHERE node_id = ? AND job_type = ?")
    .get(nodeId, jobType);
  if (existing) return;

  db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, ?, 'queued')").run(nodeId, jobType);
}

// A photograph of the artist (enrich/deezer.ts). Priority is left at the
// default, behind nothing and ahead of nothing: an artist photo is worth no
// more than a recording match, and the queue drains in id order anyway.
export function enqueueArtistImageLookupIfNeeded(db: Database, artistNodeId: number): void {
  enqueueOnce(db, artistNodeId, "artist_image_lookup");
}

// Prose about an artist or an album (enrich/wikipedia.ts). Recordings are
// excluded at the call site *and* in the worker — see processDescriptionLookup.
export function enqueueDescriptionLookupIfNeeded(db: Database, nodeId: number): void {
  enqueueOnce(db, nodeId, "description_lookup");
}

// Issue #61: this artist's "member of band" relations, in both directions
// (enrich/members.ts). Called for every artist node on recompute the same
// way the two helpers above are, and also called directly from inside
// processArtistMemberLookup for a node it just created — a member/group
// discovered mid-drain gets its own lookup queued immediately rather than
// waiting for the next scan's recompute pass to notice it exists.
export function enqueueArtistMemberLookupIfNeeded(db: Database, artistNodeId: number): void {
  enqueueOnce(db, artistNodeId, "artist_member_lookup");
}

// Queued once a 'recording_lookup' job resolves a real MusicBrainz mbid —
// only then does the release its recording belongs to have any MBID this
// server can hand to Cover Art Archive (enrich/coverArchive.ts). node_id
// here is the *release* node, not a recording — see 0014's migration note
// on enrich_jobs.node_id's job_type-dependent meaning.
export function enqueueCoverArtLookupIfNeeded(db: Database, releaseNodeId: number): void {
  const existing = db
    .prepare(
      "SELECT id FROM enrich_jobs WHERE node_id = ? AND job_type = 'cover_art_lookup' AND status IN ('queued','running')",
    )
    .get(releaseNodeId);
  if (existing) return;

  db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'cover_art_lookup', 'queued')").run(
    releaseNodeId,
  );
}
