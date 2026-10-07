import type { Database } from "../sqlite.js";
import { computeClusteredSeeds, type ClusterInput, type Seed } from "./cluster.js";

export type { Seed };

function decadeOf(year: number | null): number | null {
  return year == null || Number.isNaN(year) ? null : Math.floor(year / 10) * 10;
}

// Music Map settings panel's "nodes > lock" toggle (settings key
// nodePositionsLocked, src/panels/MusicMapSettings.tsx) — a global sibling
// to the per-node lock a drag already gives you for free (user_x/user_y,
// once set, are never touched by anything in this file). Un-dragged nodes
// have no such protection: their seed position is free to drift on every
// rescan as the clustering inputs shift, which is what this flag stops.
function isPositionsLocked(db: Database): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'nodePositionsLocked'").get() as
    | { value: string }
    | undefined;
  return row?.value === "true";
}

// seed_version only bumps when the computed position actually differs — a
// no-op recompute (nothing about the underlying data changed) must leave
// the row byte-identical, not just numerically equal. granularity is
// hardcoded to 'tracks' — the only value anything writes or reads any more
// (positions.granularity's CHECK constraint, migration 0015, still allows
// the two retired values; not worth a migration to narrow it just for
// that).
//
// Locked (isPositionsLocked above): existing rows are left completely
// untouched (DO NOTHING) rather than DO UPDATE — a node that already has a
// seed position keeps exactly the one it has, whatever the newly computed
// value would have been. A node with no row yet still gets INSERTed, so a
// track added by a rescan while locked still gets a position and isn't
// silently dropped from the graph (routes/nodes.ts serves the node list by
// joining on this table).
function upsertSeeds(db: Database, seeds: Map<number, Seed>, locked: boolean): void {
  const upsert = db.prepare(
    locked
      ? `INSERT INTO positions (node_id, granularity, seed_x, seed_y, seed_version) VALUES (?, 'tracks', ?, ?, 1)
         ON CONFLICT(node_id, granularity) DO NOTHING`
      : `INSERT INTO positions (node_id, granularity, seed_x, seed_y, seed_version) VALUES (?, 'tracks', ?, ?, 1)
         ON CONFLICT(node_id, granularity) DO UPDATE SET
           seed_version = CASE
             WHEN positions.seed_x = excluded.seed_x AND positions.seed_y = excluded.seed_y
             THEN positions.seed_version ELSE positions.seed_version + 1
           END,
           seed_x = excluded.seed_x, seed_y = excluded.seed_y`,
  );
  const applyAll = db.transaction(() => {
    for (const [nodeId, seed] of seeds) upsert.run(nodeId, seed.x, seed.y);
  });
  applyAll();
}

