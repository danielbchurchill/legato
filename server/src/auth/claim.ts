import type { LegatoIdentity } from "./legatoIdentity.js";
import { VERIFY_FAILURE_MESSAGES } from "./legatoToken.js";
import type { SetupCodes } from "./setupCode.js";

// Claiming a headless server for a legato.fm account from /setup (issue
// #237, plan 02 "Claiming a headless server"). The QR on /setup opens
// legato.fm/claim with the setup code; someone signs in there and claims
// it; this server asks legato.fm whether its code has been claimed, and
// gets a `link` token for that account if so. The person at /setup then
// sees whose account it is, and linking it is a choice they make when they
// create the owner (routes/auth.ts, POST /auth/owner), never the default.
//
// When it asks. legato.fm/privacy promises that a server nobody has linked
// never contacts legato.fm, and a server with no owner keeps a setup code
// live for as long as nobody sets it up: a forgotten container would
// otherwise ask every few seconds, forever. So nothing here runs on a
// timer. The /setup page checks in (GET /auth/setup) every few seconds
// while it's open and shows the code, and each check-in may start one
// request to legato.fm, at most one every POLL_INTERVAL_MS. Close the page
// and the requests stop with it. Nothing asks once an owner exists: that
// route refuses then, and the page is gone.
//
// When legato.fm says to wait (a 429: something on this network asked about
// too many codes nobody claimed, relay/src/rate-limit.ts), it isn't a
// refusal. This server stops asking about the code it was told to wait on,
// logs it once, and /setup says legato.fm is busy and it'll keep trying. It
// takes legato.fm's word for a minute at most. legato.fm answers a code
// claimed for this server whatever its limiter says, so all the wait holds
// up is a claim made meanwhile, and waiting longer would let one run out
// unseen. Nor does a wait on one code hold up the others: the code before
// it, in its two minutes of grace, is still asked about every five seconds.
//
// When to ask is kept by a monotonic clock. A Pi has no clock of its own
// until NTP sets it, and a step back mustn't stop it asking.
//
// What a claim holds, and what it leaves behind. The link token lasts ten
// minutes, and lives only in this object: a restart forgets it. legato.fm
// mints the tunnel credential only when this server reports the link it
// makes with that token (auth/legatoLink.ts), so a claim that's declined,
// lapses or is forgotten leaves no credential anywhere, and the code it was
// made with is spent.

const POLL_INTERVAL_MS = 5_000;
// How long after the code changes a claim of the old one still counts: a
// phone that scanned it just before is still signing in when it claims.
const PREVIOUS_CODE_GRACE_MS = 2 * 60_000;
// A claim counts as lapsed this long before its token expires, so the
// report made at owner creation never carries a token about to run out on
// legato.fm's clock.
const LAPSE_MARGIN_MS = 30_000;
// How long to hold a code back after a 429: what legato.fm says, up to a
// minute, and a minute when it doesn't say.
const HOLD_MAX_MS = 60_000;

// email is masked (maskEmail): /setup has no sign-in, so anyone on the
// network who can see the code can read it. Enough for someone to
// recognise their own account.
export type ClaimAccount = { id: string; name: string | null; email: string | null };

// busy: legato.fm asked this server to wait before asking again.
export type ClaimView =
  | { state: "waiting"; unreachable: boolean; busy: boolean }
  | { state: "claimed"; account: ClaimAccount; expiresInMs: number }
  | { state: "lapsed"; account: ClaimAccount }
  | { state: "used" }
  | { state: "expired" }
  | { state: "refused"; message: string };

type Notice = Extract<ClaimView, { state: "lapsed" | "used" | "expired" | "refused" }>;

export type ClaimCheck = "ok" | "no_claim" | "mismatch" | "lapsed";

