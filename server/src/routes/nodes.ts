import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { resolveCoverForNode } from "../cover/extract.js";
import { generateFacts } from "../facts.js";

const GRANULARITIES = ["artists", "albums", "tracks"] as const;
type Granularity = (typeof GRANULARITIES)[number];

function parseGranularity(value: string | undefined): Granularity {
  return (GRANULARITIES as readonly string[]).includes(value ?? "") ? (value as Granularity) : "tracks";
}

// Which edge types belong to each granularity's graph. 'tracks' is every
// edge — the full mixed graph, unchanged from before granularities
// existed. 'albums'/'artists' are the collaboration-graph edges
// entities/collaboration.ts derives; returning every edge for those would
// mostly return edges between nodes that aren't even in that granularity's
// node set (a recording -> artist edge has no home in the albums graph).
const EDGE_TYPES_BY_GRANULARITY: Record<Granularity, string[] | null> = {
  tracks: null,
  albums: ["same_artist", "same_label"],
  artists: ["collaborated_with"],
};

export function nodesRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { limit?: string; granularity?: string } }>("/nodes", async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 5000), 20000);
      const granularity = parseGranularity(request.query.granularity);
      // A position row is the actual "has something to display" signal —
      // orphaned provisional nodes (collapsed away, no file references
      // them — see match/collapse.ts) never get one, so they never show up
      // here. Joining on a specific granularity is also what scopes the
      // node *set* itself: 'albums'/'artists' positions (layout/seed.ts)
      // are only ever written for release/artist entities, so this one
      // join does double duty as both "has a position" and "belongs to
      // this graph" without a separate node-type filter.
      const rows = db
        .prepare(
          `SELECT n.id, n.type, n.title, n.mbid, r.canonical_duration_ms,
                  p.seed_x, p.seed_y, p.user_x, p.user_y
           FROM nodes n
           JOIN positions p ON p.node_id = n.id AND p.granularity = ?
           LEFT JOIN recordings r ON r.node_id = n.id
           ORDER BY n.id
           LIMIT ?`,
        )
        .all(granularity, limit) as { id: number }[];

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

    app.get<{ Params: { id: string }; Querystring: { granularity?: string } }>("/nodes/:id", async (request, reply) => {
      const id = request.params.id;
      const granularity = parseGranularity(request.query.granularity);
      const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
      if (!node) {
        reply.code(404);
        return { error: "not found" };
      }
      const recording = db.prepare("SELECT * FROM recordings WHERE node_id = ?").get(id);
      const files = db.prepare("SELECT * FROM files WHERE recording_node_id = ? ORDER BY id").all(id);
      const position = db
        .prepare("SELECT seed_x, seed_y, user_x, user_y FROM positions WHERE node_id = ? AND granularity = ?")
        .get(id, granularity);

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

      return {
        ...node,
        recording,
        files,
        position,
        edges: [...outgoing, ...incoming],
        facts: generateFacts(db, Number(id)),
        article: article ?? null,
      };
    });

    // Writes user_x/user_y only — seed_x/seed_y are derived and only ever
    // touched by layout/seed.ts's recompute. A user's drag never gets
    // auto-moved back, per Legato's canvas design. granularity is required
    // in the body (not inferred): the same node can hold an independent
    // drag position in up to three graphs (migration 0015), and only the
    // caller — mid-drag, in one specific graph — knows which one changed.
    app.patch<{ Params: { id: string }; Body: { x: number; y: number; granularity?: string } }>(
      "/nodes/:id/position",
      async (request, reply) => {
        const granularity = parseGranularity(request.body.granularity);
        const result = db
          .prepare("UPDATE positions SET user_x = ?, user_y = ? WHERE node_id = ? AND granularity = ?")
          .run(request.body.x, request.body.y, request.params.id, granularity);
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

    app.get<{ Querystring: { granularity?: string } }>("/edges", async (request) => {
      const granularity = parseGranularity(request.query.granularity);
      const types = EDGE_TYPES_BY_GRANULARITY[granularity];

      if (!types) {
        return db.prepare("SELECT id, from_node, to_node, type, source, label, note FROM edges").all();
      }
      return db
        .prepare(
          `SELECT id, from_node, to_node, type, source, label, note FROM edges WHERE type IN (${types
            .map(() => "?")
            .join(",")})`,
        )
        .all(...types);
    });
  };
}
