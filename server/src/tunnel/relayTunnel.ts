import type { FastifyReply } from "fastify";
import { legatoIdentity } from "../auth/legatoIdentity.js";
import { isLinkedAccount } from "../auth/legatoUsers.js";
import { loadServerKey, rotateProof } from "../auth/serverKey.js";
import {
  forgetPreviousTunnelCredential,
  forgetTunnelCredential,
  previousTunnelCredential,
  readTunnelCredential,
  replaceTunnelCredential,
  restorePreviousTunnelCredential,
  type StoredTunnelCredential,
} from "../auth/tunnelCredential.js";
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
//
// Rotation (issue #115). legato.fm's credentials last 90 days. Once the
// stored one has less than ROTATE_WHEN_LEFT_MS left, this asks for its
// replacement over the tunnel: when the tunnel connects, and once a day
// while it stays up, but not more than once an hour. That's about a month
// after each credential arrives, so a server that's off for a while still
// has two months to come back before it would need linking again. Each ask
// is signed with this server's identity key (auth/serverKey.ts,
// rotateProof), so a copy of the credential can't renew itself. The
// replacement is stored over the one it replaces, for the same account,
// and the client moves its tunnel onto it (tunnel/client.ts). The one it
// replaced is kept (migration 0044) until legato.fm accepts the new one,
// and goes back in if legato.fm refuses it, so the server is never left
// holding only a credential legato.fm doesn't know. A legato.fm from
// before rotation never answers, and the credential runs out as it always
// did.

const DAY_MS = 24 * 60 * 60_000;
const ROTATE_WHEN_LEFT_MS = 60 * DAY_MS;
const ROTATE_CHECK_MS = DAY_MS;
const ROTATE_ASK_INTERVAL_MS = 60 * 60_000;

export type RelayTunnelOptions = {
  /** The port this server listens on; the tunnel replays requests against it on loopback. */
  port: number;
  log?: (level: "info" | "warn", message: string) => void;
  /** Passed through to the client: tests shorten the backoff and the heartbeat. */
  client?: Pick<TunnelClientOptions, "backoff" | "heartbeatMs" | "refusedRetryMs" | "random">;
  /** How often to check whether the credential is due for rotation. Tests shorten it. */
  rotateCheckMs?: number;
};

