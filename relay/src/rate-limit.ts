// Brute-force brake for POST /auth/token. The same shape as server/'s
// SignInLimiter (server/src/auth/rateLimit.ts); relay/ is its own package
// and can't import from server/, so this is a copy, not a share. A
// sign-in code is 32 random bytes and lives 60 seconds, so guessing one
// is already hopeless; this keeps a script from even trying at speed.
// In memory on purpose: a restart clearing it costs an attacker a restart
// they can't trigger, and a failed guess never becomes a database write.
//
// Two layers:
//   * per client address: 5 free failures, then a lockout that starts at
//     one minute and doubles on every further failure, capped at 15;
//   * across all addresses: more than 30 failures in a minute locks
//     everyone out until the window drains, so spreading guesses over
//     many addresses doesn't buy a faster rate. A brake can leave this
//     layer out (POST /link/redeem does, routes/link-page.ts).
// A success clears that address's record.

const FREE_FAILURES = 5;
const FIRST_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_FAILURES = 30;

type AddressRecord = { failures: number; lockedUntil: number };

export class TokenLimiter {
  private readonly byAddress = new Map<string, AddressRecord>();
  private globalFailures: number[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: { global: boolean } = { global: true },
  ) {}

  /** Seconds until this address may try again, or 0 if it may now. */
  retryAfterSeconds(address: string): number {
    const now = this.now();
    this.globalFailures = this.globalFailures.filter((at) => at > now - GLOBAL_WINDOW_MS);
    let waitMs = 0;
    if (this.options.global && this.globalFailures.length >= GLOBAL_MAX_FAILURES) {
      waitMs = this.globalFailures[0]! + GLOBAL_WINDOW_MS - now;
    }
    const record = this.byAddress.get(address);
    if (record && record.lockedUntil > now) waitMs = Math.max(waitMs, record.lockedUntil - now);
    return Math.ceil(waitMs / 1000);
  }

  recordFailure(address: string): void {
    const now = this.now();
    if (this.options.global) this.globalFailures.push(now);
    const record = this.byAddress.get(address) ?? { failures: 0, lockedUntil: 0 };
    record.failures++;
    if (record.failures >= FREE_FAILURES) {
      const doublings = record.failures - FREE_FAILURES;
      record.lockedUntil = now + Math.min(MAX_LOCKOUT_MS, FIRST_LOCKOUT_MS * 2 ** doublings);
    }
    this.byAddress.set(address, record);
  }

  recordSuccess(address: string): void {
    this.byAddress.delete(address);
  }
}

// The same brake for POST /pair/exchange (issue #324). Whoever calls it
// needs a claim proof, but a server key costs nothing to make, so the
// 40-bit pairing code is all that stands between a script and a claim
// someone made for their own server. Here a failure is a code this relay
// doesn't know, and only a new one: a home server asks about its own code
// every five seconds while its /setup page is open and gets a 404 every
// time until someone claims it. So each address remembers the unknown codes
// it asked about, for CODE_MEMORY_MS from the first time, and asking about
// one of those again is free and never refused.
//
// Two layers, as for /auth/token:
//   * per client address: FREE_CODES remembered codes are free; each new
//     one past them locks the address out of new codes for a minute,
//     doubling with each further one, up to fifteen. Codes it already
//     asked about still get answered, so a server polling its own code
//     keeps working behind an address someone else tripped;
//   * across all addresses: GLOBAL_MAX_CODES new unknown codes in a minute
//     lock everyone out of new codes until the window drains. That's twice
//     FREE_CODES, so no one address can trip it alone.
// A code that turns out to be known (claimed, used or expired) counts for
// nothing either way.

// A server asks about one code for at most twelve minutes: ten while it's
// live, two more as the code it replaced (server/src/auth/claim.ts). So
// until it restarts it brings at most three codes in any fifteen minutes
// (when /setup opens late in a code's life), and ten servers behind one
// address fit in FREE_CODES.
export const CODE_MEMORY_MS = 15 * 60_000;
export const FREE_CODES = 30;
const GLOBAL_MAX_CODES = 2 * FREE_CODES;

type ExchangeRecord = { codes: Map<string, number>; lockedUntil: number };

export class ExchangeLimiter {
  private readonly byAddress = new Map<string, ExchangeRecord>();
  private globalCodes: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds until this address may ask about this code, or 0 if it may now. */
  retryAfterSeconds(address: string, code: string): number {
    const now = this.now();
    const record = this.record(address, now);
    if (record?.codes.has(code)) return 0;
    this.globalCodes = this.globalCodes.filter((at) => at > now - GLOBAL_WINDOW_MS);
    let waitMs = 0;
    if (this.globalCodes.length >= GLOBAL_MAX_CODES) {
      waitMs = this.globalCodes[0]! + GLOBAL_WINDOW_MS - now;
    }
    if (record && record.lockedUntil > now) waitMs = Math.max(waitMs, record.lockedUntil - now);
    return Math.ceil(waitMs / 1000);
  }

  /** This relay has no such code. */
  recordUnknown(address: string, code: string): void {
    const now = this.now();
    this.forget(now);
    const record = this.byAddress.get(address) ?? { codes: new Map<string, number>(), lockedUntil: 0 };
    if (record.codes.has(code)) return;
    record.codes.set(code, now);
    this.globalCodes.push(now);
    if (record.codes.size > FREE_CODES) {
      const doublings = record.codes.size - FREE_CODES - 1;
      record.lockedUntil = now + Math.min(MAX_LOCKOUT_MS, FIRST_LOCKOUT_MS * 2 ** doublings);
    }
    this.byAddress.set(address, record);
  }

  // A lockout never outlasts the code that set it, so a record with no
  // codes left has nothing more to say.
  private record(address: string, now: number): ExchangeRecord | undefined {
    const record = this.byAddress.get(address);
    if (!record) return undefined;
    for (const [code, firstAskedAt] of record.codes) {
      if (firstAskedAt <= now - CODE_MEMORY_MS) record.codes.delete(code);
    }
    if (record.codes.size > 0) return record;
    this.byAddress.delete(address);
    return undefined;
  }

  private forget(now: number): void {
    for (const address of this.byAddress.keys()) this.record(address, now);
  }
}

// Behind Fly's proxy every request's socket peer is the proxy itself, so
// request.ip alone would put every client in one bucket. Fly sets
// Fly-Client-IP to the real peer on every request it forwards. Off Fly
// (loopback dev, tests) the header is absent and the socket peer is right.
export function clientAddress(headers: Record<string, string | string[] | undefined>, socketIp: string): string {
  const fly = headers["fly-client-ip"];
  return (Array.isArray(fly) ? fly[0] : fly) || socketIp;
}
