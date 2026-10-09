import { describe, expect, it, setSystemTime } from "bun:test";
import { addressBlock, clientAddress, CODE_MEMORY_MS, ExchangeLimiter, FREE_CODES, MAX_ADDRESSES } from "./rate-limit.js";

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

// Guesses until the address is locked out of new codes: past FREE_CODES,
// counting any it asked about before, for a minute the first time.
function lockOut(limiter: ExchangeLimiter, address: string) {
  for (let i = 0; i <= FREE_CODES && limiter.retryAfterSeconds(address, "GUESS-NEXT") === 0; i++) {
    expect(ask(limiter, address, `GUESS-${i}`)).toBe(0);
  }
  expect(limiter.retryAfterSeconds(address, "GUESS-NEXT")).toBe(60);
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

  it("has no global cap: however many addresses guess, another's first ask is answered", () => {
    const { limiter } = clock();
    for (let a = 0; a < 200; a++) for (let i = 0; i <= FREE_CODES; i++) ask(limiter, `10.0.${a >> 8}.${a & 255}`, `GUESS-${i}`);
    expect(limiter.retryAfterSeconds("10.0.0.0", "GUESS-NEXT")).toBe(60);
    expect(ask(limiter, "198.51.100.4", "K7QM-4XRD")).toBe(0);
  });

  it("holds a whole IPv6 /64 to one allowance, and no more than that /64", () => {
    const { limiter } = clock();
    lockOut(limiter, "2001:db8:1:2::1");
    for (const sameBlock of ["2001:db8:1:2::2", "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:0DB8:0001:0002:0:0:0:9", "2001:db8:1:2::3%en0"]) {
      expect(limiter.retryAfterSeconds(sameBlock, "GUESS-NEXT")).toBe(60);
    }
    for (const otherBlock of ["2001:db8:1:3::1", "2001:db8::1", "203.0.113.9"]) {
      expect(limiter.retryAfterSeconds(otherBlock, "GUESS-NEXT")).toBe(0);
    }
  });

  it("counts an IPv4 address the same however the socket reports it", () => {
    const { limiter } = clock();
    lockOut(limiter, "::ffff:203.0.113.9");
    expect(limiter.retryAfterSeconds("203.0.113.9", "GUESS-NEXT")).toBe(60);
    expect(limiter.retryAfterSeconds("203.0.113.10", "GUESS-NEXT")).toBe(0);
  });

  it("keeps answering a server behind a locked-out address, and asks its next code to wait out the lockout", () => {
    const { limiter, advance } = clock();
    // The server's /setup page is open, asking about its code.
    expect(ask(limiter, ADDRESS, "AAAA-AAAA")).toBe(0);
    // Something else on its network guesses its way into a lockout.
    advance(60_000);
    lockOut(limiter, ADDRESS);
    advance(5_000);
    expect(ask(limiter, ADDRESS, "AAAA-AAAA")).toBe(0);

    // The code changes. The new one is new to the relay, so it waits out
    // the rest of the minute, while the one it replaced is still answered.
    const wait = ask(limiter, ADDRESS, "BBBB-BBBB");
    expect(wait).toBe(55);
    expect(ask(limiter, ADDRESS, "AAAA-AAAA")).toBe(0);
    advance(wait * 1000);
    expect(ask(limiter, ADDRESS, "BBBB-BBBB")).toBe(0);
    // And from then on it's a code this address asked about.
    advance(10 * 60_000);
    expect(ask(limiter, ADDRESS, "BBBB-BBBB")).toBe(0);
  });

  it("doesn't count a code it already knows again, or move when it was first asked", () => {
    const { limiter, advance } = clock();
    expect(ask(limiter, ADDRESS, "K7QM-4XRD")).toBe(0);
    for (let i = 0; i < 100; i++) limiter.recordUnknown(ADDRESS, "K7QM-4XRD");
    for (let i = 1; i <= FREE_CODES; i++) expect(ask(limiter, ADDRESS, `AAAA-${i}`)).toBe(0);
    expect(limiter.retryAfterSeconds(ADDRESS, "AAAA-NEXT")).toBe(60);
    // Fifteen minutes from the first ask, however often it was asked since.
    advance(CODE_MEMORY_MS);
    expect(limiter.retryAfterSeconds(ADDRESS, "AAAA-NEXT")).toBe(0);
  });

  it(`remembers at most ${MAX_ADDRESSES} addresses, letting the oldest go first`, () => {
    const { limiter } = clock();
    lockOut(limiter, ADDRESS);
    for (let a = 0; a < MAX_ADDRESSES - 1; a++) ask(limiter, `10.${a >> 16}.${(a >> 8) & 255}.${a & 255}`, "K7QM-4XRD");
    expect(limiter.retryAfterSeconds(ADDRESS, "GUESS-NEXT")).toBe(60);
    ask(limiter, "198.51.100.4", "K7QM-4XRD");
    expect(limiter.retryAfterSeconds(ADDRESS, "GUESS-NEXT")).toBe(0);
  });

  it("keeps time by a clock the wall clock can't move", () => {
    const limiter = new ExchangeLimiter();
    lockOut(limiter, ADDRESS);
    try {
      setSystemTime(new Date(Date.now() + 24 * 60 * 60_000));
      expect(limiter.retryAfterSeconds(ADDRESS, "GUESS-NEXT")).toBeGreaterThan(55);
    } finally {
      setSystemTime();
    }
  });
});

describe("addressBlock", () => {
  it("is an IPv4 address itself, and an IPv6 address's /64", () => {
    expect(addressBlock("203.0.113.9")).toBe("203.0.113.9");
    expect(addressBlock("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressBlock("::FFFF:cb00:7109")).toBe("203.0.113.9");
    expect(addressBlock("0:0:0:0:0:ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressBlock("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(addressBlock("2001:0db8:0001:0002::")).toBe("2001:db8:1:2::/64");
    expect(addressBlock("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(addressBlock("::1")).toBe("0:0:0:0::/64");
    expect(addressBlock("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(addressBlock("64:ff9b::203.0.113.9")).toBe("64:ff9b:0:0::/64");
    expect(addressBlock("1:2:3:4:5:6:203.0.113.9")).toBe("1:2:3:4::/64");
  });
});

describe("clientAddress", () => {
  const headers = { "fly-client-ip": "198.51.100.4" };

  it("is Fly-Client-IP on Fly, where Fly's proxy writes it", () => {
    expect(clientAddress(headers, "172.16.0.2", true)).toBe("198.51.100.4");
    expect(clientAddress({}, "172.16.0.2", true)).toBe("172.16.0.2");
  });

  it("is the socket's peer anywhere else, whatever the header says", () => {
    expect(clientAddress(headers, "203.0.113.9", false)).toBe("203.0.113.9");
  });
});
