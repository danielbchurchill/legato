import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bearerToken, SESSION_COOKIE } from "../auth/gate.js";
import { browse, isBrowseError, type BrowseDeps } from "../fs/browse.js";
import { suggestLibraryFolders, type SuggestDeps } from "../fs/suggest.js";

// The gate has already turned away anyone signed out. This is the stricter
// half: a look at the server's disks is for the owner alone, and only on a
// real session. A media ticket rides in <img> URLs and logs, and it was
// handed out to read media, not the filesystem.
function refuseUnlessOwner(request: FastifyRequest, reply: FastifyReply) {
  const viaSession = bearerToken(request) !== null || request.cookies[SESSION_COOKIE] !== undefined;
  if (request.authUser?.role === "owner" && viaSession) return null;
  reply.code(403);
  return { error: "Only the server's owner can browse its folders.", reason: "owner_only" };
}

// GET /fs/browse?path= (issue #121): the server's own folders, for the
// folder picker on a client that isn't on the server's machine. No path
// lists the browsing roots. See fs/browse.ts for which roots and why.
//
// GET /fs/suggestions (issue #132): the folders on the server that look
// like a music library, each with a quick, capped count, for first run.
// See fs/suggest.ts for where it looks.
export function fsBrowseRoutes(deps: BrowseDeps = {}, suggestDeps: SuggestDeps = {}) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { path?: string } }>("/fs/browse", async (request, reply) => {
      const refused = refuseUnlessOwner(request, reply);
      if (refused) return refused;

      const result = await browse(request.query.path, deps);
      if (isBrowseError(result)) {
        reply.code(result.status);
        return { error: result.error, reason: result.reason };
      }
      return result;
    });

    app.get("/fs/suggestions", async (request, reply) => {
      const refused = refuseUnlessOwner(request, reply);
      if (refused) return refused;
      return suggestLibraryFolders(suggestDeps);
    });
  };
}
