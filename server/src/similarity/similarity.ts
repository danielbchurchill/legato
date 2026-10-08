import type { Database } from "../sqlite.js";
import { writeInChunks } from "../writeInChunks.js";
import { buildFeatureSpace, buildFeatureVector, computeArtistClusters, type RecordingFeatureInput } from "./features.js";
import { rankMostDissimilar, rankMostSimilar, type RankedResult } from "./rank.js";

// Recomputed wholesale after every scan (called from scan/scanner.ts),
// same pattern as entities/aggregate.ts and entities/collaboration.ts —
// this *is* the invalidation story: there is no partial cache to go stale,
// every vector is rebuilt together from current data on every pass. Only
// recording nodes with a real file get a vector; a similarity strip has
// nothing to anchor on for anything else.
export function recomputeSimilarityFeatures(db: Database): void {
  // MIN(f.id) is the only aggregate in this query, which is what makes
  // SQLite's "bare column" rule apply: genre/release_type/duration_ms are
  // guaranteed to come from the same row as that minimum — SQLite-specific
  // behavior, not portable SQL, but the same idiom enrich/worker.ts's
  // getSearchInput relies on via ORDER BY id LIMIT 1 for the single-file
  // case; this is the GROUP BY equivalent for picking one deterministic
  // row per recording when there's more than one file.
  const recordingRows = db
    .prepare(
      `SELECT n.id AS nodeId, f.genre, f.release_type AS releaseType, f.duration_ms AS durationMs, f.bpm, MIN(f.id)
       FROM nodes n
       JOIN files f ON f.recording_node_id = n.id
       WHERE n.type = 'recording'
       GROUP BY n.id`,
    )
    .all() as {
    nodeId: number;
    genre: string | null;
    releaseType: string | null;
    durationMs: number | null;
    bpm: number | null;
  }[];

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
    bpm: r.bpm,
  }));

  const space = buildFeatureSpace(inputs, artistClusters);

  const vectorsByRecording = new Map<number, number[]>();
  for (const input of inputs) vectorsByRecording.set(input.nodeId, buildFeatureVector(input, space, artistClusters));

  // P-2: releases had no vector of their own, so /nodes/:id/similar
  // returned [] for every album — the default thing to select in the
  // default (albums) view. A release's vector is the centroid of its
  // recordings' — same dimensionality (buildFeatureVector always emits
  // one, driven by the fixed feature space, not by which fields a given
  // recording happens to have), so averaging is a plain per-dimension
  // mean.
  const recordingsByRelease = new Map<number, number[]>();
  for (const row of db
    .prepare("SELECT from_node AS recordingId, to_node AS releaseId FROM edges WHERE type = 'appears_on'")
    .all() as { recordingId: number; releaseId: number }[]) {
    if (!vectorsByRecording.has(row.recordingId)) continue;
    if (!recordingsByRelease.has(row.releaseId)) recordingsByRelease.set(row.releaseId, []);
    recordingsByRelease.get(row.releaseId)!.push(row.recordingId);
  }

  // Issue #281: written in pieces (writeInChunks.ts), and a vector that
  // hasn't changed isn't written at all (the upsert's WHERE), so a rescan
  // that changed nothing writes nothing. Every vector is computed above,
  // before any of it. Serialising one, and averaging a release's, happens
  // as it's written, because holding them all serialised would take
  // gigabytes on a 30,000-album library.
  const upsert = db.prepare(
    `INSERT INTO node_similarity_features (node_id, vector_json) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET vector_json = excluded.vector_json, updated_at = datetime('now')
      WHERE vector_json IS NOT excluded.vector_json`,
  );
  writeInChunks(db, vectorsByRecording, ([nodeId, vector]) => upsert.run(nodeId, JSON.stringify(vector)));
  writeInChunks(db, recordingsByRelease, ([releaseId, recordingIds]) => {
    const vectors = recordingIds.map((id) => vectorsByRecording.get(id)!);
    const dims = vectors[0].length;
    const centroid = new Array(dims).fill(0);
    for (const vector of vectors) for (let i = 0; i < dims; i++) centroid[i] += vector[i] / vectors.length;
    upsert.run(releaseId, JSON.stringify(centroid));
  });

  // "Every vector is rebuilt together from current data on every pass"
  // (this function's own doc comment above) was only true for nodes that
  // survived into this pass's `recordingRows` — a recording whose last
  // file was removed (a rescan, a hygiene resolution replacing it with a
  // new node id) drops out of that query, but its old row here was never
  // deleted, so it kept whatever vector_json a *previous* pass gave it.
  // Once the library's vocabulary (buildFeatureSpace's genre/artist/label
  // sets) grows on a later pass, that orphaned vector is shorter than
  // every current one — confirmed live: 25 file-less recordings stuck at
  // a 26-dim vector against 31 dims for everything else, so any
  // similarity query whose candidate pool happened to include one of them
  // threw out of cosineSimilarity's length check, and with no error
  // boundary anywhere in the app that took the whole page down.
  //
  // Re-derived in SQL rather than collected into a JS Set and passed as a
  // NOT IN (...) list (whose parameter count would scale with library
  // size) or stamped via updated_at (datetime('now') is only
  // second-precision — two passes in the same second, exactly what a fast
  // rescan or a test does, would collide and leave the orphan behind).
  // These conditions mirror recordingRows' own JOIN and the
  // vectorsByRecording.has() guard above exactly, so "wanted" here always
  // means what this pass actually wrote. Issue #281: read first and
  // deleted by id, so the search for them holds no lock.
  const orphans = db
    .prepare(
      `SELECT nsf.node_id AS nodeId FROM node_similarity_features nsf
       JOIN nodes n ON n.id = nsf.node_id
       WHERE n.type = 'recording'
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.recording_node_id = nsf.node_id)
       UNION ALL
       SELECT nsf.node_id FROM node_similarity_features nsf
       JOIN nodes n ON n.id = nsf.node_id
       WHERE n.type = 'release'
         AND NOT EXISTS (
           SELECT 1 FROM edges e
           JOIN files f ON f.recording_node_id = e.from_node
           WHERE e.type = 'appears_on' AND e.to_node = nsf.node_id
         )`,
    )
    .all() as { nodeId: number }[];
  const remove = db.prepare("DELETE FROM node_similarity_features WHERE node_id = ?");
  writeInChunks(db, orphans, ({ nodeId }) => remove.run(nodeId));
}

