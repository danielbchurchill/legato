// Brute-force brake for the two places a guessed secret gets checked: the
// owner password (POST /auth/sign-in) and the setup code (POST
// /auth/owner). In memory on purpose — a restart clearing it costs an
// attacker a restart, which they can't trigger, and it keeps a failed
// guess from being a database write.
//
// Two layers:
//   * per client address: 5 free failures, then a lockout that starts at
//     one minute and doubles on every further failure, capped at 15;
//   * across all addresses: more than 30 failures in a minute locks
//     everyone out until the window drains, so spreading guesses over
//     many addresses on a tailnet or LAN doesn't buy a faster rate.
// A success clears that address's record.

const FREE_FAILURES = 5;
const FIRST_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_FAILURES = 30;

type Record = { failures: number; lockedUntil: number };

export class SignInLimiter {
  private readonly byAddress = new Map<string, Record>();
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
