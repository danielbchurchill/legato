import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { generateFacts } from "../facts.js";

export function nodesRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { limit?: string } }>("/nodes", async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 5000), 20000);
      // A position row is the actual "has something to display" signal —
      // orphaned provisional nodes (collapsed away, no file references
      // them — see match/collapse.ts) never get one, so they never show up
      // here. Covers both recording nodes (year-based) and artist/release
      // nodes (centroid-based) — see layout/seed.ts.
      return db
        .prepare(
          `SELECT n.id, n.type, n.title, n.mbid, r.canonical_duration_ms,
                  p.seed_x, p.seed_y, p.user_x, p.user_y
           FROM nodes n
           JOIN positions p ON p.node_id = n.id
           LEFT JOIN recordings r ON r.node_id = n.id
           ORDER BY n.id
           LIMIT ?`,
        )
        .all(limit);
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
        .prepare("SELECT seed_x, seed_y, user_x, user_y FROM positions WHERE node_id = ?")
        .get(id);

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
    // auto-moved back, per Legato's canvas design.
    app.patch<{ Params: { id: string }; Body: { x: number; y: number } }>(
      "/nodes/:id/position",
      async (request, reply) => {
        const result = db
          .prepare("UPDATE positions SET user_x = ?, user_y = ? WHERE node_id = ?")
          .run(request.body.x, request.body.y, request.params.id);
        if (result.changes === 0) {
          reply.code(404);
          return { error: "not found" };
        }
        return { ok: true };
      },
    );

    app.get("/edges", async () =>
      db.prepare("SELECT id, from_node, to_node, type, source, label, note FROM edges").all(),
    );
  };
}
