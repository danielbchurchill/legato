import type { Database } from "../sqlite.js";
import type { Seed } from "../layout/cluster.js";

// Issue #466: bridge members. George Harrison is in The Beatles and the
// Traveling Wilburys, and the reference library has both bands but none of
// his own records. He had no `artists` row, so no place on the map, so
// neither member_of edge was drawn and nothing showed the two bands share a
// member.
//
// A bridge member is an artist node with no tracks of its own that a
// member_of edge, in either direction, links to two or more artists that
// have tracks. That covers a person in two of your bands (Harrison) and a
// band none of your files are by whose members are two of your artists
// (the Wilburys, with only Dylan's and Petty's records). Linking two of your
// artists is the only way in: The Beatles list nine past members, and the
// ones who were only ever Beatles stay off the map.
//
// A bridge member gets an `artists` row with no tracks and no albums, which
// is what gives it a position (layout/seed.ts) and what marks it a bridge:
// every other row counts at least one track. Nothing that lists or counts
// artists with records reads that table. The Library's Artists tab, its
// header and GET /stats count albums' primary artists
// (routes/library.ts's LIBRARY_ARTISTS), and a bridge member has no album.
//
// Two places make bridge members: recomputeEntities (entities/aggregate.ts)
// after every scan, and refreshBridgeMembers below, after a band-membership
// lookup (enrich/members.ts) and once on every start (index.ts), so the
// edges a lookup finds are drawn without waiting for a scan.

export type MemberEdge = { fromNode: number; toNode: number };

/** member_of edges between two artist nodes. */
export const MEMBER_EDGES_SQL = `SELECT e.from_node AS fromNode, e.to_node AS toNode FROM edges e
  JOIN nodes m ON m.id = e.from_node AND m.type = 'artist'
  JOIN nodes g ON g.id = e.to_node AND g.type = 'artist'
  WHERE e.type = 'member_of'`;

/** The bridge members among the ends of `memberEdges`, each with the
 *  artists on the map it links, lowest id first. `onMap` is every artist
 *  with tracks of its own; none of them is a bridge. */
export function findBridgeMembers(memberEdges: readonly MemberEdge[], onMap: ReadonlySet<number>): Map<number, number[]> {
  const linked = new Map<number, Set<number>>();
  const link = (node: number, other: number) => {
    if (node === other || onMap.has(node) || !onMap.has(other)) return;
    let others = linked.get(node);
    if (!others) linked.set(node, (others = new Set()));
    others.add(other);
  };
  for (const edge of memberEdges) {
    link(edge.fromNode, edge.toNode);
    link(edge.toNode, edge.fromNode);
  }

  const bridges = new Map<number, number[]>();
  for (const [node, others] of linked) {
    if (others.size >= 2) bridges.set(node, [...others].sort((a, b) => a - b));
  }
  return bridges;
}

