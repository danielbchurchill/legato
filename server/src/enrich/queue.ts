import type { Database } from "../sqlite.js";

// Auto-queues on scan, gated by one global switch — no per-node consent
// prompts. Missing the setting entirely means enabled: a new library
// should start enriching itself the first time it's scanned, not wait for
// an explicit opt-in: turning on enrichment is the one consent, given once
// for the whole library.
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
// (enrich/members.ts). Called on recompute for every artist inside
// MEMBER_LOOKUP_ARTISTS_SQL below, and from processArtistMemberLookup for
// the members and groups a performer's lookup just found, so they're looked
// up in the same drain rather than at the next scan.
export function enqueueArtistMemberLookupIfNeeded(db: Database, artistNodeId: number): void {
  enqueueOnce(db, artistNodeId, "artist_member_lookup");
}

// Issue #269: the member lookup is a crawl. Each artist it looks up can add
// artists whose own lookups add more, and with nothing to stop it, it walked
// 180,396 artists out from a library of 26. The two sets below are its
// bound. They're read from the graph whenever they're checked, never stored
// on a node when it's created, so a rescan, a merge (match/people.ts) or an
// artist leaving the library moves the bound with it. Both are SQL selecting
// artist node ids, so recompute.ts, the worker and the startup prune
// (members.ts) all ask the same question.
//
// Joins rather than IN (…): SQLite flattens them, so a check for one artist
// (`WHERE id = ?`) reads that artist's own edges instead of building the
// whole set first. A caller that reads a whole set uses withBound below.

// The crawl's starting points: artists a recording names as its performer.
// A producer, engineer or mixer is in the library too (#280), but doesn't
// start a crawl.
const PERFORMERS = `SELECT p.to_node AS id FROM edges p JOIN nodes r ON r.id = p.from_node
  WHERE r.type = 'recording' AND p.type IN ('performed_by', 'featured_artist')`;

// Artists with an edge of any type from a recording, performers included.
const LIBRARY_ARTISTS = `SELECT l.to_node AS id FROM edges l JOIN nodes r ON r.id = l.from_node
  JOIN nodes a ON a.id = l.to_node WHERE r.type = 'recording' AND a.type = 'artist'`;

// Artists one member_of edge away from `ids`, in either direction.
function memberHop(ids: string): string {
  return `SELECT m.to_node AS id FROM edges m JOIN (${ids}) s ON s.id = m.from_node WHERE m.type = 'member_of'
    UNION SELECT m.from_node FROM edges m JOIN (${ids}) s ON s.id = m.to_node WHERE m.type = 'member_of'`;
}

/** Artists a member lookup runs for: the performers, and their direct
 *  members and groups. With The Beatles in the library, that's The Beatles
 *  and George Harrison, whose lookup is what finds the Traveling Wilburys. */
const memberLookupArtistsFrom = (performers: string) => `${performers} UNION ${memberHop(performers)}`;
export const MEMBER_LOOKUP_ARTISTS_SQL = memberLookupArtistsFrom(PERFORMERS);

/** Every artist inside the bound, which is who gets a photo and a
 *  description: the library's artists, the member-lookup artists above, and
 *  the artists their lookups found (the Wilburys). Nothing past that is
 *  created, so nothing past it is queued. */
const artistsInBoundFrom = (memberLookupArtists: string) =>
  `${LIBRARY_ARTISTS} UNION ${memberLookupArtists} UNION ${memberHop(memberLookupArtists)}`;

export function isMemberLookupArtist(db: Database, artistNodeId: number): boolean {
  return db.prepare(`SELECT 1 FROM (${MEMBER_LOOKUP_ARTISTS_SQL}) WHERE id = ?`).get(artistNodeId) !== undefined;
}

const BOUND_TABLES = ["performers", "member_lookup_artists", "artists_in_bound"];

/** Issue #321: the statements withBound reads the bound with, in order.
 *  Written out in full, the two sets read the performers twelve times
 *  between them, and each read walks every recording's edges. Here the
 *  performers are read once, and each set is built from the one before it. */
export const BOUND_SQL: readonly string[] = [
  `INSERT OR IGNORE INTO temp.performers SELECT id FROM (${PERFORMERS})`,
  `INSERT INTO temp.member_lookup_artists
   SELECT id FROM (${memberLookupArtistsFrom("SELECT id FROM temp.performers")})`,
  `INSERT INTO temp.artists_in_bound
   SELECT id FROM (${artistsInBoundFrom("SELECT id FROM temp.member_lookup_artists")})`,
];

