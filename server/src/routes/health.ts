import type { FastifyInstance } from "fastify";
import { listRootReachability } from "../scan/reachability.js";

export function healthRoutes() {
  return async function routes(app: FastifyInstance) {
    // libraryRoots (issue #192): each watched root's last-known
    // reachability, from memory — never a live stat here, since a dead
    // NFS mount would hang the very endpoint clients use to decide the
    // server is up.
    app.get("/health", async () => ({ status: "ok", libraryRoots: listRootReachability() }));
  };
}