/** r•••@example.com: the first letter and the domain. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

export class ServerClaims {
  private pending: { linkToken: string; account: ClaimAccount; lapsesAt: number } | null = null;
  // Codes this server redeemed itself, which aren't asked about again:
  // legato.fm would only hand back the same token, or say "used" once the
  // claim ran out.
  private readonly spent = new Set<string>();
  // The last thing worth telling /setup while nothing is pending.
  private notice: Notice | null = null;
  private unreachable = false;
  // The live code's last answer was a 429.
  private busy = false;
  // Codes legato.fm said to wait on, and until when, on the monotonic clock.
  private readonly heldUntil = new Map<string, number>();
  private lastPollAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly log: (level: "info" | "warn", message: string) => void;

  constructor(
    private readonly options: {
      setupCodes: SetupCodes;
      // A getter: index.ts installs the server's identity after the routes
      // that hold this are registered.
      identity: () => LegatoIdentity;
      // The wall clock, which a link token's expiry is on.
      now?: () => number;
      // The monotonic one, for when to ask.
      clock?: () => number;
      log?: (level: "info" | "warn", message: string) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? (() => performance.now());
    this.log = options.log ?? (() => {});
  }

  get enabled(): boolean {
    return this.options.identity().enabled;
  }

  /** A /setup page checking in: may start one request to legato.fm. */
  checkIn(): ClaimView {
    this.lapse();
    const now = this.clock();
    if (this.enabled && !this.pending && !this.inFlight && now - this.lastPollAt >= POLL_INTERVAL_MS) {
      this.lastPollAt = now;
      this.inFlight = this.poll().finally(() => {
        this.inFlight = null;
      });
    }
    return this.view();
  }

  /** Resolves once the request a check-in started has been answered. */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  view(): ClaimView {
    this.lapse();
    if (this.pending) {
      return { state: "claimed", account: this.pending.account, expiresInMs: Math.max(this.pending.lapsesAt - this.now(), 0) };
    }
    // Busy is what's true now. A notice left from before it isn't news.
    if (this.busy) return { state: "waiting", unreachable: this.unreachable, busy: true };
    return this.notice ?? { state: "waiting", unreachable: this.unreachable, busy: false };
  }

  /**
   * Whether creating the owner can link this account: a claim is pending,
   * and it's for the account the page showed. Asked before the owner is
   * created, so a request that can't link creates nobody either.
   */
  check(accountId: unknown): ClaimCheck {
    this.lapse();
    if (!this.pending) return this.notice?.state === "lapsed" ? "lapsed" : "no_claim";
    return this.pending.account.id === accountId ? "ok" : "mismatch";
  }

  /** The pending claim's link token, if it's still for this account. Takes it. */
  take(accountId: string): string | null {
    if (this.check(accountId) !== "ok") return null;
    const { linkToken } = this.pending!;
    this.pending = null;
    return linkToken;
  }

  /** The owner exists now. Whatever's still pending wasn't chosen. */
  drop(): void {
    if (this.pending) this.log("info", "legato.fm: the owner was created without linking the account that claimed this server");
    this.pending = null;
    this.notice = null;
  }

  // The code the lapsed claim was made with is spent on legato.fm, so a
  // new claim needs a new code.
  private lapse(): void {
    if (!this.pending || this.now() < this.pending.lapsesAt) return;
    this.log("info", "legato.fm: a claim lapsed before the owner was created, so nothing was linked");
    this.notice = { state: "lapsed", account: this.pending.account };
    this.pending = null;
    this.options.setupCodes.replace();
  }

  private async poll(): Promise<void> {
    const identity = this.options.identity();
    const { setupCodes } = this.options;
    const [live, ...previous] = setupCodes.claimable(PREVIOUS_CODE_GRACE_MS);
    const codes = [live!, ...previous];
    for (const code of this.heldUntil.keys()) if (!codes.includes(code)) this.heldUntil.delete(code);
    for (const code of codes) {
      if (this.spent.has(code) || this.clock() < (this.heldUntil.get(code) ?? Number.NEGATIVE_INFINITY)) continue;
      const result = await identity.exchangeClaim(code);
      if (result.ok) {
        this.spent.add(code);
        this.busy = false;
        return this.accept(identity, result.linkToken);
      }
      if (result.reason === "unreachable") {
        if (!this.unreachable)
          this.log("warn", `legato.fm: couldn't reach ${identity.origin} to check for a claim; still trying while /setup is open`);
        this.unreachable = true;
        return;
      }
      this.unreachable = false;
      if (result.status === 429) {
        const waitMs = Math.min((result.retryAfterSeconds ?? Number.POSITIVE_INFINITY) * 1000, HOLD_MAX_MS);
        this.heldUntil.set(code, this.clock() + waitMs);
        if (code === live) {
          if (!this.busy) {
            this.log(
              "info",
              `legato.fm: busy, so checking for a claim again in ${Math.ceil(waitMs / 1000)} s ` +
                "(something on this network asked about too many codes nobody claimed)",
            );
          }
          this.busy = true;
        }
        continue;
      }
      this.heldUntil.delete(code);
      if (code === live) this.busy = false;
      if (result.status === 404) {
        if (code === live && this.notice?.state === "refused") this.notice = null;
        continue;
      }
      // Only the live code's answers are worth showing: the page has
      // already moved on from the one before it.
      if (code !== live) continue;
      // legato.fm keeps a claim for this server alone and answers it again
      // while it lasts, so "used" means this server redeemed it, the answer
      // never got here, and the claim ran out before it asked again.
      if (result.legatoReason === "used") {
        this.log(
          "warn",
          "legato.fm: the answer to a claim of this setup code never got here, and the claim has run out, " +
            "so nothing was linked; the code's been replaced",
        );
        this.notice = { state: "used" };
        setupCodes.replace();
      } else if (result.legatoReason === "expired") {
        this.notice = { state: "expired" };
      } else {
        this.notice = { state: "refused", message: result.message };
      }
    }
  }

  // legato.fm says someone claimed the code. Its token says who, once it
  // checks out against legato.fm's keys, which this fetches now if it has
  // none yet. The code is spent either way, so a token that doesn't check
  // out also replaces it.
  private async accept(identity: LegatoIdentity, linkToken: string): Promise<void> {
    let result = identity.verify(linkToken);
    if (!result.ok && result.reason === "unknown_key" && (await identity.refresh())) result = identity.verify(linkToken);
    if (!result.ok || result.claims.scope !== "link") {
      const why = result.ok ? "it can't link this server." : VERIFY_FAILURE_MESSAGES[result.reason];
      this.log("warn", `legato.fm: someone claimed this server, but legato.fm's answer didn't check out: ${why}`);
      this.notice = {
        state: "refused",
        message: `Someone claimed this server, but legato.fm's answer didn't check out: ${why} Scan the new code to try again.`,
      };
      this.options.setupCodes.replace();
      return;
    }
    const { sub, name, email, exp } = result.claims;
    this.pending = { linkToken, account: { id: sub, name, email: maskEmail(email) }, lapsesAt: exp * 1000 - LAPSE_MARGIN_MS };
    this.notice = null;
    this.log("info", "legato.fm: someone claimed this server; creating the owner on /setup can link their account");
  }
}
