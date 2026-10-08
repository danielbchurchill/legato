import type { FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { listRootReachability } from "../scan/reachability.js";
import { SERVER_NAME } from "../config.js";
import { GIT_SHA, VERSION } from "../version.js";
import { resolveInstallChannel, type InstallChannel } from "../update/installChannel.js";
import { readUpdateStatus, type UpdateCheckOptions, type UpdateStatus } from "../update/check.js";

// The GET /api/v1/health body. Clients read it before anything else, so
// it stays public (no session needed) and every field is cheap and from
// memory. Shape, for any client or notice that reads it (#193, #110):
//
//   status         "ok" whenever the server answers at all
//   name           what clients call this server (#117): the machine's name,
//                  or LEGATO_SERVER_NAME (config.ts). The same name it
//                  advertises over mDNS
//   version        release version, the same string `legato-server
//                  --version` prints ("0.0.0-dev" outside a compiled binary)
//   gitSha         commit the binary was built from ("unknown" outside one)
//   schemaVersion  highest migration applied to this server's database; the
//                  number a client compares against the lowest it can work
//                  with (src/config/serverVersion.ts)
//   libraryRoots   each watched root's last-known reachability (#192)
//   installChannel how this server was installed (#110): "docker",
//                  "script", "brew", "desktop" or "unknown", from
//                  LEGATO_INSTALL_CHANNEL (update/installChannel.ts has
//                  which artifact sets which). Decides the update command
//                  the client shows
//   update         the daily release check's last answer (#110, update/check.ts):
//     check          "on", or "off" when LEGATO_UPDATE_CHECK=off, the
//                    updateCheckEnabled setting is "false", the channel is
//                    desktop, or this is a source run. Off nulls the rest
//     latestVersion  newest stable release GitHub listed ("0.4.0"), or null
//                    before the first check and when there are none
//     available      latestVersion is newer than version
//     releaseUrl     that release's GitHub page, for the "unknown" channel's
//                    download link
//     checkedAt      ISO time of the last attempt, successful or not
//
// A server older than #193 answers with only status (and libraryRoots),
// which is exactly how clients recognise it as out of date.
export type HealthBody = {
  status: "ok";
  name: string;
  version: string;
  gitSha: string;
  schemaVersion: number;
  libraryRoots: ReturnType<typeof listRootReachability>;
  installChannel: InstallChannel;
  update: UpdateStatus;
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

// `update` is injectable so health.spec.ts can pin the env and version
// without touching process.env.
export function healthRoutes(db: Database, update: UpdateCheckOptions = {}, name: string = SERVER_NAME) {
  const schemaVersion = highestAppliedMigration(db);
  const installChannel = resolveInstallChannel(update.env);

  return async function routes(app: FastifyInstance) {
    // libraryRoots (issue #192): each watched root's last-known
    // reachability, from memory — never a live stat here, since a dead
    // NFS mount would hang the very endpoint clients use to decide the
    // server is up.
    app.get(
      "/health",
      async (): Promise<HealthBody> => ({
        status: "ok",
        name,
        version: VERSION,
        gitSha: GIT_SHA,
        schemaVersion,
        libraryRoots: listRootReachability(),
        installChannel,
        update: readUpdateStatus(db, update),
      }),
    );
  };
}