// Recording, release, and artist nodes together — the one combined graph
// (the 2026-08-29 map rework replaced the three tab-switched granularities
// with live client-side physics). Recordings are positioned first by
// deterministic cell assignment (primary artist, falling back to label,
// falling back to unclustered) crossed with decade, then local force
// relaxation within each cell — unchanged from the old tracks-only layout.
// Releases and artists are then seeded at the centroid of their own
// recordings' positions (below). These are deliberately just *reasonable
// starting points* now, not the final layout: the client's live force
// simulation (src/canvas/Canvas.tsx) relaxes everything from here, so a
// rough centroid — or even several entities stacked on the same point,
// falling back below — is enough to avoid a big-bang unfurl from pure
// randomness on first paint, not something that has to be precise the way
// a permanent static layout would.
//
// #24: credit nodes (producers/engineers) join release/artist as a third
// centroid-seeded entity type below. Before this, 'credit' nodes existed in
// the DB (match/edges.ts and enrich/credits.ts both write them) but never
// got a position row at all, so routes/nodes.ts's `/nodes` — which serves
// the graph by joining on this table — never returned them: the data was
// real, the graph just had nowhere to put it.
export function recomputeTracksLayout(
  db: Database,
  options?: {
    // #46's "Rebuild map" (rebuildLayout below) is the only caller that ever
    // passes either of these — the normal post-scan path (recomputeAllLayouts)
    // takes neither default, matching this function's behavior before #46.
    jitterSeed?: number;
    // Rebuild is an explicit, one-shot "regenerate everything" action — it
    // must actually regenerate even while the "nodes > lock" setting is on,
    // unlike a routine rescan's recompute, which is exactly what that lock
    // exists to protect against.
    ignoreLock?: boolean;
  },
): void {
  const recordingRows = db
    .prepare(
      `SELECT n.id AS node_id,
              (SELECT CAST(y.title AS INTEGER) FROM edges e
                 JOIN nodes y ON y.id = e.to_node
                WHERE e.from_node = n.id AND e.type = 'released_in' LIMIT 1) AS year,
              (SELECT e.to_node FROM edges e
                WHERE e.from_node = n.id AND e.type = 'performed_by'
                ORDER BY e.id LIMIT 1) AS artist_id,
              (SELECT e.to_node FROM edges e
                WHERE e.from_node = n.id AND e.type = 'released_on' LIMIT 1) AS label_id
       FROM nodes n
       WHERE n.type = 'recording'
         AND EXISTS (SELECT 1 FROM files f WHERE f.recording_node_id = n.id)`,
    )
    .all() as { node_id: number; year: number | null; artist_id: number | null; label_id: number | null }[];

  const clusterInputs: ClusterInput[] = recordingRows.map((r) => ({
    nodeId: r.node_id,
    groupKey: r.artist_id ?? r.label_id,
    decade: decadeOf(r.year),
  }));
  const seeds = computeClusteredSeeds(clusterInputs, options?.jitterSeed ?? 0);

  const releaseSeeds = centroidSeeds(db, seeds, "SELECT node_id FROM albums", ["appears_on"]);
  const artistSeeds = centroidSeeds(db, seeds, "SELECT node_id FROM artists", ["performed_by"]);
  // #24: 'credit' nodes (producer/engineer people — server/src/match/edges.ts's
  // local-tag credits and server/src/enrich/credits.ts's MusicBrainz-relation
  // credits both write these) get seeded the same way, scoped to nodes
  // actually credited as a producer or engineer on some recording. Other
  // credit roles (mixer, mastering engineer, arranger, ...) also land on
  // 'credit' nodes via the same findOrCreateCreditNode, but are deliberately
  // left unpositioned here — #24 is scoped to producer/engineer nodes, not a
  // general "every kind of session credit" graph. The entitySql is derived
  // from the edges themselves, not a `SELECT id FROM nodes WHERE type =
  // 'credit'` universe (unlike releaseSeeds/artistSeeds above, which do have
  // a dedicated table naming every such entity) — there's no "credit"-scoped
  // catalogue table to enumerate against, and scoping to the edges directly
  // means a credit node with only e.g. a mixed_by edge never round-trips
  // through an upsert-then-immediately-deleted cycle below.
  //
  // Issue #273: a producer who also performs is one artist node now, and
  // keeps the artist seed above. Seeding it again here would move it to the
  // middle of the records it produced instead of the ones it made.
  const creditSeeds = centroidSeeds(
    db,
    seeds,
    `SELECT DISTINCT e.to_node AS node_id FROM edges e JOIN nodes n ON n.id = e.to_node AND n.type = 'credit'
      WHERE e.type IN ('produced_by', 'engineered_by')`,
    ["produced_by", "engineered_by"],
  );

  const locked = options?.ignoreLock ? false : isPositionsLocked(db);
  upsertSeeds(db, seeds, locked);
  upsertSeeds(db, releaseSeeds, locked);
  upsertSeeds(db, artistSeeds, locked);
  upsertSeeds(db, creditSeeds, locked);

  // Installs that ran a recompute before this combined layout existed still
  // have stale rows lying around (the old recording-only tracks layout, or
  // the old separate albums/artists granularities) — upsertSeeds only ever
  // inserts/updates the sets handed to it above, it never deletes what it
  // didn't write, so anything outside "a recording that still has a file,
  // a release, an artist, or a produced_by/engineered_by credit" would
  // otherwise linger forever — the last of those is also what retires a
  // credit node's position again once its last qualifying edge is gone
  // (a corrected tag, a re-match), the same way a deleted release/artist
  // entity already falls out of the first two UNION arms.
  db.prepare(
    `DELETE FROM positions WHERE granularity = 'tracks'
       AND node_id NOT IN (
         SELECT n.id FROM nodes n
          WHERE n.type = 'recording' AND EXISTS (SELECT 1 FROM files f WHERE f.recording_node_id = n.id)
         UNION SELECT node_id FROM albums
         UNION SELECT node_id FROM artists
         UNION SELECT DISTINCT to_node FROM edges WHERE type IN ('produced_by', 'engineered_by')
       )`,
  ).run();
}

