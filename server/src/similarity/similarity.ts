import type { Database } from "../sqlite.js";
import { writeInChunks } from "../writeInChunks.js";
import {
  buildFeatureSpace,
  buildFeatureVector,
  computeArtistClusters,
  Dimensions,
  type RecordingFeatureInput,
} from "./features.js";
import { rankMostDissimilar, rankMostSimilar, type RankedResult } from "./rank.js";
import { loadVectorIndex, rowOf, type VectorIndex } from "./vectorIndex.js";
import { centroid, encodeVector, sameBytes, type SparseVector } from "./vectors.js";

/** What a recompute changed: vectors written and vectors removed. */
export type SimilarityRecompute = { written: number; removed: number };

// Recomputed wholesale after every scan (called from scan/scanner.ts),
// same pattern as entities/aggregate.ts and entities/collaboration.ts —
// every vector is rebuilt from current data on every pass, and only what
// came out different is written. Only recording nodes with a real file get
// a vector, and releases the centroid of theirs; a similarity strip has
// nothing to anchor on for anything else.
export function recomputeSimilarityFeatures(db: Database): SimilarityRecompute {
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

  const space = buildFeatureSpace(inputs);
  const dimensions = new Dimensions(
    db.prepare("SELECT key, id FROM similarity_dimensions").values() as [string, number][],
  );

  const vectors = new Map<number, SparseVector>();
  for (const input of inputs) vectors.set(input.nodeId, buildFeatureVector(input, space, artistClusters, dimensions));

  // P-2: releases had no vector of their own, so /nodes/:id/similar
  // returned [] for every album — the default thing to select in the
  // default (albums) view. A release's vector is the centroid of its
  // recordings', a plain per-dimension mean.
  const recordingsByRelease = new Map<number, SparseVector[]>();
  for (const [recordingId, releaseId] of db
    .prepare("SELECT from_node, to_node FROM edges WHERE type = 'appears_on'")
    .values() as [number, number][]) {
    const vector = vectors.get(recordingId);
    if (!vector) continue;
    const onRelease = recordingsByRelease.get(releaseId);
    if (onRelease) onRelease.push(vector);
    else recordingsByRelease.set(releaseId, [vector]);
  }
  for (const [releaseId, onRelease] of recordingsByRelease) vectors.set(releaseId, centroid(onRelease));

  // A new dimension's key goes in before any vector that uses it.
  const addDimension = db.prepare("INSERT INTO similarity_dimensions (id, key) VALUES (?, ?)");
  writeInChunks(db, dimensions.added, ([key, id]) => addDimension.run(id, key));

  // Issue #281: only a vector that came out different is written, so a
  // rescan that changed nothing writes nothing. Issue #322: with each
  // dimension keyed by its feature, a library that gains a genre, an artist
  // or a label changes only the vectors that have it. A new extreme of
  // decade, length or tempo still moves every vector's value for it, since
  // those are placed within the library's range.
  const stored = new Map(
    db.prepare("SELECT node_id, vector FROM node_similarity_features").values() as [number, Uint8Array][],
  );
  const changed: [nodeId: number, vector: Uint8Array][] = [];
  for (const [nodeId, vector] of vectors) {
    const bytes = encodeVector(vector);
    if (!sameBytes(stored.get(nodeId), bytes)) changed.push([nodeId, bytes]);
  }
  stored.clear();
  const upsert = db.prepare(
    `INSERT INTO node_similarity_features (node_id, vector) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET vector = excluded.vector, updated_at = datetime('now')`,
  );
  writeInChunks(db, changed, ([nodeId, bytes]) => upsert.run(nodeId, bytes));

  // "Every vector is rebuilt from current data on every pass" (this
  // function's own doc comment above) was only true for nodes that
  // survived into this pass's `recordingRows` — a recording whose last
  // file was removed (a rescan, a hygiene resolution replacing it with a
  // new node id) drops out of that query, but its old row here was never
  // deleted, so it kept whatever vector a *previous* pass gave it. While
  // vectors were dense, once the library's vocabulary grew on a later pass,
  // that orphaned vector was shorter than every current one — confirmed
  // live: 25 file-less recordings stuck at a 26-dim vector against 31 dims
  // for everything else, so any similarity query whose candidate pool
  // happened to include one of them threw out of cosineSimilarity's length
  // check, and with no error boundary anywhere in the app that took the
  // whole page down. A sparse vector (#322) can't be the wrong length, but
  // one left for a recording with no file still ranks a track nobody can
  // play.
  //
  // Re-derived in SQL rather than collected into a JS Set and passed as a
  // NOT IN (...) list (whose parameter count would scale with library
  // size) or stamped via updated_at (datetime('now') is only
  // second-precision — two passes in the same second, exactly what a fast
  // rescan or a test does, would collide and leave the orphan behind).
  // These conditions mirror recordingRows' own JOIN and the
  // inputsByRecording.has() guard above exactly, so "wanted" here always
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

  // Last, once every vector it counts is in: the request loop reads its
  // copy again when this moves (vectorsFor below).
  if (changed.length + orphans.length > 0) db.prepare("UPDATE similarity_state SET version = version + 1 WHERE id = 1").run();
  return { written: changed.length, removed: orphans.length };
}