// The connections inside withBound now. A nested call would find the
// caller's tables already there, and its cleanup would drop them.
const readingBound = new WeakSet<Database>();

/** Issue #321: reads the whole bound into temp.member_lookup_artists and
 *  temp.artists_in_bound, runs `fn`, and drops them. At 30,000 albums,
 *  reading it this way took the startup prune from 14 s to 3.7 s, and
 *  recompute's enqueue from 11.6 s to 2.5 s.
 *
 *  The three statements read one snapshot (readTransaction), so a write
 *  committed between them can't leave the sets disagreeing. Outside a
 *  transaction, which is the enqueue on recompute's Worker, that takes no
 *  write lock: a temp table is this connection's own. Inside one, which is
 *  the startup prune, it's a savepoint.
 *
 *  Not nestable: `fn` already has the tables, so a call from inside it
 *  throws before touching them. */
export function withBound<T>(db: Database, fn: () => T): T {
  if (readingBound.has(db)) {
    throw new Error("withBound: already reading the bound on this connection; read its temp tables instead of nesting");
  }
  readingBound.add(db);
  let result: T;
  try {
    // Only a drop that failed below leaves one behind.
    for (const table of BOUND_TABLES) db.exec(`DROP TABLE IF EXISTS temp.${table}`);
    for (const table of BOUND_TABLES) db.exec(`CREATE TEMP TABLE ${table} (id INTEGER PRIMARY KEY)`);
    db.readTransaction(() => {
      for (const sql of BOUND_SQL) db.exec(sql);
    })();
    result = fn();
  } catch (error) {
    readingBound.delete(db);
    // A drop that fails here isn't reported: this error says what went wrong.
    dropBoundTables(db);
    throw error;
  }
  readingBound.delete(db);
  const dropFailure = dropBoundTables(db);
  if (dropFailure) throw dropFailure.error;
  return result;
}

// Each table on its own, so one that won't drop doesn't keep the others.
// Inside the prune's transaction, this runs before its commit or rollback.
function dropBoundTables(db: Database): { error: unknown } | undefined {
  let failure: { error: unknown } | undefined;
  for (const table of BOUND_TABLES) {
    try {
      db.exec(`DROP TABLE IF EXISTS temp.${table}`);
    } catch (error) {
      failure ??= { error };
    }
  }
  return failure;
}

// One INSERT … SELECT per job type, with enqueueOnce's rule as its NOT
// EXISTS: a node that has ever had a job of that type, in any status, gets
// no new one.
function insertOnce(db: Database, jobType: string, candidates: string): void {
  db.prepare(
    `INSERT INTO enrich_jobs (node_id, job_type, status)
     SELECT c.id, ?, 'queued' FROM (${candidates}) c
      WHERE NOT EXISTS (SELECT 1 FROM enrich_jobs ej WHERE ej.node_id = c.id AND ej.job_type = ?)
      ORDER BY c.id`,
  ).run(jobType, jobType);
}

/** Issue #281: every artist inside the bound gets a photo and a
 *  description lookup, every release a description lookup, and every
 *  member-lookup artist a member lookup, each queued once (enqueueOnce).
 *  recompute.ts calls this after every scan. It used to call the helpers
 *  above three times per node, 540,000 lookups on the Pi.
 *
 *  An INSERT … SELECT holds the write lock while its SELECT runs, and on a
 *  30,000-album library reading the bound takes seconds. So the bound is
 *  read first (withBound), and the three inserts read from its temp tables.
 *  CROSS JOIN keeps the temp table as the outer loop: it has no statistics,
 *  and SQLite otherwise checked every artist node in the database against
 *  it. */
export function enqueueLookupsInBound(db: Database): void {
  if (!isEnrichmentEnabled(db)) return;

  withBound(db, () => {
    insertOnce(
      db,
      "artist_image_lookup",
      "SELECT n.id FROM temp.artists_in_bound b CROSS JOIN nodes n ON n.id = b.id WHERE n.type = 'artist'",
    );
    // Issue #61: an artist's "member of band" relations, so a member or
    // group the cascade in worker.ts's processArtistMemberLookup never got
    // to still gets its lookup at the next scan. Issue #269: only the
    // performers and their direct members and groups, a subset of the bound.
    insertOnce(
      db,
      "artist_member_lookup",
      "SELECT n.id FROM temp.member_lookup_artists m CROSS JOIN nodes n ON n.id = m.id WHERE n.type = 'artist'",
    );
    insertOnce(
      db,
      "description_lookup",
      "SELECT id FROM nodes WHERE type = 'release' OR id IN (SELECT id FROM temp.artists_in_bound)",
    );
  });
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
