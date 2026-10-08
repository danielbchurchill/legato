import type { KeyObject } from "node:crypto";
import { LEGATO_ID_ORIGIN } from "../config.js";
import type { Database } from "../sqlite.js";
import { anyLinkedAccount } from "./legatoUsers.js";
import { importEd25519Jwk, verifyLegatoToken, type VerifyResult } from "./legatoToken.js";
import { ensureServerKey, linkProof, loadServerKey, unlinkProof } from "./serverKey.js";

// This server's side of trusting legato.fm (issue #114): its own id (the
// `aud` a token must carry), and legato.fm's public signing keys, fetched
// from <origin>/.well-known/jwks.json and cached in server_identity
// (migration 0032) so a restart while offline still verifies.
//
// Privacy, and the reason most of this file is about *not* fetching:
// legato.fm/privacy says a home server never contacts legato.fm. That holds
// until the owner links a legato.fm account. Until then, nothing here
// touches the network: no fetch at startup, no daily timer, and an unknown
// kid is just refused. Linking does the first fetch (routes/auth.ts) and
// tells legato.fm about the link (issue #231); from then on the keys
// refresh once a day, and an unknown kid triggers at most one background
// refetch every ten minutes. Unlinking tells legato.fm too, and is the last
// contact if no other account is linked. LEGATO_ID_ORIGIN=off means none of
// this ever runs.

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
// How often a linked server checks whether its keys are a day old. Hourly
// rather than one 24-hour timeout, so a machine that slept through the
// deadline catches up within the hour after it wakes.
const SCHEDULE_TICK_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
// Deliberately not enrich/mbClient.ts's USER_AGENT, which carries a contact
// email for MusicBrainz. The privacy page lists exactly what each request to
// legato.fm sends, and none of it is per install beyond the server's id and
// public key, so the header is the same fixed string on every server: no
// version, no address.
const LEGATO_FM_USER_AGENT = "legato-server";

export type LegatoIdentityOptions = {
  origin?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (level: "info" | "warn", message: string) => void;
};

type IdentityRow = { server_id: string; jwks: string | null; jwks_fetched_at: string | null };

// The outcome of telling legato.fm about a link or an unlink. "unreachable"
// means no answer at all; "refused" is any answer but yes, with legato.fm's
// own message, which says more than a status code would.
export type ReportResult =
  { ok: true } | { ok: false; reason: "unreachable" } | { ok: false; reason: "refused"; message: string; legatoReason: string | null };

