import type { Database } from "../sqlite.js";
import { writeInChunks } from "../writeInChunks.js";
import { computeLinks, libraryArtistIds, readLibraryEdges } from "./links.js";
import { computeSimilarArtists, readTrackFeatures } from "./similar.js";

/* #468: the slow half of Insights, run by recompute() on its Worker after
 * the similarity features (recompute.ts). It works out who your artists are
 * tied to and which of them sound alike, and writes only what changed since
 * the last run, in pieces (writeInChunks.ts), so a rescan that changed
 * nothing writes one row: insight_state's watermark. */

export function recomputeInsights(db: Database): void {
  const edges = readLibraryEdges(db);
  const links = computeLinks(db, edges);
  const similar = computeSimilarArtists(readTrackFeatures(db, libraryArtistIds(db), edges));
  const watermark = edges.watermark;

  // Links: keyed by their primary key, compared on what they hold.
  const wantedLinks = new Map(links.map((l) => [`${l.artist}:${l.via}:${l.kind}`, l]));
  const staleLinks: { artist: number; via: number; kind: string }[] = [];
  for (const row of db
    .prepare(
      "SELECT artist_node_id AS artist, via_node_id AS via, kind, weight, witness_node_id AS witness FROM insight_links",
    )
    .all() as { artist: number; via: number; kind: string; weight: number; witness: number | null }[]) {
    const key = `${row.artist}:${row.via}:${row.kind}`;
    const wanted = wantedLinks.get(key);
    if (wanted && wanted.weight === row.weight && wanted.witness === row.witness) wantedLinks.delete(key);
    else if (!wanted) staleLinks.push(row);
  }
  const removeLink = db.prepare("DELETE FROM insight_links WHERE artist_node_id = ? AND via_node_id = ? AND kind = ?");
  const upsertLink = db.prepare(
    `INSERT INTO insight_links (artist_node_id, via_node_id, kind, weight, witness_node_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (artist_node_id, via_node_id, kind) DO UPDATE SET weight = excluded.weight, witness_node_id = excluded.witness_node_id`,
  );
  writeInChunks(db, staleLinks, (l) => removeLink.run(l.artist, l.via, l.kind));
  writeInChunks(db, wantedLinks.values(), (l) => upsertLink.run(l.artist, l.via, l.kind, l.weight, l.witness));

  // Sounds alike, the same way.
  const wantedSimilar = new Map(similar.map((s) => [`${s.artist}:${s.other}`, s]));
  const staleSimilar: { artist: number; other: number }[] = [];
  for (const row of db
    .prepare("SELECT artist_node_id AS artist, other_node_id AS other, score, shared FROM insight_similar_artists")
    .all() as { artist: number; other: number; score: number; shared: string }[]) {
    const key = `${row.artist}:${row.other}`;
    const wanted = wantedSimilar.get(key);
    if (wanted && wanted.score === row.score && JSON.stringify(wanted.shared) === row.shared) wantedSimilar.delete(key);
    else if (!wanted) staleSimilar.push(row);
  }
  const removeSimilar = db.prepare(
    "DELETE FROM insight_similar_artists WHERE artist_node_id = ? AND other_node_id = ?",
  );
  const upsertSimilar = db.prepare(
    `INSERT INTO insight_similar_artists (artist_node_id, other_node_id, score, shared) VALUES (?, ?, ?, ?)
     ON CONFLICT (artist_node_id, other_node_id) DO UPDATE SET score = excluded.score, shared = excluded.shared`,
  );
  writeInChunks(db, staleSimilar, (s) => removeSimilar.run(s.artist, s.other));
  writeInChunks(db, wantedSimilar.values(), (s) =>
    upsertSimilar.run(s.artist, s.other, s.score, JSON.stringify(s.shared)),
  );

  // Last, so a reader never sees a watermark newer than the links it goes
  // with. GET /insights joins credits past it live (model.ts).
  db.prepare(
    `INSERT INTO insight_state (id, edge_watermark, computed_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT (id) DO UPDATE SET edge_watermark = excluded.edge_watermark, computed_at = excluded.computed_at`,
  ).run(watermark);
}

/** Whether a recompute has filled the tables since they were made. A
 *  server upgraded to #468 hasn't, until index.ts starts one. */
export function insightsComputed(db: Database): boolean {
  return db.prepare("SELECT 1 FROM insight_state WHERE id = 1").get() != null;
}
