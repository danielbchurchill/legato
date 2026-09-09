import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { resolveCoverForNode } from "../cover/extract.js";
import { getDescription } from "../enrich/descriptions.js";
import { listArtistReleases } from "../entities/aggregate.js";
import { generateFacts } from "../facts.js";
import { rescanNode } from "../scan/scanner.js";
import { nodeSummary } from "../summary.js";
import { broadcast } from "../ws.js";

// The one combined graph is always 'tracks' now (2026-08-29 — see
// Legato.md) — 'granularity' persists only because `positions` still keys
// on it (migration 0015) and a PATCH /nodes/:id/position body still names
// it, not because more than one value is ever actually queried.
const GRANULARITY = "tracks";

// Every *real* relationship edge — performed_by, appears_on, and the rest —
// but NOT the derived same_artist/same_label/collaborated_with types
// entities/collaboration.ts computes. Those still exist in the DB (real
// features depend on them: similarity/similarity.ts, facts.ts, and
// articles/recompute.ts), they just never belonged to a *drawn* graph edge:
// an artist's whole catalogue pairwise-connected by same_artist rendered as
// a dense, unreadable mesh even in the old albums-only view (see G-6 in
// git history) — the combined graph already has every real edge type to
// draw, and doesn't need a synthetic one for "these belong together" on
// top of that (physics + the real hierarchy edges already cluster an
// artist's tracks near that artist node on their own).
const EDGE_TYPES = [
  "performed_by",
  "appears_on",
  "released_in",
  "featured_artist",
  "released_on",
  "produced_by",
  "engineered_by",
  "performed_credit",
  "mixed_by",
  // Issue #61: artist-to-artist band membership (enrich/members.ts) — the
  // one edge type in this list that never touches a recording, drawn
  // directly between two artist nodes.
  "member_of",
];

