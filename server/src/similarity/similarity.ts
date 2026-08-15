import type Database from "better-sqlite3";
import { buildFeatureSpace, buildFeatureVector, computeArtistClusters, type RecordingFeatureInput } from "./features.js";
import { rankMostDissimilar, rankMostSimilar, type RankedResult } from "./rank.js";

// Recomputed wholesale after every scan (called from scan/scanner.ts),
// same pattern as entities/aggregate.ts and entities/collaboration.ts —
// this *is* the invalidation story: there is no partial cache to go stale,
// every vector is rebuilt together from current data on every pass. Only
// recording nodes with a real file get a vector; a similarity strip has
// nothing to anchor on for anything else.
export function recomputeSimilarityFeatures(db: Database.Database): void {
  // MIN(f.id) is the only aggregate in this query, which is what makes
  // SQLite's "bare column" rule apply: genre/release_type/duration_ms are
  // guaranteed to come from the same row as that minimum — SQLite-specific
  // behavior, not portable SQL, but the same idiom enrich/worker.ts's
  // getSearchInput relies on via ORDER BY id LIMIT 1 for the single-file
  // case; this is the GROUP BY equivalent for picking one deterministic
  // row per recording when there's more than one file.
  const recordingRows = db
    .prepare(
      `SELECT n.id AS nodeId, f.genre, f.release_type AS releaseType, f.duration_ms AS durationMs, MIN(f.id)
       FROM nodes n
       JOIN files f ON f.recording_node_id = n.id
       WHERE n.type = 'recording'
       GROUP BY n.id`,
    )
    .all() as { nodeId: number; genre: string | null; releaseType: string | null; durationMs: number | null }[];

  const artistByRecording = new Map<number, number>();
  for (const row of db
    .prepare("SELECT from_node AS nodeId, to_node AS artistId FROM edges WHERE type = 'performed_by'")
    .all() as { nodeId: number; artistId: number }[]) {
    if (!artistByRecording.has(row.nodeId)) artistByRecording.set(row.nodeId, row.artistId);
  }

  const labelByRecording = new Map<number, number>();
  for (const row of db
    .prepare("SELECT from_node AS nodeId, to_node AS labelId FROM edges WHERE type = 'released_on'")
    .all() as { nodeId: number; labelId: number }[]) {
    if (!labelByRecording.has(row.nodeId)) labelByRecording.set(row.nodeId, row.labelId);
  }

  const decadeByRecording = new Map<number, number>();
  for (const row of db
    .prepare(
      `SELECT e.from_node AS nodeId, CAST(n.title AS INTEGER) AS year
       FROM edges e JOIN nodes n ON n.id = e.to_node
       WHERE e.type = 'released_in'`,
    )
    .all() as { nodeId: number; year: number | null }[]) {
    if (row.year != null && !Number.isNaN(row.year)) decadeByRecording.set(row.nodeId, Math.floor(row.year / 10) * 10);
  }

  const collaboratedWith = db
    .prepare("SELECT from_node AS fromNode, to_node AS toNode FROM edges WHERE type = 'collaborated_with'")
    .all() as { fromNode: number; toNode: number }[];
  const artistClusters = computeArtistClusters(collaboratedWith);

  const inputs: RecordingFeatureInput[] = recordingRows.map((r) => ({
    nodeId: r.nodeId,
    genres: r.genre ? (JSON.parse(r.genre) as string[]).map((g) => g.toLowerCase()) : [],
    primaryArtistNodeId: artistByRecording.get(r.nodeId) ?? null,
    labelNodeId: labelByRecording.get(r.nodeId) ?? null,
    releaseType: r.releaseType,
    decade: decadeByRecording.get(r.nodeId) ?? null,
    durationMs: r.durationMs,
  }));

  const space = buildFeatureSpace(inputs, artistClusters);

  const upsert = db.prepare(
    `INSERT INTO node_similarity_features (node_id, vector_json) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET vector_json = excluded.vector_json, updated_at = datetime('now')`,
  );
  const applyAll = db.transaction(() => {
    for (const input of inputs) {
      const vector = buildFeatureVector(input, space, artistClusters);
      upsert.run(input.nodeId, JSON.stringify(vector));
    }
  });
  applyAll();
}

function loadVectors(db: Database.Database): Map<number, number[]> {
  const rows = db.prepare("SELECT node_id AS nodeId, vector_json AS vectorJson FROM node_similarity_features").all() as {
    nodeId: number;
    vectorJson: string;
  }[];
  return new Map(rows.map((r) => [r.nodeId, JSON.parse(r.vectorJson) as number[]]));
}

function rankAgainst(
  db: Database.Database,
  nodeId: number,
  limit: number,
  rankFn: typeof rankMostSimilar,
): RankedResult[] {
  const vectors = loadVectors(db);
  const anchor = vectors.get(nodeId);
  if (!anchor) return [];

  const candidates = [...vectors.entries()]
    .filter(([id]) => id !== nodeId)
    .map(([id, vector]) => ({ nodeId: id, vector }));

  return rankFn(anchor, candidates, limit);
}

export function findMostSimilar(db: Database.Database, nodeId: number, limit = 3): RankedResult[] {
  return rankAgainst(db, nodeId, limit, rankMostSimilar);
}

export function findMostDissimilar(db: Database.Database, nodeId: number, limit = 3): RankedResult[] {
  return rankAgainst(db, nodeId, limit, rankMostDissimilar);
}