export class LegatoIdentity {
  readonly origin: string | null;
  private readonly db: Database;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (level: "info" | "warn", message: string) => void;
  private keyCache: { raw: string | null; keys: Map<string, KeyObject> } | null = null;
  private lastUnknownKidRefetch = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database, options: LegatoIdentityOptions = {}) {
    this.db = db;
    this.origin = options.origin === undefined ? LEGATO_ID_ORIGIN : options.origin;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    // Before anything can read the id, so it's never seen changing. Once in
    // the server's life (serverKey.ts); index.ts builds this at startup, so
    // the line lands in the startup log.
    const moved = ensureServerKey(db);
    if (moved) {
      this.log(
        "warn",
        `legato.fm: this server's id is now ${moved.to} (was ${moved.from}), made from its new identity key.` +
          (anyLinkedAccount(db) ? " Link its legato.fm account again: legato.fm only opens servers that reported their link." : ""),
      );
    }
  }

  get enabled(): boolean {
    return this.origin !== null;
  }

  private row(): IdentityRow {
    return this.db.prepare("SELECT server_id, jwks, jwks_fetched_at FROM server_identity WHERE id = 1").get() as IdentityRow;
  }

  serverId(): string {
    return this.row().server_id;
  }

  // Parsed once per stored value, not per request.
  keys(): ReadonlyMap<string, KeyObject> {
    const { jwks } = this.row();
    if (this.keyCache?.raw === jwks) return this.keyCache.keys;
    const keys = new Map<string, KeyObject>();
    if (jwks) {
      for (const entry of (JSON.parse(jwks) as { keys: unknown[] }).keys) {
        const imported = importEd25519Jwk(entry);
        if (imported) keys.set(imported.kid, imported.key);
      }
    }
    this.keyCache = { raw: jwks, keys };
    return keys;
  }

  private fetchedAtMs(): number | null {
    const { jwks_fetched_at } = this.row();
    return jwks_fetched_at ? Date.parse(jwks_fetched_at) : null;
  }

  // Fetches and stores the key set. Never throws: a failure keeps whatever
  // was cached before, logs why, and returns false. Concurrent callers
  // share one request.
  refresh(): Promise<boolean> {
    if (!this.origin) return Promise.resolve(false);
    this.inFlight ??= this.fetchKeys(this.origin).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchKeys(origin: string): Promise<boolean> {
    const url = `${origin}/.well-known/jwks.json`;
    try {
      const res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": LEGATO_FM_USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: unknown };
      if (!body || !Array.isArray(body.keys)) throw new Error("the response has no `keys` array");
      // Only the entries this server can use are kept, so the stored copy
      // is exactly what keys() will trust.
      const usable = body.keys.filter((entry) => importEd25519Jwk(entry) !== null);
      if (usable.length === 0) throw new Error("the key set has no Ed25519 signing keys");
      this.db
        .prepare("UPDATE server_identity SET jwks = ?, jwks_fetched_at = ? WHERE id = 1")
        .run(JSON.stringify({ keys: usable }), new Date(this.now()).toISOString());
      this.log("info", `legato.fm: fetched ${usable.length} signing key(s) from ${url}`);
      return true;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.log("warn", `legato.fm: couldn't fetch signing keys from ${url} (${why}); keeping the cached ones`);
      return false;
    }
  }

  // Tells legato.fm this server verified a `link` token, so it records the
  // (account, server) pair and signs `access` tokens for it. Signed with the
  // identity key, which is what makes the pair this server's and no one
  // else's (serverKey.ts).
  recordLink(linkToken: string): Promise<ReportResult> {
    return this.report("/linked-servers", linkProof(loadServerKey(this.db), linkToken));
  }

  // Tells legato.fm the owner unlinked this account here, so it stops
  // signing `access` tokens for it.
  recordUnlink(accountId: string): Promise<ReportResult> {
    if (!this.origin) return Promise.resolve({ ok: false, reason: "unreachable" });
    const proof = unlinkProof(loadServerKey(this.db), {
      issuer: this.origin,
      accountId,
      nowSeconds: Math.floor(this.now() / 1000),
    });
    return this.report("/linked-servers/unlink", proof);
  }

  private async report(path: string, body: Record<string, unknown>): Promise<ReportResult> {
    if (!this.origin) return { ok: false, reason: "unreachable" };
    const url = `${this.origin}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": LEGATO_FM_USER_AGENT },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      this.log("warn", `legato.fm: couldn't reach ${url} (${err instanceof Error ? err.message : String(err)})`);
      return { ok: false, reason: "unreachable" };
    }
    if (res.ok) return { ok: true };
    const answer = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
    const message = typeof answer?.error === "string" ? answer.error : `HTTP ${res.status}`;
    this.log("warn", `legato.fm: ${url} refused (${res.status}): ${message}`);
    return {
      ok: false,
      reason: "refused",
      message,
      legatoReason: typeof answer?.reason === "string" ? answer.reason : null,
    };
  }

  async refreshIfStale(): Promise<void> {
    const fetchedAt = this.fetchedAtMs();
    if (fetchedAt !== null && this.now() - fetchedAt < REFRESH_AFTER_MS) return;
    await this.refresh();
  }

  // Verifies against the cached keys only; never waits on the network.
  // An unknown kid on a linked server queues a background refetch, so a
  // just-rotated key works on the next request instead of in a day.
  verify(token: string): VerifyResult {
    if (!this.origin) return { ok: false, reason: "wrong_issuer" };
    const result = verifyLegatoToken(token, {
      keys: this.keys(),
      issuer: this.origin,
      audience: this.serverId(),
      nowSeconds: Math.floor(this.now() / 1000),
    });
    if (!result.ok && result.reason === "unknown_key") this.refetchForUnknownKid();
    return result;
  }

  private refetchForUnknownKid(): void {
    if (!anyLinkedAccount(this.db)) return;
    if (this.now() - this.lastUnknownKidRefetch < UNKNOWN_KID_REFETCH_MS) return;
    this.lastUnknownKidRefetch = this.now();
    void this.refresh();
  }

  // Starts the daily refresh when this server has a linked account and
  // stops it when it no longer does. Called at startup and after every
  // link or unlink, so the timer only exists while contact is allowed.
  syncSchedule(): void {
    const shouldRun = this.enabled && anyLinkedAccount(this.db);
    if (shouldRun && !this.timer) {
      void this.refreshIfStale();
      this.timer = setInterval(() => void this.refreshIfStale(), SCHEDULE_TICK_MS);
      this.timer.unref?.();
    } else if (!shouldRun && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// One per database, shared by the gate and the auth routes, which are
// wired up separately (index.ts, routes/register.ts) and have only the db
// in common. Tests install their own, with a stub fetch and clock, before
// building the app.
const instances = new WeakMap<Database, LegatoIdentity>();

export function legatoIdentity(db: Database): LegatoIdentity {
  let identity = instances.get(db);
  if (!identity) {
    identity = new LegatoIdentity(db);
    instances.set(db, identity);
  }
  return identity;
}

export function installLegatoIdentity(db: Database, identity: LegatoIdentity): void {
  instances.get(db)?.stop();
  instances.set(db, identity);
}
