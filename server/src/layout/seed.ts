import type Database from "better-sqlite3";

// v1 layout is year-only: X = decade, Y = position within the decade (see
// Legato.md's Open Questions — artist-cluster/label axes are a later
// upgrade once enrichment data exists). Deterministic placement alone
// overplots at scale (a whole decade's worth of nodes can share one year),
// so nodes sharing a (decade, year) cell are packed into a deterministic
// grid ordered by node id — reproducible on every recompute, and simpler
// than a physics-based local force relaxation while solving the same
// "don't stack exactly on top of each other" problem. A relaxation pass
// can replace this later without touching the schema.
const DECADE_SPACING = 400;
const YEAR_SPACING = 40;
const CELL_GRID_SPACING = 8;
const CELL_GRID_COLS = 5;
const UNKNOWN_YEAR_MARGIN = DECADE_SPACING * 3;

export type SeedInput = { nodeId: number; year: number | null };
export type Seed = { x: number; y: number };

function baseXForYear(year: number): number {
  return Math.floor(year / 10) * 10 * (DECADE_SPACING / 10);
}

// Where year-less nodes park: three decades to the left of the earliest real
// data, rather than at a fixed coordinate.
//
// This used to be an absolute -1200, which looks reasonable until you notice
// baseX is derived from the calendar year itself — the 1960s land at 78,400,
// not at 0. A single untagged file therefore sat ~79,600 units from everything
// else and stretched the graph's bounding box by 16x, so sigma normalised the
// entire real library into roughly 6% of the viewport. Found on the real
// /mnt/music library: 396 of 398 nodes spanned 5,000 units, one node sat at
// -1200, and the canvas rendered as a tiny unreadable clump.
export function unknownRegionX(inputs: SeedInput[]): number {
  const knownBaseXs = inputs
    .filter((input) => input.year != null && !Number.isNaN(input.year))
    .map((input) => baseXForYear(input.year as number));

  if (knownBaseXs.length === 0) return -UNKNOWN_YEAR_MARGIN;
  return Math.min(...knownBaseXs) - UNKNOWN_YEAR_MARGIN;
}

function packCell(inputs: SeedInput[], baseX: number, baseY: number, result: Map<number, Seed>) {
  const sorted = [...inputs].sort((a, b) => a.nodeId - b.nodeId);
  sorted.forEach((input, index) => {
    const row = Math.floor(index / CELL_GRID_COLS);
    const col = index % CELL_GRID_COLS;
    result.set(input.nodeId, { x: baseX + col * CELL_GRID_SPACING, y: baseY + row * CELL_GRID_SPACING });
  });
}

export function computeSeeds(inputs: SeedInput[]): Map<number, Seed> {
  const cells = new Map<string, SeedInput[]>();
  const unknown: SeedInput[] = [];

  for (const input of inputs) {
    if (input.year == null || Number.isNaN(input.year)) {
      unknown.push(input);
      continue;
    }
    const key = String(input.year);
    const list = cells.get(key);
    if (list) list.push(input);
    else cells.set(key, [input]);
  }

  const result = new Map<number, Seed>();

  for (const [yearKey, list] of cells) {
    const year = Number(yearKey);
    const decade = Math.floor(year / 10) * 10;
    const baseY = (year - decade) * YEAR_SPACING;
    packCell(list, baseXForYear(year), baseY, result);
  }

  packCell(unknown, unknownRegionX(inputs), 0, result);

  return result;
}

// Centroid of every recording a non-recording node (artist/release/label)
// connects to via an edge. Without this, only recording nodes would ever
// have a position — but every hard edge M2 derives is recording -> other,
// so a recording-only canvas would render zero visible connections, which
// defeats the actual point ("the library is a graph"). Placing artist/
// release nodes near their own recordings is a simple, deterministic stand-
// in for a real layout axis for those types (still an open question for
// v2 — see Legato.md's genre-axis note).
function computeCentroidSeeds(
  nodeIds: number[],
  connectedRecordingIds: Map<number, number[]>,
  recordingSeeds: Map<number, Seed>,
  fallback: Seed,
): Map<number, Seed> {
  const result = new Map<number, Seed>();
  for (const nodeId of nodeIds) {
    const positions = (connectedRecordingIds.get(nodeId) ?? [])
      .map((id) => recordingSeeds.get(id))
      .filter((s): s is Seed => s != null);

    if (positions.length === 0) {
      result.set(nodeId, fallback);
      continue;
    }
    const x = positions.reduce((sum, p) => sum + p.x, 0) / positions.length;
    const y = positions.reduce((sum, p) => sum + p.y, 0) / positions.length;
    result.set(nodeId, { x, y });
  }
  return result;
}

// Recomputes every node's seed position and persists it. Two passes:
// recording nodes from their current released_in edge (see match/edges.ts),
// then every other node type at the centroid of the recordings it connects
// to. Orphaned nodes (nothing references them — see match/collapse.ts) are
// skipped, they have nothing to display. user_x/user_y are never touched
// here — only a PATCH /nodes/:id/position request writes them.
export function recomputeAllSeeds(db: Database.Database): void {
  const recordingRows = db
    .prepare(
      `SELECT n.id AS node_id,
              (SELECT CAST(y.title AS INTEGER) FROM edges e
                 JOIN nodes y ON y.id = e.to_node
                WHERE e.from_node = n.id AND e.type = 'released_in' LIMIT 1) AS year
       FROM nodes n
       WHERE n.type = 'recording'
         AND EXISTS (SELECT 1 FROM files f WHERE f.recording_node_id = n.id)`,
    )
    .all() as { node_id: number; year: number | null }[];

  const seeds = computeSeeds(recordingRows.map((r) => ({ nodeId: r.node_id, year: r.year })));

  const otherRows = db
    .prepare(
      `SELECT DISTINCT n.id AS node_id FROM nodes n
       WHERE n.type != 'recording'
         AND (EXISTS (SELECT 1 FROM edges e WHERE e.from_node = n.id)
           OR EXISTS (SELECT 1 FROM edges e WHERE e.to_node = n.id))`,
    )
    .all() as { node_id: number }[];

  const connections = new Map<number, number[]>();
  for (const { node_id } of otherRows) {
    const rows = db
      .prepare(
        `SELECT DISTINCT CASE WHEN from_node = ? THEN to_node ELSE from_node END AS other
         FROM edges WHERE from_node = ? OR to_node = ?`,
      )
      .all(node_id, node_id, node_id) as { other: number }[];
    connections.set(
      node_id,
      rows.map((r) => r.other),
    );
  }

  const centroidSeeds = computeCentroidSeeds(
    otherRows.map((r) => r.node_id),
    connections,
    seeds,
    // Same region as year-less recordings, derived from the same data, so a
    // disconnected artist node cannot drag the bounding box either.
    { x: unknownRegionX(recordingRows.map((r) => ({ nodeId: r.node_id, year: r.year }))), y: 0 },
  );
  for (const [nodeId, seed] of centroidSeeds) seeds.set(nodeId, seed);

  // seed_version only bumps when the computed position actually differs —
  // a no-op recompute (nothing about the underlying data changed) must
  // leave the row byte-identical, not just numerically equal.
  const upsert = db.prepare(
    `INSERT INTO positions (node_id, seed_x, seed_y, seed_version) VALUES (?, ?, ?, 1)
     ON CONFLICT(node_id) DO UPDATE SET
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
