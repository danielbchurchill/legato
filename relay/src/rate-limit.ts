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
//     many addresses doesn't buy a faster rate.
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

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds until this address may try again, or 0 if it may now. */
  retryAfterSeconds(address: string): number {
    const now = this.now();
    this.globalFailures = this.globalFailures.filter((at) => at > now - GLOBAL_WINDOW_MS);
    let waitMs = 0;
    if (this.globalFailures.length >= GLOBAL_MAX_FAILURES) {
      waitMs = this.globalFailures[0]! + GLOBAL_WINDOW_MS - now;
    }
    const record = this.byAddress.get(address);
    if (record && record.lockedUntil > now) waitMs = Math.max(waitMs, record.lockedUntil - now);
    return Math.ceil(waitMs / 1000);
  }

  recordFailure(address: string): void {
    const now = this.now();
    this.globalFailures.push(now);
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

// Behind Fly's proxy every request's socket peer is the proxy itself, so
// request.ip alone would put every client in one bucket. Fly sets
// Fly-Client-IP to the real peer on every request it forwards. Off Fly
// (loopback dev, tests) the header is absent and the socket peer is right.
export function clientAddress(headers: Record<string, string | string[] | undefined>, socketIp: string): string {
  const fly = headers["fly-client-ip"];
  return (Array.isArray(fly) ? fly[0] : fly) || socketIp;
}