function centroid(points: readonly Seed[]): Seed {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

/** layout/seed.ts's seeds for the bridge members the last
 *  recomputeEntities found: the middle of the artists each one links, from
 *  `artistSeeds`, so Harrison starts between The Beatles and the Wilburys.
 *  The map's physics takes it from there. */
export function seedBridgeMembers(db: Database, artistSeeds: ReadonlyMap<number, Seed>): Map<number, Seed> {
  const bridgeIds = (db.prepare("SELECT node_id AS id FROM artists WHERE track_count = 0").all() as { id: number }[]).map(
    (r) => r.id,
  );
  const seeds = new Map<number, Seed>();
  if (bridgeIds.length === 0) return seeds;

  const bridges = findBridgeMembers(db.prepare(MEMBER_EDGES_SQL).all() as MemberEdge[], new Set(artistSeeds.keys()));
  for (const id of bridgeIds) {
    const linked = (bridges.get(id) ?? []).map((other) => artistSeeds.get(other)!);
    seeds.set(id, centroid(linked));
  }
  return seeds;
}

// The member_of edges that touch any of `ids`, between two artist nodes.
function memberEdgesTouching(db: Database, ids: Iterable<number>): MemberEdge[] {
  const touching = db.prepare(
    `${MEMBER_EDGES_SQL} AND e.from_node = ?
     UNION ${MEMBER_EDGES_SQL} AND e.to_node = ?`,
  );
  const edges = new Map<string, MemberEdge>();
  for (const id of ids) {
    for (const edge of touching.all(id, id) as MemberEdge[]) edges.set(`${edge.fromNode}-${edge.toNode}`, edge);
  }
  return [...edges.values()];
}

/** What a refresh changed. */
export type BridgeRefresh = { added: number[]; removed: number[] };

/** Brings the bridge members' `artists` rows and positions up to date with
 *  the member_of edges as they are now, between scans. With `scope`, only
 *  those artists are checked: a band-membership lookup passes the artist it
 *  looked up and every artist an edge it wrote or removed touches, which
 *  are the only ones whose answer can have changed. Without, every artist
 *  is, which index.ts does once per start.
 *
 *  A new bridge member's position starts in the middle of the artists it
 *  links, where layout/seed.ts would put it. One that's no longer a bridge
 *  loses its row, and its position if nothing else keeps one (the rule
 *  layout/seed.ts's cleanup applies). Writes only what changed, so a
 *  refresh that finds nothing new takes no write lock. */
export function refreshBridgeMembers(db: Database, scope?: Iterable<number>): BridgeRefresh {
  const scopeIds = scope ? new Set(scope) : null;

  let wanted: Map<number, number[]>;
  let current: Set<number>;
  if (scopeIds) {
    const edges = memberEdgesTouching(db, scopeIds);
    const isOnMap = db.prepare("SELECT 1 FROM artists WHERE node_id = ? AND track_count > 0");
    const onMap = new Set<number>();
    for (const edge of edges) {
      for (const id of [edge.fromNode, edge.toNode]) if (isOnMap.get(id)) onMap.add(id);
    }
    wanted = new Map([...findBridgeMembers(edges, onMap)].filter(([id]) => scopeIds.has(id)));
    const isBridge = db.prepare("SELECT 1 FROM artists WHERE node_id = ? AND track_count = 0");
    current = new Set([...scopeIds].filter((id) => isBridge.get(id)));
  } else {
    const onMap = new Set(
      (db.prepare("SELECT node_id AS id FROM artists WHERE track_count > 0").all() as { id: number }[]).map((r) => r.id),
    );
    wanted = findBridgeMembers(db.prepare(MEMBER_EDGES_SQL).all() as MemberEdge[], onMap);
    current = new Set(
      (db.prepare("SELECT node_id AS id FROM artists WHERE track_count = 0").all() as { id: number }[]).map((r) => r.id),
    );
  }

  const added = [...wanted.keys()].filter((id) => !current.has(id)).sort((a, b) => a - b);
  const removed = [...current].filter((id) => !wanted.has(id)).sort((a, b) => a - b);
  if (added.length === 0 && removed.length === 0) return { added, removed };

  const positionOf = db.prepare(
    "SELECT seed_x AS x, seed_y AS y FROM positions WHERE node_id = ? AND granularity = 'tracks'",
  );
  const insertRow = db.prepare(
    "INSERT INTO artists (node_id, track_count, album_count) VALUES (?, 0, 0) ON CONFLICT (node_id) DO NOTHING",
  );
  // DO NOTHING: a position the node already has, dragged or settled, stays.
  const insertPosition = db.prepare(
    `INSERT INTO positions (node_id, granularity, seed_x, seed_y, seed_version) VALUES (?, 'tracks', ?, ?, 1)
     ON CONFLICT (node_id, granularity) DO NOTHING`,
  );
  const deleteRow = db.prepare("DELETE FROM artists WHERE node_id = ? AND track_count = 0");
  // layout/seed.ts's cleanup, for one artist node: no artists row now, and
  // no album row or producer/engineer credit to keep a position for.
  const deleteStalePosition = db.prepare(
    `DELETE FROM positions WHERE granularity = 'tracks' AND node_id = ?
       AND NOT EXISTS (SELECT 1 FROM artists WHERE node_id = ?)
       AND NOT EXISTS (SELECT 1 FROM albums WHERE node_id = ?)
       AND NOT EXISTS (SELECT 1 FROM edges WHERE to_node = ? AND type IN ('produced_by', 'engineered_by'))
       AND NOT EXISTS (SELECT 1 FROM files WHERE recording_node_id = ?)`,
  );

  db.transaction(() => {
    for (const id of added) {
      insertRow.run(id);
      const linked = wanted
        .get(id)!
        .map((other) => positionOf.get(other) as Seed | undefined)
        .filter((p): p is Seed => p !== undefined);
      const seed = centroid(linked);
      insertPosition.run(id, seed.x, seed.y);
    }
    for (const id of removed) {
      deleteRow.run(id);
      deleteStalePosition.run(id, id, id, id, id);
    }
  })();
  return { added, removed };
}
