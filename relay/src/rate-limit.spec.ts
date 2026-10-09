import { describe, expect, it } from "bun:test";
import { CODE_MEMORY_MS, ExchangeLimiter, FREE_CODES } from "./rate-limit.js";

// Issue #324: the brake on guessing pairing codes at POST /pair/exchange.
// Every code asked about here is one the relay doesn't know, as the route
// would find it.

const ADDRESS = "203.0.113.9";

function clock() {
  let now = 1_000_000;
  const limiter = new ExchangeLimiter(() => now);
  return { limiter, advance: (ms: number) => (now += ms) };
}

// What the route does: refuse, or look the code up and find nothing.
function ask(limiter: ExchangeLimiter, address: string, code: string): number {
  const wait = limiter.retryAfterSeconds(address, code);
  if (wait === 0) limiter.recordUnknown(address, code);
  return wait;
}

describe("ExchangeLimiter", () => {
  it("counts a server asking about its own code every five seconds once", () => {
    const { limiter, advance } = clock();
    for (let t = 0; t < 12 * 60_000; t += 5_000) {
      expect(ask(limiter, ADDRESS, "K7QM-4XRD")).toBe(0);
      advance(5_000);
    }
    // One code spent of FREE_CODES: the rest are still free.
    for (let i = 1; i < FREE_CODES; i++) expect(ask(limiter, ADDRESS, `AAAA-${i}`)).toBe(0);
    expect(ask(limiter, ADDRESS, "AAAA-LAST")).toBe(0);
    expect(limiter.retryAfterSeconds(ADDRESS, "AAAA-NEXT")).toBeGreaterThan(0);
  });

  it("lets ten servers behind one address ask for an hour while their codes change", () => {
    const { limiter, advance } = clock();
    const TTL_MS = 10 * 60_000;
    const GRACE_MS = 2 * 60_000;
    // Each server's code changes every ten minutes, out of step with the
    // others, and each /setup page opens nine minutes into a code's life:
    // the worst case, three codes in the first fifteen minutes.
    const servers = Array.from({ length: 10 }, (_, i) => ({ name: `S${i}`, bornAt: -9 * 60_000 - i * 7_000 }));
    const refused: string[] = [];
    for (let t = 0; t < 60 * 60_000; t += 5_000) {
      for (const server of servers) {
        const age = t - server.bornAt;
        const live = Math.floor(age / TTL_MS);
        // claimable(): the live code, and the one it replaced for two minutes.
        const codes = [`${server.name}-${live}`];
        if (live > 0 && age - live * TTL_MS < GRACE_MS) codes.push(`${server.name}-${live - 1}`);
        for (const code of codes) if (ask(limiter, ADDRESS, code) > 0) refused.push(`${code} at ${t / 1000}s`);
      }
      advance(5_000);
    }
    expect(refused).toEqual([]);
  });

  it(`locks an address out of new codes past ${FREE_CODES}, for a minute and then doubling`, () => {
    const { limiter, advance } = clock();
    for (let i = 0; i < FREE_CODES; i++) expect(ask(limiter, ADDRESS, `AAAA-${i}`)).toBe(0);
    expect(ask(limiter, ADDRESS, "BBBB-0")).toBe(0);
    expect(limiter.retryAfterSeconds(ADDRESS, "BBBB-1")).toBe(60);
    advance(60_000);
    expect(ask(limiter, ADDRESS, "BBBB-1")).toBe(0);
    expect(limiter.retryAfterSeconds(ADDRESS, "BBBB-2")).toBe(120);
    advance(120_000);
    expect(ask(limiter, ADDRESS, "BBBB-2")).toBe(0);
    expect(limiter.retryAfterSeconds(ADDRESS, "BBBB-3")).toBe(240);

    // Locked out, it's still answered about the codes it already asked
    // about, and no other address is held to its guesses.
    expect(limiter.retryAfterSeconds(ADDRESS, "AAAA-0")).toBe(0);
    expect(limiter.retryAfterSeconds("198.51.100.4", "BBBB-3")).toBe(0);
  });

  it("forgets an address's codes, and its lockout, fifteen minutes after it first asked", () => {
    const { limiter, advance } = clock();
    for (let i = 0; i <= FREE_CODES; i++) ask(limiter, ADDRESS, `AAAA-${i}`);
    expect(limiter.retryAfterSeconds(ADDRESS, "BBBB-0")).toBeGreaterThan(0);
    advance(CODE_MEMORY_MS);
    expect(limiter.retryAfterSeconds(ADDRESS, "BBBB-0")).toBe(0);
    // Its old codes are new again, and free again.
    for (let i = 0; i < FREE_CODES; i++) expect(ask(limiter, ADDRESS, `AAAA-${i}`)).toBe(0);
    expect(limiter.retryAfterSeconds(ADDRESS, "BBBB-0")).toBe(0);
  });

  it(`locks every address out of new codes after ${2 * FREE_CODES} in a minute, but answers the ones each asked about`, () => {
    const { limiter, advance } = clock();
    for (let i = 0; i < 2 * FREE_CODES; i++) expect(ask(limiter, `198.51.100.${i}`, `AAAA-${i}`)).toBe(0);
    expect(limiter.retryAfterSeconds("203.0.113.200", "BBBB-0")).toBe(60);
    expect(limiter.retryAfterSeconds("198.51.100.0", "BBBB-0")).toBe(60);
    expect(limiter.retryAfterSeconds("198.51.100.0", "AAAA-0")).toBe(0);
    advance(60_000);
    expect(limiter.retryAfterSeconds("203.0.113.200", "BBBB-0")).toBe(0);
  });
});