/** What the owner's Settings shows about the tunnel: its state, or "expired" for a stored credential that ran out. */
export type RelayTunnelStatus = TunnelState | "expired";

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
  // one is warned about once rather than on every sync. A replacement the
  // client stored becomes it.
  private credential: string | null = null;
  private expiresAt = 0;
  // The legato.fm it was issued by, which the rotate proof names.
  private origin: string | null = null;
  // When it last asked to replace which credential: once an hour at most
  // for each, through reconnects and syncs alike.
  private asked: { credential: string; at: number } | null = null;
  private rotateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database, options: RelayTunnelOptions) {
    this.db = db;
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  get state(): TunnelState {
    return this.client?.state ?? "stopped";
  }

  get status(): RelayTunnelStatus {
    return !this.client && this.credential ? "expired" : this.state;
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
    this.expiresAt = Date.parse(stored.expiresAt);
    this.origin = identity.origin;
    if (!(this.expiresAt > Date.now())) {
      this.log(
        "warn",
        `legato.fm: this server's tunnel credential expired at ${stored.expiresAt}, so this server can't be reached through ` +
          "legato.fm. To turn remote access back on, link this server to your legato.fm account again: a new link brings a new credential.",
      );
      return;
    }
    // A replacement stored before a restart that legato.fm never answered.
    const previous = previousTunnelCredential(this.db, identity.origin);
    const client = new TunnelClient({
      ...this.options.client,
      url: tunnelUrl(identity.origin),
      credential: stored.credential,
      fallback: previous && Date.parse(previous.expiresAt) > Date.now() ? previous.credential : undefined,
      target: `http://127.0.0.1:${this.options.port}`,
      log: this.log,
      onCredential: (replacement) => this.storeReplacement(stored, replacement),
      onReplacementAccepted: (credential) => this.forgetPrevious(credential),
      onReplacementRefused: (credential) => this.restorePrevious(credential),
    });
    this.client = client;
    client.onState((state) => {
      if (state === "connected") this.rotateIfDue();
    });
    this.rotateTimer = setInterval(() => this.rotateIfDue(), this.options.rotateCheckMs ?? ROTATE_CHECK_MS);
    this.rotateTimer.unref?.();
    client.start();
  }

  stop(): void {
    if (this.rotateTimer) clearInterval(this.rotateTimer);
    this.rotateTimer = null;
    this.client?.stop();
    this.client = null;
    this.credential = null;
  }

  // From a timer or a state listener, where a throw is uncaught and Bun
  // exits, so a key that can't be read (SQLITE_BUSY) is logged and the ask
  // waits for the next check.
  private rotateIfDue(): void {
    const now = Date.now();
    const credential = this.credential;
    if (!credential || !this.origin || this.expiresAt - now >= ROTATE_WHEN_LEFT_MS) return;
    if (this.asked?.credential === credential && now - this.asked.at < ROTATE_ASK_INTERVAL_MS) return;
    let proof: { issuedAt: number; signature: string };
    try {
      proof = rotateProof(loadServerKey(this.db), { issuer: this.origin, credential, nowSeconds: Math.floor(now / 1000) });
    } catch (err) {
      this.log(
        "warn",
        `legato.fm: couldn't sign this server's ask for a new tunnel credential (${err instanceof Error ? err.message : String(err)}); it asks again later`,
      );
      return;
    }
    if (this.client?.askForReplacement(proof)) this.asked = { credential, at: now };
  }

  // Only over the credential this tunnel was started with, or its last
  // replacement: an unlink or another link since then has stored something
  // else, and sync() will act on that. A replacement that can't be stored
  // (the recompute Worker holding the write lock past busy_timeout) is
  // dropped, and the tunnel stays on the credential it has.
  private storeReplacement(stored: StoredTunnelCredential, replacement: { credential: string; expiresAt: string }): boolean {
    const current = this.credential;
    if (!current) return false;
    try {
      if (!replaceTunnelCredential(this.db, { origin: stored.origin, accountId: stored.accountId, credential: current }, replacement))
        return false;
    } catch (err) {
      this.log(
        "warn",
        `legato.fm: couldn't store this server's new tunnel credential (${err instanceof Error ? err.message : String(err)}); it keeps the one it has`,
      );
      return false;
    }
    this.credential = replacement.credential;
    this.expiresAt = Date.parse(replacement.expiresAt);
    this.log("info", `legato.fm: replaced this server's tunnel credential; the new one is good until ${replacement.expiresAt}`);
    return true;
  }

  // legato.fm accepted the replacement and retired the one before it. A
  // write that fails leaves the old one kept, which the next acceptance,
  // at the next sign-in, clears.
  private forgetPrevious(credential: string): void {
    try {
      forgetPreviousTunnelCredential(this.db, credential);
    } catch (err) {
      this.log(
        "warn",
        `legato.fm: couldn't forget this server's old tunnel credential (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // legato.fm refused a replacement it never accepted, so the one before it
  // goes back in, and the client signs in with that. False when it can't
  // be put back, and the refusal stands.
  private restorePrevious(refused: string): boolean {
    let restored: { credential: string; expiresAt: string } | null;
    try {
      restored = restorePreviousTunnelCredential(this.db, refused);
    } catch (err) {
      this.log(
        "warn",
        `legato.fm: couldn't go back to this server's old tunnel credential (${err instanceof Error ? err.message : String(err)})`,
      );
      return false;
    }
    if (!restored) return false;
    this.credential = restored.credential;
    this.expiresAt = Date.parse(restored.expiresAt);
    this.log("warn", "legato.fm refused this server's new tunnel credential, so this server went back to the one before it");
    return true;
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

/** The tunnel's status, null where none is installed (specs, and LEGATO_ID_ORIGIN=off). */
export function relayTunnelStatus(db: Database): RelayTunnelStatus | null {
  return instances.get(db)?.status ?? null;
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
