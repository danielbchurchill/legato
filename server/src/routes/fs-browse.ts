import type { FastifyInstance } from "fastify";
import { bearerToken, SESSION_COOKIE } from "../auth/gate.js";
import { browse, isBrowseError, type BrowseDeps } from "../fs/browse.js";

// GET /fs/browse?path= (issue #121): the server's own folders, for the
// folder picker on a client that isn't on the server's machine. No path
// lists the browsing roots. See fs/browse.ts for which roots and why.
export function fsBrowseRoutes(deps: BrowseDeps = {}) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { path?: string } }>("/fs/browse", async (request, reply) => {
      // The gate has already turned away anyone signed out. This is the
      // stricter half: a folder listing of the server's disks is for the
      // owner alone, and only on a real session. A media ticket rides in
      // <img> URLs and logs, and it was handed out to read media, not the
      // filesystem.
      const viaSession = bearerToken(request) !== null || request.cookies[SESSION_COOKIE] !== undefined;
      if (request.authUser?.role !== "owner" || !viaSession) {
        reply.code(403);
        return { error: "Only the server's owner can browse its folders.", reason: "owner_only" };
      }

      const result = await browse(request.query.path, deps);
      if (isBrowseError(result)) {
        reply.code(result.status);
        return { error: result.error, reason: result.reason };
      }
      return result;
    });
  };
}
