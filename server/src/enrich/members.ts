import type { Database } from "../sqlite.js";
import type { MbArtistRelation } from "./mbClient.js";
import { withBound } from "./queue.js";

// Mirrors match/edges.ts's findOrCreateNode and credits.ts's
// findOrCreateCreditNode, scoped to 'artist' nodes — same case/whitespace-
// insensitive collapse, which is exactly what makes issue #61's example
// work: a "George Harrison" node created here from a Beatles member
// relation is the same node his own solo recordings later land on, if
// they're ever scanned into the library. Returns whether the node was
// created so the caller can cascade enrichment onto it — a member/group
// discovered this way starts with no MBID, no photo, and no member
// relations of its own looked up yet.
function findOrCreateArtistNode(db: Database, title: string): { id: number; created: boolean } {
  const existing = db
    .prepare("SELECT id FROM nodes WHERE type = 'artist' AND lower(trim(title)) = lower(trim(?))")
    .get(title) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as {
    id: number;
  };
  return { id: row.id, created: true };
}

// Canonical edge direction is member -> group ("member_of"), matching
// MusicBrainz's own entity0/entity1 fix for this relation type and the
// issue's own phrasing ("George Harrison... connects to the Beatles").
//
// One MB query per artist (worker.ts's processArtistMemberLookup) returns
// every "member of band" relation touching that artist from BOTH sides at
// once — a group's own page lists its members (direction: backward) and a
// member's own page lists the groups it belongs to (direction: forward) —
// so delete-then-reinsert here has to clear edges touching this node as
// either from_node or to_node, not just the outgoing half applyCredits
// clears for recordings. Re-running is still exactly as idempotent: the
// single fetch this node's job just made is the complete current truth for
// every member_of edge this node participates in, regardless of which side
// it's on.
//
// Returns the ids of artist nodes newly created while applying these
// relations, so the caller can enqueue their photo and description lookups
// rather than waiting for the next full recompute to notice them. Whether
// they get a member lookup of their own is the bound's call (#269,
// enrich/queue.ts), not this function's.
export function applyMemberRelations(
  db: Database,
  artistNodeId: number,
  relations: MbArtistRelation[],
): number[] {
  db.prepare(
    "DELETE FROM edges WHERE (from_node = ? OR to_node = ?) AND type = 'member_of' AND source = 'musicbrainz'",
  ).run(artistNodeId, artistNodeId);

  const insertEdge = db.prepare(
    "INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'member_of', 'musicbrainz')",
  );

  const newNodeIds: number[] = [];
  const seenPairs = new Set<string>();
  for (const relation of relations) {
    const { id: otherNodeId, created } = findOrCreateArtistNode(db, relation.name);
    if (otherNodeId === artistNodeId) continue; // guard against a self-relation in MB's data
    if (created) newNodeIds.push(otherNodeId);

    const fromNode = relation.direction === "backward" ? otherNodeId : artistNodeId;
    const toNode = relation.direction === "backward" ? artistNodeId : otherNodeId;

    // MusicBrainz can list the same membership twice across overlapping
    // relationship edits, the same real-world duplication applyCredits
    // already had to guard against for recording-level credits.
    const key = `${fromNode}-${toNode}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);

    insertEdge.run(fromNode, toNode);
  }

  return newNodeIds;
}

// Issue #269: until the bound in enrich/queue.ts, the member lookup crawled
// without limit. The Pi held 180,395 artist nodes, 239,539 member_of edges
// and about 541,000 done lookups for a library with 98 artists. This brings
// a database back inside the bound. index.ts runs it before the server
// listens, after the #273 merge, so the bound it reads already counts merged
// producers as library artists. Issue #321: once per database
// (pruneBeyondMemberBoundOnce, below).

type NodeReference = { table: string; column: string };

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// Every column that holds a node id, read from the schema's own foreign
// keys the way match/people.ts reads them, so a table a later migration adds
// is covered without anyone remembering to list it here.
function nodeReferences(db: Database): NodeReference[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const references: NodeReference[] = [];
  for (const { name } of tables) {
    const keys = db
      .prepare(`SELECT "table" AS target, "from" AS fromColumn, "to" AS toColumn FROM pragma_foreign_key_list(?)`)
      .all(name) as { target: string; fromColumn: string; toColumn: string | null }[];
    for (const key of keys) {
      if (key.target === "nodes" && (key.toColumn === null || key.toColumn === "id")) {
        references.push({ table: name, column: key.fromColumn });
      }
    }
  }
  return references;
}

// The rows enrichment and recompute derive for an artist, which go with it.
// The condition picks the derived rows out of a table that also holds
// things a person did. A reference from anywhere else (a favourite, a
// manual connection, a position the user dragged, a cover they chose, a
// playlist entry, or a table added after this was written) is user data,
// and keeps the artist wherever it sits.
const DERIVED_ROWS: Record<string, string> = {
  edges: "source != 'manual'",
  positions: "user_x IS NULL AND user_y IS NULL",
  cover_art: "source != 'manual'",
  field_provenance: "source != 'manual'",
  enrich_jobs: "1",
  descriptions: "1",
  artists: "1",
  node_similarity_features: "1",
  articles: "1",
};

// VACUUM rewrites the whole file, so it waits until at least this share of
// it is free pages: the Pi's first start after this frees nearly all of it,
// and a start that prunes a handful of artists isn't worth the rewrite.
const VACUUM_FREE_SHARE = 0.25;

// Issue #321: once a prune has committed, a settings row holds this, and
// later starts skip it. Reading the bound takes seconds on a large library
// (withBound in queue.ts), and nothing answers meanwhile, so it can't run on
// every start. A change to what the bound keeps bumps this, so every
// database is pruned once more.
export const PRUNE_VERSION = 1;
export const PRUNE_VERSION_SETTING = "memberBoundPruneVersion";

/** What a prune removed. `reclaimError` is set when the prune committed but
 *  the VACUUM after it failed. */
export type MemberBoundPrune = {
  artists: number;
  memberEdges: number;
  jobs: number;
  reclaimedBytes: number;
  reclaimError?: string;
};

function count(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function pragma(db: Database, name: string): number {
  return (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]!;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Deletes what the unbounded crawl left past the bound: member_of edges
 *  that no member-lookup artist is on, the member lookups of artists that
 *  no longer get one, and artist nodes outside the bound that carry no user
 *  data, with every row that references them. Records PRUNE_VERSION in the
 *  same transaction, then reclaims the space. */
export function pruneBeyondMemberBound(db: Database): MemberBoundPrune {
  const references = nodeReferences(db);
  const totals = () => ({
    artists: count(db, "SELECT COUNT(*) AS n FROM nodes WHERE type = 'artist'"),
    memberEdges: count(db, "SELECT COUNT(*) AS n FROM edges WHERE type = 'member_of'"),
    jobs: count(db, "SELECT COUNT(*) AS n FROM enrich_jobs"),
  });
  const before = totals();

  // Foreign keys are off for the transaction (the pragma can't change
  // inside one). Every column that references a node is cleared of the
  // pruned ids before they're deleted, so the check would find nothing, but
  // finding nothing means scanning each unindexed referencing column once
  // per deleted node: 11.7 s instead of 0.4 s for 180,000 nodes on a
  // synthetic copy of the Pi's database.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      withBound(db, () => {
        // The bounded crawl only writes member_of edges from the lookups of
        // member-lookup artists, so an edge with neither end among them was
        // found by a lookup that shouldn't have run. Removing these leaves
        // the bound itself unchanged: every edge it was read through touches
        // one.
        db.exec(
          `DELETE FROM edges WHERE type = 'member_of' AND source = 'musicbrainz'
             AND from_node NOT IN (SELECT id FROM temp.member_lookup_artists)
             AND to_node NOT IN (SELECT id FROM temp.member_lookup_artists)`,
        );
        // Those lookups' edges are gone, so a done job would wrongly stop the
        // lookup being queued if the artist comes inside the bound later.
        db.exec(
          `DELETE FROM enrich_jobs WHERE job_type = 'artist_member_lookup'
             AND node_id NOT IN (SELECT id FROM temp.member_lookup_artists)`,
        );

        db.exec("CREATE TEMP TABLE artists_past_bound (id INTEGER PRIMARY KEY)");
        db.exec(
          `INSERT INTO temp.artists_past_bound
           SELECT id FROM nodes WHERE type = 'artist' AND id NOT IN (SELECT id FROM temp.artists_in_bound)`,
        );
        // Each of these reads a whole table, so they're skipped when no one
        // is past the bound.
        if (count(db, "SELECT EXISTS (SELECT 1 FROM temp.artists_past_bound) AS n") === 1) {
          for (const { table, column } of references) {
            db.exec(
              `DELETE FROM temp.artists_past_bound WHERE id IN
                 (SELECT ${quote(column)} FROM ${quote(table)} WHERE NOT (${DERIVED_ROWS[table] ?? "0"}))`,
            );
          }
          for (const { table, column } of references) {
            db.exec(`DELETE FROM ${quote(table)} WHERE ${quote(column)} IN (SELECT id FROM temp.artists_past_bound)`);
          }
          db.exec("DELETE FROM nodes WHERE id IN (SELECT id FROM temp.artists_past_bound)");
        }
        db.exec("DROP TABLE temp.artists_past_bound");
      });
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(PRUNE_VERSION_SETTING, String(PRUNE_VERSION));
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  const after = totals();
  const pruned: MemberBoundPrune = {
    artists: before.artists - after.artists,
    memberEdges: before.memberEdges - after.memberEdges,
    jobs: before.jobs - after.jobs,
    reclaimedBytes: 0,
  };
  if (pruned.artists + pruned.memberEdges + pruned.jobs === 0) return pruned;

  // Outside the transaction: VACUUM can't run inside one. The copy from
  // before the prune is the backup openDb took to apply migration 0033. A
  // VACUUM that fails leaves the file as it was, pruned: SQLite reuses the
  // free pages for new rows, so the space isn't lost, only not returned.
  try {
    const pagesBefore = pragma(db, "page_count");
    if (pragma(db, "freelist_count") >= pagesBefore * VACUUM_FREE_SHARE) {
      db.exec("VACUUM");
      // In WAL mode the file only shrinks once the rewrite is checkpointed.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      pruned.reclaimedBytes = (pagesBefore - pragma(db, "page_count")) * pragma(db, "page_size");
    }
  } catch (err) {
    pruned.reclaimError = errorMessage(err);
  }
  return pruned;
}

/** Issue #321: index.ts's call, on every start before the server listens.
 *  Skips the prune, without reading the bound, once this database has had
 *  one at PRUNE_VERSION. Otherwise prunes, and logs what it did with its
 *  time, even when it found nothing, since that's once. A failed prune is
 *  logged, not thrown: nothing is marked, so the next start tries again,
 *  and a server carrying the old crawl still works. Returns what it pruned,
 *  or null if it skipped or failed.
 *
 *  Before listen, not after it on recompute's worker: there it would hold
 *  the write lock while the request loop and the enrichment poller write,
 *  its VACUUM would block every write for the whole rewrite, and it could
 *  land between a member lookup's writes. */
export function pruneBeyondMemberBoundOnce(
  db: Database,
  log: (level: "info" | "warn" | "error", message: string) => void,
): MemberBoundPrune | null {
  const marked = db.prepare("SELECT value FROM settings WHERE key = ?").get(PRUNE_VERSION_SETTING) as
    | { value: string }
    | undefined;
  if (marked?.value === String(PRUNE_VERSION)) return null;

  const started = performance.now();
  let pruned: MemberBoundPrune;
  try {
    pruned = pruneBeyondMemberBound(db);
  } catch (err) {
    log("error", `membership: couldn't prune past the membership bound: ${errorMessage(err)}`);
    return null;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (pruned.artists + pruned.memberEdges + pruned.jobs === 0) {
    log("info", `membership: nothing past the membership bound (checked once for this database, in ${seconds} s)`);
    return pruned;
  }
  const reclaimed =
    pruned.reclaimedBytes > 0 ? `, reclaimed ${(pruned.reclaimedBytes / 1024 / 1024).toFixed(1)} MB` : "";
  log(
    "info",
    `membership: removed ${pruned.artists} artist(s), ${pruned.memberEdges} member_of edge(s) and ` +
      `${pruned.jobs} enrichment job(s) past the membership bound${reclaimed} in ${seconds} s`,
  );
  if (pruned.reclaimError !== undefined) {
    log(
      "warn",
      `membership: the prune is done, but couldn't reclaim the space it freed: ${pruned.reclaimError}. ` +
        "SQLite reuses the free pages for new rows.",
    );
  }
  return pruned;
}
