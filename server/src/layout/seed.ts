import type Database from "better-sqlite3";
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
function isPositionsLocked(db: Database.Database): boolean {
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
function upsertSeeds(db: Database.Database, seeds: Map<number, Seed>, locked: boolean): void {
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
// (2026-08-29: replaced the three tab-switched granularities with live
// client-side physics, see Legato.md). Recordings are positioned first by
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
export function recomputeTracksLayout(db: Database.Database): void {
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
  const seeds = computeClusteredSeeds(clusterInputs);

  const releaseSeeds = centroidSeeds(db, seeds, "SELECT node_id FROM albums", "appears_on");
  const artistSeeds = centroidSeeds(db, seeds, "SELECT node_id FROM artists", "performed_by");

  const locked = isPositionsLocked(db);
  upsertSeeds(db, seeds, locked);
  upsertSeeds(db, releaseSeeds, locked);
  upsertSeeds(db, artistSeeds, locked);

  // Installs that ran a recompute before this combined layout existed still
  // have stale rows lying around (the old recording-only tracks layout, or
  // the old separate albums/artists granularities) — upsertSeeds only ever
  // inserts/updates the sets handed to it above, it never deletes what it
  // didn't write, so anything outside "a recording that still has a file,
  // a release, or an artist" would otherwise linger forever.
  db.prepare(
    `DELETE FROM positions WHERE granularity = 'tracks'
       AND node_id NOT IN (
         SELECT n.id FROM nodes n
          WHERE n.type = 'recording' AND EXISTS (SELECT 1 FROM files f WHERE f.recording_node_id = n.id)
         UNION SELECT node_id FROM albums
         UNION SELECT node_id FROM artists
       )`,
  ).run();
}

// A release/artist entity's initial seed in the combined graph: the
// centroid of whichever of its own recordings already have a seed position
// (a release via its recordings' appears_on edges, an artist via their
// performed_by edges — recording is always the edge's from_node side for
// both). An entity with no such recordings yet (freshly matched, nothing
// scanned under it) falls back to the origin rather than being left out —
// still gets *a* position so it isn't silently dropped from the graph
// (routes/nodes.ts selects the canvas by position row), the same
// "still gets a position, isn't silently dropped" reasoning upsertSeeds'
// locked branch already applies one level down.
function centroidSeeds(
  db: Database.Database,
  recordingSeeds: Map<number, Seed>,
  entitySql: string,
  edgeType: "appears_on" | "performed_by",
): Map<number, Seed> {
  const entityIds = (db.prepare(entitySql).all() as { node_id: number }[]).map((r) => r.node_id);
  const edgeRows = db
    .prepare("SELECT from_node AS recordingNodeId, to_node AS entityNodeId FROM edges WHERE type = ?")
    .all(edgeType) as { recordingNodeId: number; entityNodeId: number }[];

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

// user_x/user_y are never touched by this — only a PATCH /nodes/:id/position
// request writes them.
export function recomputeAllLayouts(db: Database.Database): void {
  recomputeTracksLayout(db);
}