// An entity's initial seed in the combined graph: the centroid of whichever
// of its own recordings already have a seed position (a release via its
// recordings' appears_on edges, an artist via their performed_by edges, a
// credit node via the recordings that credit it produced_by/engineered_by —
// recording is always the edge's from_node side in every case). An entity
// with no such recordings yet (freshly matched, nothing scanned under it)
// falls back to the origin rather than being left out — still gets *a*
// position so it isn't silently dropped from the graph (routes/nodes.ts
// selects the canvas by position row), the same "still gets a position,
// isn't silently dropped" reasoning upsertSeeds' locked branch already
// applies one level down.
//
// edgeTypes is plural (#24) — a credit node can be reached by either
// produced_by or engineered_by, both counting toward the same centroid,
// unlike release/artist which each have exactly one qualifying edge type.
function centroidSeeds(
  db: Database,
  recordingSeeds: Map<number, Seed>,
  entitySql: string,
  edgeTypes: string[],
): Map<number, Seed> {
  const entityIds = (db.prepare(entitySql).all() as { node_id: number }[]).map((r) => r.node_id);
  const edgeRows = db
    .prepare(
      `SELECT from_node AS recordingNodeId, to_node AS entityNodeId FROM edges
        WHERE type IN (${edgeTypes.map(() => "?").join(",")})`,
    )
    .all(...edgeTypes) as { recordingNodeId: number; entityNodeId: number }[];

  const sums = new Map<number, { x: number; y: number; count: number }>();
  for (const { recordingNodeId, entityNodeId } of edgeRows) {
    const seed = recordingSeeds.get(recordingNodeId);
    if (!seed) continue;
    const acc = sums.get(entityNodeId);
    if (acc) {
      acc.x += seed.x;
      acc.y += seed.y;
      acc.count += 1;
    } else {
      sums.set(entityNodeId, { x: seed.x, y: seed.y, count: 1 });
    }
  }

  const result = new Map<number, Seed>();
  for (const entityNodeId of entityIds) {
    const acc = sums.get(entityNodeId);
    result.set(entityNodeId, acc ? { x: acc.x / acc.count, y: acc.y / acc.count } : { x: 0, y: 0 });
  }
  return result;
}

// user_x/user_y and settled_x/settled_y are never touched by this — only
// the client writes them (PATCH /nodes/:id/position and PUT /layout/settled),
// and only rebuildLayout below clears them. So a scan moves no node the map
// has already placed (#274); a new node gets a seed, which the client only
// uses when it has no placed neighbour to start beside.
export function recomputeAllLayouts(db: Database): void {
  recomputeTracksLayout(db);
}

// #46's "Rebuild map" (settings panel "canvas" group) — regenerates the
// whole graph's layout in place, without touching the library on disk or
// re-scanning it. Two things a routine recompute deliberately never does:
//
// 1. Clears every node's user_x/user_y first, and its settled_x/settled_y
//    (#274), the spot the map last came to rest at. The client reads both
//    ahead of the seed, so a rebuild that left either would reopen on the
//    old layout. A dragged node's placement
//    used to be a permanent physics pin (`.fx`/`.fy`, never released — see
//    Canvas.tsx's drag handling); #46 changed that so a drop
//    is now just a starting position a node is free to drift from
//    afterward, same as a server seed. That means a manually-placed node's
//    user_x/user_y row is the only thing left "stuck" from before a
//    rebuild — clearing it here is what actually frees it, not the physics
//    change alone (recomputeTracksLayout never touches user_x/user_y, by
//    design, so it wouldn't clear these on its own).
// 2. Passes a fresh random jitterSeed and ignoreLock:true. computeSeeds is
//    otherwise fully deterministic from node id/artist/decade — calling it
//    again with no jitter would recompute the exact same positions
//    (byte-identical, per upsertSeeds' own no-op guarantee), which would
//    make a "rebuild" button that runs but visibly does nothing to any
//    node that was never dragged. The random seed only perturbs each
//    node's placement *within* its (artist, decade) cell — which cell a
//    node lands in is still real data, not shuffled.
//
// The client-side effect of the DB changes this makes still needs a full
// Canvas remount to actually show (App.tsx does this on the ws
// "layout:rebuilt" broadcast this triggers, see routes/layout.ts) — a
// plain refetch deliberately never moves an already-tracked node's x/y
// (Canvas.tsx's syncGraph), which is right for every other kind of data
// refresh but wrong for this one.
export function rebuildLayout(db: Database): void {
  db.prepare(
    `UPDATE positions SET user_x = NULL, user_y = NULL, settled_x = NULL, settled_y = NULL
      WHERE granularity = 'tracks'`,
  ).run();
  const jitterSeed = Math.floor(Math.random() * 0xffffffff);
  recomputeTracksLayout(db, { jitterSeed, ignoreLock: true });
}
