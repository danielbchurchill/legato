// Deterministic cell assignment + local force relaxation — the fix
// Legato.md's Canvas layout section already prescribed once the old
// year-only seeding overplotted at scale: same-artist albums landed at
// near-identical centroids with overlapping covers, and recordings packed
// into a rigid grid rendered every release's edges as one dense parallel
// ribbon. Deliberately NOT a global force simulation (Legato.md: "No
// global force simulation") — relaxation only ever runs *within* one cell,
// on however many nodes share that cell (bounded, at most a few hundred on
// a real library), never across the whole graph.

export type ClusterInput = {
  nodeId: number;
  // The clustering axis — an artist id, a label id, or null when neither
  // is known (an untagged loose file, an artist who never released on a
  // known label). null-grouped nodes all share one "unclustered" cell.
  groupKey: number | null;
  // The chronological axis — a decade (1960, 1970, ...), or null when no
  // year is known at all.
  decade: number | null;
};

export type Seed = { x: number; y: number };

const DECADE_SPACING = 400;
const UNKNOWN_DECADE_MARGIN = DECADE_SPACING * 3;
const GROUP_BAND_COUNT = 37; // prime, so hash-derived bands don't alias into a visible grid
const GROUP_BAND_SPACING = 90;
const CELL_GRID_SPACING = 8;
const CELL_GRID_COLS = 5;
const RELAXATION_ITERATIONS = 40;
const MIN_NODE_DISTANCE = 5;
const REPULSION_STEP = 0.6;

function baseXForDecade(decade: number): number {
  return decade * (DECADE_SPACING / 10);
}

// FNV-1a — a small, well-known, dependency-free deterministic hash. Only
// needs to scatter group keys across bands reproducibly; cryptographic
// strength is irrelevant here.
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — deterministic PRNG seeded from a node id, so a given
// node's initial jitter inside its cell is reproducible across recomputes
// (same input data -> byte-identical output, matching layout/seed.ts's
// existing seed_version no-op guarantee).
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function groupBandY(groupKey: number): number {
  const band = hash32(`group:${groupKey}`) % GROUP_BAND_COUNT;
  // Centered around 0 rather than [0, N) so the cluster sits in the same
  // vertical territory the old within-decade jitter used.
  return (band - GROUP_BAND_COUNT / 2) * GROUP_BAND_SPACING;
}

// Bounded, deterministic pairwise repulsion — nodes push apart when closer
// than MIN_NODE_DISTANCE, scaled down each iteration so the system settles
// rather than oscillating. O(n^2) per cell, fine at real-library scale (a
// few hundred nodes in the largest artist cell, not thousands).
function relax(nodes: { x: number; y: number }[]): void {
  for (let iter = 0; iter < RELAXATION_ITERATIONS; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        if (dist >= MIN_NODE_DISTANCE) continue;
        const push = ((MIN_NODE_DISTANCE - dist) / dist) * REPULSION_STEP;
        const ox = dx * push;
        const oy = dy * push;
        a.x -= ox / 2;
        a.y -= oy / 2;
        b.x += ox / 2;
        b.y += oy / 2;
      }
    }
  }
}

function packUnclustered(inputs: ClusterInput[], baseX: number): Map<number, Seed> {
  const result = new Map<number, Seed>();
  const sorted = [...inputs].sort((a, b) => a.nodeId - b.nodeId);
  sorted.forEach((input, index) => {
    const row = Math.floor(index / CELL_GRID_COLS);
    const col = index % CELL_GRID_COLS;
    result.set(input.nodeId, { x: baseX + col * CELL_GRID_SPACING, y: row * CELL_GRID_SPACING });
  });
  return result;
}

// Where nodes with no decade at all park — three decades left of the
// earliest known one, matching layout/seed.ts's original unknownRegionX
// reasoning (a fixed absolute offset stretched the graph's bounding box
// 16x on the real library once real decades were in play).
function unknownX(inputs: ClusterInput[]): number {
  const known = inputs.filter((i) => i.decade != null).map((i) => baseXForDecade(i.decade as number));
  if (known.length === 0) return -UNKNOWN_DECADE_MARGIN;
  return Math.min(...known) - UNKNOWN_DECADE_MARGIN;
}

export function computeClusteredSeeds(inputs: ClusterInput[]): Map<number, Seed> {
  const result = new Map<number, Seed>();
  const unclusteredX = unknownX(inputs);

  const cells = new Map<string, ClusterInput[]>();
  for (const input of inputs) {
    const key = `${input.groupKey ?? "u"}:${input.decade ?? "u"}`;
    const list = cells.get(key);
    if (list) list.push(input);
    else cells.set(key, [input]);
  }

  for (const members of cells.values()) {
    const { groupKey, decade } = members[0];

    if (groupKey == null && decade == null) {
      for (const [nodeId, seed] of packUnclustered(members, unclusteredX)) result.set(nodeId, seed);
      continue;
    }

    const baseX = decade != null ? baseXForDecade(decade) : unclusteredX;
    const baseY = groupKey != null ? groupBandY(groupKey) : 0;

    const sorted = [...members].sort((a, b) => a.nodeId - b.nodeId);
    const positioned = sorted.map((m) => {
      const rand = seededRandom(m.nodeId);
      // Deterministic jitter within a small radius of the cell center —
      // relax() then pushes overlapping members apart from there.
      const angle = rand() * Math.PI * 2;
      const radius = rand() * MIN_NODE_DISTANCE;
      return { nodeId: m.nodeId, x: baseX + Math.cos(angle) * radius, y: baseY + Math.sin(angle) * radius };
    });

    relax(positioned);
    for (const p of positioned) result.set(p.nodeId, { x: p.x, y: p.y });
  }

  return result;
}
