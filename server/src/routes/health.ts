import type { FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { listRootReachability } from "../scan/reachability.js";
import { GIT_SHA, VERSION } from "../version.js";

// The GET /api/v1/health body. Clients read it before anything else, so
// it stays public (no session needed) and every field is cheap and from
// memory. Shape, for any client or notice that reads it (#193, #110):
//
//   status         "ok" whenever the server answers at all
//   version        release version, the same string `legato-server
//                  --version` prints ("0.0.0-dev" outside a compiled binary)
//   gitSha         commit the binary was built from ("unknown" outside one)
//   schemaVersion  highest migration applied to this server's database; the
//                  number a client compares against the lowest it can work
//                  with (src/config/serverVersion.ts)
//   libraryRoots   each watched root's last-known reachability (#192)
//
// A server older than #193 answers with only status (and libraryRoots),
// which is exactly how clients recognise it as out of date.
export type HealthBody = {
  status: "ok";
  version: string;
  gitSha: string;
  schemaVersion: number;
  libraryRoots: ReturnType<typeof listRootReachability>;
};

// Read once at registration: openDb() has applied every migration by the
// time routes are registered, and nothing applies one while the server
// runs, so there is no reason to query schema_migrations on every poll.
export function highestAppliedMigration(db: Database): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
    version: number | null;
  };
  return row.version ?? 0;
}

export function healthRoutes(db: Database) {
  const schemaVersion = highestAppliedMigration(db);

  return async function routes(app: FastifyInstance) {
    // libraryRoots (issue #192): each watched root's last-known
    // reachability, from memory — never a live stat here, since a dead
    // NFS mount would hang the very endpoint clients use to decide the
    // server is up.
    app.get(
      "/health",
      async (): Promise<HealthBody> => ({
        status: "ok",
        version: VERSION,
        gitSha: GIT_SHA,
        schemaVersion,
        libraryRoots: listRootReachability(),
      }),
    );
  };
}
