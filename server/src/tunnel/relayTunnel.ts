import type { FastifyReply } from "fastify";
import { legatoIdentity } from "../auth/legatoIdentity.js";
import { isLinkedAccount } from "../auth/legatoUsers.js";
import { forgetTunnelCredential, readTunnelCredential } from "../auth/tunnelCredential.js";
import type { Database } from "../sqlite.js";
import { TunnelClient, type TunnelClientOptions, type TunnelState } from "./client.js";

// Whether this server keeps a tunnel open to legato.fm, and with which
// credential (issue #310). The rule is the privacy page's: a server that
// isn't linked never contacts legato.fm. So the tunnel runs only while
// this server holds a tunnel credential (migration 0039) from the
// legato.fm it trusts now (LEGATO_ID_ORIGIN), for an account that's still
// linked here. Linking brings the credential (auth/legatoLink.ts);
// unlinking forgets it (routes/auth.ts), and sync() closes the tunnel.
//
// sync() is the one way in: at startup (index.ts, once the server is
// listening, since the tunnel replays requests against it) and after
// every link or unlink. It starts, keeps, swaps or stops the client to
// match what's stored, and leaves a running client alone when that hasn't
// changed. A client whose credential was refused asks again at once:
// whatever the link change was, it's a better moment than the next
// hourly try (tunnel/client.ts).

export type RelayTunnelOptions = {
  /** The port this server listens on; the tunnel replays requests against it on loopback. */
  port: number;
  log?: (level: "info" | "warn", message: string) => void;
  /** Passed through to the client: tests shorten the backoff and the heartbeat. */
  client?: Pick<TunnelClientOptions, "backoff" | "heartbeatMs" | "refusedRetryMs" | "random">;
};

/** wss://auth.legato.fm/tunnel for https://auth.legato.fm. */
export function tunnelUrl(origin: string): string {
  return `${origin.replace(/^http/, "ws")}/tunnel`;
}

export class RelayTunnel {
  private readonly db: Database;
  private readonly options: RelayTunnelOptions;
  private readonly log: (level: "info" | "warn", message: string) => void;
  private client: TunnelClient | null = null;
  // The credential sync() last acted on, connected or not, so an expired
  // one is warned about once rather than on every sync.
  private credential: string | null = null;

  constructor(db: Database, options: RelayTunnelOptions) {
    this.db = db;
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  get state(): TunnelState {
    return this.client?.state ?? "stopped";
  }

  /** The running client, for tests that wait on its state. */
  get current(): TunnelClient | null {
    return this.client;
  }

  sync(): void {
    const identity = legatoIdentity(this.db);
    let stored = identity.origin ? readTunnelCredential(this.db, identity.origin) : null;
    // A credential outliving its link: an unlink from before #310 didn't
    // forget it. It's never used, and goes now.
    if (stored && !isLinkedAccount(this.db, stored.accountId)) {
      forgetTunnelCredential(this.db, stored.accountId);
      this.log("info", "legato.fm: forgot a tunnel credential for an account that isn't linked here any more");
      stored = null;
    }
    if (!stored || !identity.origin) {
      this.stop();
      return;
    }
    if (stored.credential === this.credential) {
      this.client?.retryRefused();
      return;
    }

    this.stop();
    this.credential = stored.credential;
    if (!(Date.parse(stored.expiresAt) > Date.now())) {
      this.log(
        "warn",
        `legato.fm: this server's tunnel credential expired at ${stored.expiresAt}, so this server can't be reached through ` +
          "legato.fm. To turn remote access back on, link this server to your legato.fm account again: a new link brings a new credential.",
      );
      return;
    }
    this.client = new TunnelClient({
      ...this.options.client,
      url: tunnelUrl(identity.origin),
      credential: stored.credential,
      target: `http://127.0.0.1:${this.options.port}`,
      log: this.log,
    });
    this.client.start();
  }

  stop(): void {
    this.client?.stop();
    this.client = null;
    this.credential = null;
  }
}

// One per database, like auth/legatoIdentity.ts's, so the link and unlink
// routes can reach the tunnel index.ts started. None is installed in specs
// unless they install one, so syncing there does nothing.
const instances = new WeakMap<Database, RelayTunnel>();

export function installRelayTunnel(db: Database, tunnel: RelayTunnel): void {
  instances.get(db)?.stop();
  instances.set(db, tunnel);
}

export function syncRelayTunnel(db: Database): void {
  instances.get(db)?.sync();
}

// Syncs once `reply` has gone: a link change made from a phone through
// legato.fm comes down the very tunnel the sync may close, and its answer
// has to reach the phone first. That runs from the response's close,
// outside Fastify's error handling, where a throw is uncaught and Bun
// exits. So SQLITE_BUSY (the recompute Worker holding the write lock past
// busy_timeout), or a database already closed at shutdown, is logged.
export function syncRelayTunnelOnceAnswered(db: Database, reply: FastifyReply): void {
  reply.raw.once("close", () => {
    try {
      syncRelayTunnel(db);
    } catch (err) {
      reply.log.error(err, "legato.fm: couldn't bring the tunnel in line with this server's link");
    }
  });
}
