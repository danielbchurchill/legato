import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { markBoundMayHaveShrunk } from "../enrich/members.js";

// Manual, user-authored edges — the free-text "sounds like"/"sampled in"
// layer that sits on top of the edges derived from tags and MusicBrainz.
// Restricted to source='manual'
// throughout: this route can never touch a derived local/musicbrainz edge,
// only ones a person actually created here. Survives re-scan because
// match/edges.ts's regeneration is scoped to `WHERE source = 'local'` —
// this route existing is what that guard is actually protecting.
export function edgesRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.post<{ Body: { fromNode: number; toNode: number; type: string; label?: string; note?: string } }>(
      "/edges",
      async (request, reply) => {
        const { fromNode, toNode, type, label, note } = request.body;
        const from = db.prepare("SELECT id FROM nodes WHERE id = ?").get(fromNode);
        const to = db.prepare("SELECT id FROM nodes WHERE id = ?").get(toNode);
        if (!from || !to) {
          reply.code(400);
          return { error: "fromNode and toNode must both exist" };
        }
        return db
          .prepare(
            `INSERT INTO edges (from_node, to_node, type, source, label, note)
             VALUES (?, ?, ?, 'manual', ?, ?) RETURNING *`,
          )
          .get(fromNode, toNode, type, label ?? null, note ?? null);
      },
    );

    app.patch<{ Params: { id: string }; Body: { label?: string; note?: string } }>(
      "/edges/:id",
      async (request, reply) => {
        const result = db
          .prepare(
            "UPDATE edges SET label = ?, note = ?, updated_at = datetime('now') WHERE id = ? AND source = 'manual'",
          )
          .run(request.body.label ?? null, request.body.note ?? null, request.params.id);
        if (result.changes === 0) {
          reply.code(404);
          return { error: "not found (or not a manual edge)" };
        }
        return db.prepare("SELECT * FROM edges WHERE id = ?").get(request.params.id);
      },
    );

    app.delete<{ Params: { id: string } }>("/edges/:id", async (request, reply) => {
      const removed = db
        .prepare("DELETE FROM edges WHERE id = ? AND source = 'manual' RETURNING from_node, to_node")
        .get(request.params.id) as { from_node: number; to_node: number } | undefined;
      if (!removed) {
        reply.code(404);
        return { error: "not found (or not a manual edge)" };
      }
      // Issue #321: the membership bound is read through edges to artists,
      // manual ones included, so losing one may have shrunk it.
      const touchesArtist = db
        .prepare("SELECT 1 FROM nodes WHERE id IN (?, ?) AND type = 'artist'")
        .get(removed.from_node, removed.to_node);
      if (touchesArtist) markBoundMayHaveShrunk(db);
      reply.code(204);
    });
  };
}