export function nodesRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { limit?: string } }>("/nodes", async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 5000), 20000);
      // A position row is the actual "has something to display" signal —
      // orphaned provisional nodes (collapsed away, no file references
      // them — see match/collapse.ts) never get one, so they never show up
      // here. Joining on granularity='tracks' is also what scopes the node
      // *set* itself: layout/seed.ts's recomputeTracksLayout is the only
      // thing that writes positions now, for every recording/release/artist
      // together, so this one join does double duty as both "has a
      // position" and "belongs to the graph" without a separate node-type
      // filter.
      // subtitle is the second line of the canvas hover plate, so it has to
      // arrive with the graph rather than be fetched per hover — a plate
      // that appears 90ms after the pointer lands cannot also wait on a
      // round trip. Correlated subqueries rather than joins: a recording
      // holds one performed_by edge per credited artist since 8a3426c, and
      // a join would multiply the node row by that count. Taking the
      // lowest-id credit matches what NowPlayingPanel's title block already
      // shows for the same node (its `artist` lookup takes the first
      // performed_by edge), so the plate and the panel never disagree.
      const rows = db
        .prepare(
          `SELECT n.id, n.type, n.title, n.mbid, r.canonical_duration_ms,
                  p.seed_x, p.seed_y, p.user_x, p.user_y,
                  COALESCE(
                    (SELECT an.title FROM nodes an WHERE an.id = al.primary_artist_node_id),
                    (SELECT an.title
                       FROM edges e JOIN nodes an ON an.id = e.to_node
                      WHERE e.from_node = n.id AND e.type = 'performed_by'
                      ORDER BY e.id
                      LIMIT 1)
                  ) AS subtitle
           FROM nodes n
           JOIN positions p ON p.node_id = n.id AND p.granularity = ?
           LEFT JOIN recordings r ON r.node_id = n.id
           LEFT JOIN albums al ON al.node_id = n.id
           ORDER BY n.id
           LIMIT ?`,
        )
        .all(GRANULARITY, limit) as { id: number }[];

      // cover_hash, not a has_cover flag: the canvas renders art through the
      // content-addressed /covers/:hash route (routes/cover.ts), so what it
      // needs is the identity of the image, not a boolean promising one
      // exists. That identity is also what lets every track on an album
      // share a single texture — see that route's comment.
      //
      // Resolved per node in JS through the one shared chain
      // (resolveCoverForNode) rather than as SQL mirroring it. G-7's SQL
      // version could only afford "any album by this artist has art",
      // which disagreed with the image endpoint about *which* album an
      // artist borrows from — invisible while the answer was a boolean,
      // a visibly wrong cover the moment it names one. Three prepared
      // statement lookups per node against an in-process SQLite file is
      // sub-millisecond work at library scale; correctness that can't
      // drift is worth more than the query count here.
      return rows.map((row) => ({ ...row, cover_hash: resolveCoverForNode(db, row.id)?.hash ?? null }));
    });

    app.get<{ Params: { id: string } }>("/nodes/:id", async (request, reply) => {
      const id = request.params.id;
      const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
      if (!node) {
        reply.code(404);
        return { error: "not found" };
      }
      const recording = db.prepare("SELECT * FROM recordings WHERE node_id = ?").get(id);
      const files = db.prepare("SELECT * FROM files WHERE recording_node_id = ? ORDER BY id").all(id);
      const position = db
        .prepare("SELECT seed_x, seed_y, user_x, user_y FROM positions WHERE node_id = ? AND granularity = ?")
        .get(id, GRANULARITY);

      // Both directions resolved with the *other* node's title/type inlined
      // — the client renders "Performed by The Beatles" (outgoing, from a
      // recording) or a list of recordings (incoming, on an artist page)
      // without an extra round trip per edge.
      const outgoing = db
        .prepare(
          `SELECT e.id, e.type, e.source, e.label, e.note, 'out' AS direction,
                  n.id AS other_id, n.title AS other_title, n.type AS other_type
           FROM edges e JOIN nodes n ON n.id = e.to_node
           WHERE e.from_node = ?`,
        )
        .all(id);
      const incoming = db
        .prepare(
          `SELECT e.id, e.type, e.source, e.label, e.note, 'in' AS direction,
                  n.id AS other_id, n.title AS other_title, n.type AS other_type
           FROM edges e JOIN nodes n ON n.id = e.from_node
           WHERE e.to_node = ?`,
        )
        .all(id);

      const article = db.prepare("SELECT body_md, updated_at FROM articles WHERE node_id = ?").get(id);

      // v2's "track metadata" disclosure wants a play count alongside length
      // and the file tags. Real data already, via migration 0013 — recording
      // nodes only, and indexed on recording_node_id so this is one cheap
      // COUNT rather than a join against the full plays table.
      const playCount =
        (node as { type: string }).type === "recording"
          ? (db.prepare("SELECT COUNT(*) AS n FROM plays WHERE recording_node_id = ?").get(id) as { n: number }).n
          : null;

      // Cheap enough (a PK lookup against a tiny table) not to need folding
      // into the main SELECT above — the toggle in NodeTitleBlock.tsx needs
      // to know current state wherever a node is open, and this is the one
      // place every node detail already flows through.
      const isFavourite = db.prepare("SELECT 1 FROM favourites WHERE node_id = ?").get(id) != null;

      // Issue #33: an artist's releases (albums/EPs), separate from the flat
      // incoming-recordings list `edges` already carries — real release
      // entities via entities/aggregate.ts's albums table, not every track
      // by this artist grouped by title on the client. Always an array
      // (empty for every non-artist node type) so the client never has to
      // special-case its absence.
      const releases =
        (node as { type: string }).type === "artist" ? listArtistReleases(db, Number(id)) : [];

      return {
        ...node,
        recording,
        files,
        position,
        edges: [...outgoing, ...incoming],
        facts: generateFacts(db, Number(id)),
        article: article ?? null,
        playCount,
        releases,
        // Prose from outside this library (enrich/wikipedia.ts), kept
        // separate from `article` — that one is generated from the
        // collection itself and rewritten on every scan. Null covers both
        // "never looked up" and "looked up, nothing there".
        description: getDescription(db, Number(id)),
        is_favourite: isFavourite,
      };
    });

    // The selected-node card's three metadata rows. Logic lives in
    // summary.ts so it is testable the way facts.ts is — this file holds no
    // route that isn't a thin wrapper over a query or a module.
    app.get<{ Params: { id: string } }>("/nodes/:id/summary", async (request, reply) => {
      const summary = nodeSummary(db, Number(request.params.id));
      if (!summary) {
        reply.code(404);
        return { error: "not found" };
      }
      return summary;
    });

    // Per-node "rescan this file" (issue #65) — Tag Manager lists tracks
    // missing bpm/label/release_date/release_type, but had no action for
    // them beyond flying to the canvas. rescanNode (scan/scanner.ts) does
    // the actual work; this route is the thin id-resolution/broadcast
    // wrapper around it, same split as every other route in this file.
    app.post<{ Params: { id: string } }>("/nodes/:id/rescan", async (request, reply) => {
      const id = Number(request.params.id);
      const node = db.prepare("SELECT id FROM nodes WHERE id = ?").get(id);
      if (!node) {
        reply.code(404);
        return { error: "not found" };
      }

      const results = await rescanNode(db, id);
      if (results.length === 0) {
        reply.code(404);
        return { error: "no files for this node" };
      }

      for (const result of results) {
        broadcast(
          "outcome" in result ? "scan:file" : "scan:error",
          "outcome" in result
            ? { nodeId: id, filePath: result.filePath, outcome: result.outcome }
            : { nodeId: id, filePath: result.filePath, error: result.error },
        );
      }

      return { results };
    });

    // Writes user_x/user_y only — seed_x/seed_y are derived and only ever
    // touched by layout/seed.ts's recompute. A user's drag never gets
    // auto-moved back by anything routine (routes/layout.ts's explicit
    // "rebuild map" is the one deliberate, user-triggered exception —
    // layout/seed.ts's rebuildLayout, #46).
    app.patch<{ Params: { id: string }; Body: { x: number; y: number } }>(
      "/nodes/:id/position",
      async (request, reply) => {
        const result = db
          .prepare("UPDATE positions SET user_x = ?, user_y = ? WHERE node_id = ? AND granularity = ?")
          .run(request.body.x, request.body.y, request.params.id, GRANULARITY);
        if (result.changes === 0) {
          reply.code(404);
          return { error: "not found" };
        }
        return { ok: true };
      },
    );

    // A release's own track order — what usePlayback.ts needs to build a
    // real queue from "play this track" (the rest of its album, in album
    // order) rather than a single-track stop. MIN(f.id) is the only
    // aggregate, which is what makes SQLite's bare-column rule pick
    // track_no/disc_no from a deterministic row when a recording has more
    // than one file (a merge case, not the common one).
    app.get<{ Params: { id: string } }>("/nodes/:id/tracklist", async (request) => {
      return db
        .prepare(
          `SELECT n.id, n.title, f.track_no, f.disc_no, r.canonical_duration_ms, MIN(f.id)
           FROM edges e
           JOIN nodes n ON n.id = e.from_node
           LEFT JOIN recordings r ON r.node_id = n.id
           LEFT JOIN files f ON f.recording_node_id = n.id
           WHERE e.to_node = ? AND e.type = 'appears_on'
           GROUP BY n.id
           ORDER BY f.disc_no, f.track_no, n.id`,
        )
        .all(request.params.id);
    });

    app.get("/edges", async () => {
      return db
        .prepare(
          `SELECT id, from_node, to_node, type, source, label, note FROM edges WHERE type IN (${EDGE_TYPES.map(
            () => "?",
          ).join(",")})`,
        )
        .all(...EDGE_TYPES);
    });
  };
}
