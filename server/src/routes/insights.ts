import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import {
  bandFamilies,
  bridges,
  connect,
  findArtists,
  islands,
  mostConnected,
  pathSuggestion,
  recordedTogether,
  sharedLabels,
  sharedPeople,
  soundsAlike,
  topLabels,
  web,
} from "../insights/cards.js";
import { careers, decades, listening } from "../insights/listening.js";
import { loadModel, memo } from "../insights/model.js";

/* #468: Insights, the cards that tell you how your library connects.
 *
 * GET /insights answers with every card at once. A card with nothing to say
 * comes back empty (an empty list, or null), and the panel leaves it out.
 * `state` is "empty" while nothing has been scanned, "pending" until the
 * first recompute after an upgrade has filled the connection tables
 * (index.ts starts one), and "ready" after.
 *
 * The connection cards come from insights/model.ts, kept per change to the
 * library; the listening cards from one pass over plays, kept until the
 * next play (insights/listening.ts). None of it
 * calls the similarity ranking (/nodes/:id/similar), which takes 24-33 s
 * at 30,000 albums (#382): "Sounds alike" reads pairs recompute stored. */

export function insightsRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/insights", async () => {
      const scanned = db.prepare("SELECT 1 FROM files LIMIT 1").get() != null;
      if (!scanned) return { state: "empty" };
      const model = loadModel(db);
      // Both read only the albums table, which changes with the model.
      const shape = memo(model, "decades", () => decades(db));
      const played = listening(db);
      return {
        state: model.computed ? "ready" : "pending",
        web: web(model),
        bridges: bridges(model),
        sharedPeople: sharedPeople(model),
        sharedLabels: sharedLabels(model),
        bandFamilies: bandFamilies(model),
        mostConnected: mostConnected(model),
        islands: islands(model),
        recordedTogether: recordedTogether(model),
        soundsAlike: soundsAlike(db, model),
        pathSuggestion: pathSuggestion(model),
        mostPlayed: played.mostPlayed,
        onRepeat: played.onRepeat,
        rediscover: played.rediscover,
        waiting: played.waiting,
        shape: { decades: shape.decades, undated: shape.undated, labels: topLabels(model) },
        careers: memo(model, "careers", () => careers(db)),
      };
    });

    // The shortest way between two of your artists, each step named.
    app.get<{ Querystring: { from?: string; to?: string } }>("/insights/path", async (request, reply) => {
      const from = Number(request.query.from);
      const to = Number(request.query.to);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        reply.code(400);
        return { error: "from and to must be node ids" };
      }
      return { path: connect(loadModel(db), from, to) };
    });

    // Your artists by name, for the path card's pickers.
    app.get<{ Querystring: { q?: string; limit?: string } }>("/insights/artists", async (request) => {
      const limit = Math.min(Math.max(1, Number(request.query.limit) || 20), 10_000);
      return findArtists(loadModel(db), request.query.q ?? "", limit);
    });
  };
}
