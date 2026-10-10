import type { Database } from "./sqlite.js";

/* The three metadata rows on the canvas's selected-node card
 * (src/canvas/NodeCard.tsx), and nothing else.
 *
 * Deliberately not folded into GET /nodes/:id: that payload carries every
 * edge in both directions, every generated fact, the article and the fetched
 * description because the inspector needs all of it, and the card asks for
 * this on every single click. Almost every value here is already aggregated
 * by entities/aggregate.ts, so this is a handful of indexed lookups rather
 * than a recount.
 *
 * Typed values, never formatted strings — durations and dates are rendered
 * by src/ui/format.ts, on the same side of the wire as the type rules that
 * decide how a value is allowed to look.
 */

export type NodeSummary =
  | { kind: "artist"; releases: number; tracks: number; topAlbum: { id: number; title: string } | null }
  | { kind: "release"; tracks: number; totalDurationMs: number; releaseDate: string | null }
  | { kind: "recording"; trackNo: number | null; durationMs: number | null; releaseDate: string | null }
  // label/year/work/credit nodes are real and selectable in the tracks
  // graph, they just have no aggregate worth three rows. The card shows its
  // title block and no metadata list.
  | { kind: "other" }
  | null;

/* routes/stats.ts's topByEdge narrowed to a single artist: the most-played
 * release among the recordings that artist is credited on. Reached through
 * the same performed_by/appears_on edges the global version uses rather than
 * through the artists/albums tables, for the reason stated there — those
 * tables hold current-library aggregates, not play counts.
 *
 * IN rather than a third join, because a recording credits one artist per
 * performed_by edge since 8a3426c: joining would count a play once per
 * credited artist and hand the wrong release the top spot on anything
 * collaborative. A recording is in the list once however many edges credit
 * this artist on it.
 *
 * IN rather than EXISTS (issue #354), because the list is where the query
 * starts: the artist's recordings, a few hundred at most, then their plays
 * and releases, each through an index. An EXISTS is a test on a play, so
 * the query has to start from plays or from every appears_on edge. With
 * nothing played, plays has no statistics, since ANALYZE records nothing
 * for an empty table, and SQLite took it for a large table and went through
 * every edge: half a second per artist at 30,000 albums, statistics or not.
 * This shape took under a millisecond with or without statistics, from
 * nothing played to 200,000 plays.
 *
 * Null until there is play history. The card renders that as an em dash
 * rather than a zero — "nothing has been played yet" and "this artist's
 * albums have been played zero times" are different claims, and only one of
 * them is true on a fresh library. */
function topAlbumForArtist(db: Database, artistNodeId: number): { id: number; title: string } | null {
  const row = db
    .prepare(
      `SELECT n.id AS id, n.title AS title, COUNT(*) AS playCount
       FROM plays pl
       JOIN edges ao ON ao.from_node = pl.recording_node_id AND ao.type = 'appears_on'
       JOIN nodes n ON n.id = ao.to_node
       WHERE pl.recording_node_id IN (
         SELECT pb.from_node FROM edges pb
          WHERE pb.to_node = ?
            AND pb.type = 'performed_by'
       )
       GROUP BY ao.to_node
       ORDER BY playCount DESC, n.id ASC
       LIMIT 1`,
    )
    .get(artistNodeId) as { id: number; title: string } | undefined;
  return row ? { id: row.id, title: row.title } : null;
}

/** Null for a node id that does not exist — the route turns that into a 404. */
export function nodeSummary(db: Database, nodeId: number): NodeSummary {
  const node = db.prepare("SELECT id, type FROM nodes WHERE id = ?").get(nodeId) as
    | { id: number; type: string }
    | undefined;
  if (!node) return null;

  if (node.type === "artist") {
    const agg = db.prepare("SELECT track_count, album_count FROM artists WHERE node_id = ?").get(nodeId) as
      | { track_count: number; album_count: number }
      | undefined;
    // A node with no artists row is an artist entities/aggregate.ts has not
    // caught up with yet, not an error — zero is the honest count.
    return {
      kind: "artist",
      releases: agg?.album_count ?? 0,
      tracks: agg?.track_count ?? 0,
      topAlbum: topAlbumForArtist(db, nodeId),
    };
  }

  if (node.type === "release") {
    const agg = db.prepare("SELECT track_count, total_duration_ms, year_min FROM albums WHERE node_id = ?").get(
      nodeId,
    ) as { track_count: number; total_duration_ms: number; year_min: number | null } | undefined;
    return {
      kind: "release",
      tracks: agg?.track_count ?? 0,
      totalDurationMs: agg?.total_duration_ms ?? 0,
      // A release's own date is a year, not a full date: albums aggregates
      // year_min across its tracks, and the tracks of one release routinely
      // carry slightly different release_date tags.
      releaseDate: agg?.year_min != null ? String(agg.year_min) : null,
    };
  }

  if (node.type === "recording") {
    // Lowest file id, matching NowPlayingPanel's own `node.files[0]` — a
    // recording collapsed from more than one file (match/collapse.ts) has to
    // pick one, and both surfaces have to pick the same one.
    const row = db
      .prepare(
        `SELECT r.canonical_duration_ms AS durationMs, f.track_no AS trackNo, f.release_date AS releaseDate
         FROM nodes n
         LEFT JOIN recordings r ON r.node_id = n.id
         LEFT JOIN files f ON f.recording_node_id = n.id
         WHERE n.id = ?
         ORDER BY f.id
         LIMIT 1`,
      )
      .get(nodeId) as { durationMs: number | null; trackNo: number | null; releaseDate: string | null } | undefined;
    return {
      kind: "recording",
      trackNo: row?.trackNo ?? null,
      durationMs: row?.durationMs ?? null,
      releaseDate: row?.releaseDate ?? null,
    };
  }

  return { kind: "other" };
}