function similarityVersion(db: Database): number {
  return (db.prepare("SELECT version FROM similarity_state WHERE id = 1").get() as { version: number }).version;
}

/** Issue #322: whether a recompute has written vectors since migration
 *  0055 dropped the dense ones (index.ts starts one if not). */
export function similarityComputed(db: Database): boolean {
  return similarityVersion(db) > 0;
}

// Issue #382: every vector, in memory, for as long as the stored ones stay
// as they were. Read again, a slice at a time (vectorIndex.ts), the first
// time it's asked for after a recompute has changed them. A request that
// arrives meanwhile waits for the same read.
const indexes = new WeakMap<Database, { version: number; index: Promise<VectorIndex> }>();

function vectorsFor(db: Database): Promise<VectorIndex> {
  const version = similarityVersion(db);
  const cached = indexes.get(db);
  if (cached?.version === version) return cached.index;
  const index = loadVectorIndex(db);
  const entry = { version, index };
  indexes.set(db, entry);
  // A read that failed is tried again by the next request, not kept.
  index.catch(() => {
    if (indexes.get(db) === entry) indexes.delete(db);
  });
  return index;
}

/** Called once a recompute has finished: if a similarity strip has been
 *  asked for since the server started, its vectors are read again now, in
 *  the background, rather than by the next request. */
export function refreshSimilarityVectors(db: Database): void {
  if (indexes.has(db)) vectorsFor(db).catch(() => {});
}

async function rankAgainst(
  db: Database,
  nodeId: number,
  limit: number,
  rankFn: typeof rankMostSimilar,
): Promise<RankedResult[]> {
  // An artist, or anything else without a vector, has nothing to rank
  // against, and needn't wait for the vectors to load to find that out.
  if (!db.prepare("SELECT 1 FROM node_similarity_features WHERE node_id = ?").get(nodeId)) return [];
  const index = await vectorsFor(db);
  const anchor = rowOf(index, nodeId);
  if (anchor < 0) return [];

  // P-3: a track's own release used to dominate its "more like this" strip —
  // three tracks off one album, separated by four decimal places, because
  // genre/artist/label/type/decade are identical for every track on a
  // record. Same-release candidates are excluded outright now rather than
  // merely deprioritized, so the strip always spans more than one release.
  // Read for this anchor alone: the tracks on any of its releases.
  const sameRelease = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT other.from_node FROM edges mine
           JOIN edges other ON other.to_node = mine.to_node AND other.type = 'appears_on'
           WHERE mine.from_node = ? AND mine.type = 'appears_on'`,
        )
        .values(nodeId) as [number][]
    ).map(([id]) => id),
  );

  // Releases and recordings share one vector table but are never
  // comparable to each other — an album's "more like this" should be
  // other albums, a track's other tracks. rankFn only ranks rows of the
  // anchor's own type.
  return rankFn({ index, anchor, include: (row) => !sameRelease.has(index.ids[row]!) }, limit);
}

export function findMostSimilar(db: Database, nodeId: number, limit = 3): Promise<RankedResult[]> {
  return rankAgainst(db, nodeId, limit, rankMostSimilar);
}

export function findMostDissimilar(db: Database, nodeId: number, limit = 3): Promise<RankedResult[]> {
  return rankAgainst(db, nodeId, limit, rankMostDissimilar);
}