function loadVectors(db: Database): Map<number, { type: string; vector: number[] }> {
  const rows = db
    .prepare(
      `SELECT nsf.node_id AS nodeId, n.type AS type, nsf.vector_json AS vectorJson
       FROM node_similarity_features nsf JOIN nodes n ON n.id = nsf.node_id`,
    )
    .all() as { nodeId: number; type: string; vectorJson: string }[];
  return new Map(rows.map((r) => [r.nodeId, { type: r.type, vector: JSON.parse(r.vectorJson) as number[] }]));
}

// P-3: a track's own release used to dominate its "more like this" strip —
// three tracks off one album, separated by four decimal places, because
// genre/artist/label/type/decade are identical for every track on a
// record. Same-release candidates are excluded outright now rather than
// merely deprioritized, so the strip always spans more than one release.
function releasesByRecording(db: Database): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  for (const row of db
    .prepare("SELECT from_node AS recordingId, to_node AS releaseId FROM edges WHERE type = 'appears_on'")
    .all() as { recordingId: number; releaseId: number }[]) {
    if (!map.has(row.recordingId)) map.set(row.recordingId, new Set());
    map.get(row.recordingId)!.add(row.releaseId);
  }
  return map;
}

function rankAgainst(
  db: Database,
  nodeId: number,
  limit: number,
  rankFn: typeof rankMostSimilar,
): RankedResult[] {
  const vectors = loadVectors(db);
  const anchor = vectors.get(nodeId);
  if (!anchor) return [];

  // Releases and recordings share one vector table but are never
  // comparable to each other — an album's "more like this" should be
  // other albums, a track's other tracks.
  let candidateIds = [...vectors.entries()].filter(([id, v]) => id !== nodeId && v.type === anchor.type);

  if (anchor.type === "recording") {
    const byRecording = releasesByRecording(db);
    const anchorReleases = byRecording.get(nodeId) ?? new Set<number>();
    if (anchorReleases.size > 0) {
      candidateIds = candidateIds.filter(([id]) => {
        const releases = byRecording.get(id);
        if (!releases) return true;
        for (const r of releases) if (anchorReleases.has(r)) return false;
        return true;
      });
    }
  }

  const candidates = candidateIds.map(([id, v]) => ({ nodeId: id, vector: v.vector }));

  return rankFn(anchor.vector, candidates, limit);
}

export function findMostSimilar(db: Database, nodeId: number, limit = 3): RankedResult[] {
  return rankAgainst(db, nodeId, limit, rankMostSimilar);
}

export function findMostDissimilar(db: Database, nodeId: number, limit = 3): RankedResult[] {
  return rankAgainst(db, nodeId, limit, rankMostDissimilar);
}
