import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { getLyrics } from "../lyrics/service.js";

export function lyricsRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    // On demand, not during scan — see migration 0017's comment. First
    // open of a track's lyrics page pays LRCLIB's round trip; every one
    // after that is a cache hit.
    app.get<{ Params: { id: string } }>("/nodes/:id/lyrics", async (request, reply) => {
      const result = await getLyrics(db, Number(request.params.id));
      if (!result) {
        reply.code(404);
        return { error: "not found" };
      }
      return result;
    });
  };
}
