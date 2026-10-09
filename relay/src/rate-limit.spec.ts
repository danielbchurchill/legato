import { describe, expect, it, setSystemTime } from "bun:test";
import {
  addressBlock,
  ASK_WINDOW_MS,
  ASKS_PER_WINDOW,
  clientAddress,
  CODE_MEMORY_MS,
  ExchangeLimiter,
  FREE_CODES,
  MAX_ADDRESSES,
  TokenLimiter,
} from "./rate-limit.js";

// Issue #324: the brake on asking about pairing codes at POST /pair/exchange,
// and the one on failed native sign-ins at POST /auth/token. Every code
// asked about here is one the relay has no claim of for the server asking,
// as the route would find it.

const ADDRESS = "203.0.113.9";

function clock() {
  let now = 1_000_000;
  const limiter = new ExchangeLimiter(() => now);
  return { limiter, advance: (ms: number) => (now += ms) };
}

// Asks about new codes until the address is locked out of them: past
// FREE_CODES, counting any it asked about before, for a minute the first
// time. Its last ask was answered, so the lockout is the full minute.
function lockOut(limiter: ExchangeLimiter, address: string) {
  let i = 0;
  while (limiter.ask(address, `GUESS-${i}`) === 0) i++;
  expect(i).toBeLessThanOrEqual(FREE_CODES + 1);
  expect(limiter.ask(address, "GUESS-NEXT")).toBe(60);
}

// A /setup page's server, as server/src/auth/claim.ts asks: every five
// seconds at most, about its live code, and for two minutes after that
// changes, about the one it replaced. Its code changes every ten minutes.
function serverCodes(name: string, age: number): string[] {
  const TTL_MS = 10 * 60_000;
  const GRACE_MS = 2 * 60_000;
  const live = Math.floor(age / TTL_MS);
  const codes = [`${name}-${live}`];
  if (live > 0 && age - live * TTL_MS < GRACE_MS) codes.push(`${name}-${live - 1}`);
  return codes;
}

describe("ExchangeLimiter", () => {
  it("counts a server asking about its own code every five seconds as one code", () => {
    const { limiter, advance } = clock();
    for (let t = 0; t < 12 * 60_000; t += 5_000) {
      expect(limiter.ask(ADDRESS, "K7QM-4XRD")).toBe(0);
      advance(5_000);
    }
    // One code spent of FREE_CODES: the rest are still free.
    for (let i = 1; i <= FREE_CODES; i++) expect(limiter.ask(ADDRESS, `AAAA-${i}`)).toBe(0);
    expect(limiter.ask(ADDRESS, "AAAA-NEXT")).toBeGreaterThan(0);
  });

  it("lets ten servers behind one address ask for an hour while their codes change, out of step", () => {
    const { limiter, advance } = clock();
    // Each /setup page opens nine minutes into a code's life, the worst
    // case: three codes in the first fifteen minutes.
    const servers = Array.from({ length: 10 }, (_, i) => ({ name: `S${i}`, bornAt: -9 * 60_000 - i * 7_000 }));
    const refused: string[] = [];
    for (let t = 0; t < 60 * 60_000; t += 5_000) {
      for (const server of servers) {
        for (const code of serverCodes(server.name, t - server.bornAt)) {
          if (limiter.ask(ADDRESS, code) > 0) refused.push(`${code} at ${t / 1000}s`);
        }
      }
      advance(5_000);
    }
    expect(refused).toEqual([]);
  });

  it("lets ten servers behind one address ask for an hour in step, two codes each for two minutes in ten", () => {
    const { limiter, advance } = clock();
    const refused: string[] = [];
    let busiestMinute = 0;
    for (let minute = 0; minute < 60; minute++) {
      let asks = 0;
      for (let t = minute * 60_000; t < (minute + 1) * 60_000; t += 5_000) {
        for (let s = 0; s < 10; s++) {
          for (const code of serverCodes(`S${s}`, t + 9 * 60_000)) {
            asks++;
            if (limiter.ask(ADDRESS, code) > 0) refused.push(`${code} at ${t / 1000}s`);
          }
        }
        advance(5_000);
      }
      busiestMinute = Math.max(busiestMinute, asks);
    }
    expect(refused).toEqual([]);
    expect(busiestMinute).toBe(240);
    expect(busiestMinute).toBeLessThan(ASKS_PER_WINDOW);
  });

  it(`locks an address out of new codes past ${FREE_CODES}, for a minute and then doubling`, () => {
    const { limiter, advance } = clock();
    for (let i = 0; i < FREE_CODES; i++) expect(limiter.ask(ADDRESS, `AAAA-${i}`)).toBe(0);
    expect(limiter.ask(ADDRESS, "BBBB-0")).toBe(0);
    expect(limiter.ask(ADDRESS, "BBBB-1")).toBe(60);
    advance(60_000);
    expect(limiter.ask(ADDRESS, "BBBB-1")).toBe(0);
    expect(limiter.ask(ADDRESS, "BBBB-2")).toBe(120);
    advance(120_000);
    expect(limiter.ask(ADDRESS, "BBBB-2")).toBe(0);
    expect(limiter.ask(ADDRESS, "BBBB-3")).toBe(240);

    // Locked out, it's still answered about the codes it already asked
    // about, and no other address is held to its guesses.
    expect(limiter.ask(ADDRESS, "AAAA-0")).toBe(0);
    expect(limiter.ask("198.51.100.4", "BBBB-3")).toBe(0);
  });

  // Asking again about a code it already asked about is never free: a loop
  // over the same few bogus codes is held to the same rate as anything else.
  it(`answers at most ${ASKS_PER_WINDOW} asks from an address in a minute, repeats included`, () => {
    const { limiter, advance } = clock();
    for (let i = 0; i < ASKS_PER_WINDOW; i++) expect(limiter.ask(ADDRESS, `LOOP-${i % FREE_CODES}`)).toBe(0);
    expect(limiter.ask(ADDRESS, "LOOP-0")).toBe(ASK_WINDOW_MS / 1000);
    expect(limiter.ask(ADDRESS, "NEW-CODE")).toBe(ASK_WINDOW_MS / 1000);
    // Refused asks don't count, so asking on doesn't stretch the wait.
    advance(30_000);
    for (let i = 0; i < 1_000; i++) limiter.ask(ADDRESS, "LOOP-0");
    expect(limiter.ask(ADDRESS, "LOOP-0")).toBe(30);
    advance(30_000);
    expect(limiter.ask(ADDRESS, "LOOP-0")).toBe(0);
    // Another address has its own minute.
    expect(limiter.ask("198.51.100.4", "LOOP-0")).toBe(0);
  });

  it("forgets an address's codes, and its lockout, fifteen minutes after it first asked", () => {
    const { limiter, advance } = clock();
    for (let i = 0; i <= FREE_CODES; i++) limiter.ask(ADDRESS, `AAAA-${i}`);
    expect(limiter.ask(ADDRESS, "BBBB-0")).toBeGreaterThan(0);
    advance(CODE_MEMORY_MS);
    // Its old codes are new again, and free again.
    for (let i = 0; i < FREE_CODES; i++) expect(limiter.ask(ADDRESS, `AAAA-${i}`)).toBe(0);
    expect(limiter.ask(ADDRESS, "BBBB-0")).toBe(0);
  });

  it("has no global cap: however many addresses are held back, another's first ask is answered", () => {
    const { limiter } = clock();
    for (let a = 0; a < 200; a++) lockOut(limiter, `10.0.${a >> 8}.${a & 255}`);
    expect(limiter.ask("198.51.100.4", "K7QM-4XRD")).toBe(0);
  });

  it("holds a whole IPv6 /64 to one allowance, and no more than that /64", () => {
    const { limiter } = clock();
    lockOut(limiter, "2001:db8:1:2::1");
    for (const sameBlock of ["2001:db8:1:2::2", "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:0DB8:0001:0002:0:0:0:9", "2001:db8:1:2::3%en0"]) {
      expect(limiter.ask(sameBlock, "GUESS-NEXT")).toBe(60);
    }
    for (const otherBlock of ["2001:db8:1:3::1", "2001:db8::1", "203.0.113.9"]) {
      expect(limiter.ask(otherBlock, "GUESS-NEXT")).toBe(0);
    }
  });

  it("counts an IPv4 address the same however the socket reports it", () => {
    const { limiter } = clock();
    lockOut(limiter, "::ffff:203.0.113.9");
    expect(limiter.ask("203.0.113.9", "GUESS-NEXT")).toBe(60);
    expect(limiter.ask("203.0.113.10", "GUESS-NEXT")).toBe(0);
  });

  it("keeps answering a server behind a locked-out address, and asks its next code to wait out the lockout", () => {
    const { limiter, advance } = clock();
    // The server's /setup page is open, asking about its code.
    expect(limiter.ask(ADDRESS, "AAAA-AAAA")).toBe(0);
    // Something else on its network guesses its way into a lockout.
    advance(60_000);
    lockOut(limiter, ADDRESS);
    advance(5_000);
    expect(limiter.ask(ADDRESS, "AAAA-AAAA")).toBe(0);

    // The code changes. The new one is new to the relay, so it waits out
    // the rest of the minute, while the one it replaced is still answered.
    // (Once someone claims either, routes/pair.ts answers it before asking
    // this at all.)
    const wait = limiter.ask(ADDRESS, "BBBB-BBBB");
    expect(wait).toBe(55);
    expect(limiter.ask(ADDRESS, "AAAA-AAAA")).toBe(0);
    advance(wait * 1000);
    expect(limiter.ask(ADDRESS, "BBBB-BBBB")).toBe(0);
    // And from then on it's a code this address asked about.
    advance(10 * 60_000);
    expect(limiter.ask(ADDRESS, "BBBB-BBBB")).toBe(0);
  });

  it("doesn't count a code it already knows as new again, or move when it was first asked", () => {
    const { limiter, advance } = clock();
    expect(limiter.ask(ADDRESS, "K7QM-4XRD")).toBe(0);
    for (let i = 0; i < 100; i++) limiter.ask(ADDRESS, "K7QM-4XRD");
    for (let i = 1; i <= FREE_CODES; i++) expect(limiter.ask(ADDRESS, `AAAA-${i}`)).toBe(0);
    expect(limiter.ask(ADDRESS, "AAAA-NEXT")).toBe(60);
    // Fifteen minutes from the first ask, however often it was asked since.
    advance(CODE_MEMORY_MS);
    expect(limiter.ask(ADDRESS, "AAAA-NEXT")).toBe(0);
  });

  // Issue #324: asking from thousands of other addresses mustn't push a
  // locked-out one out of memory, handing it a fresh allowance.
  describe(`at ${MAX_ADDRESSES} addresses`, () => {
    const other = (a: number) => `10.${a >> 16}.${(a >> 8) & 255}.${a & 255}`;

    it("lets the least recently used address go first, and keeps one that's locked out", () => {
      const { limiter } = clock();
      lockOut(limiter, ADDRESS);
      for (let a = 0; a < MAX_ADDRESSES - 1; a++) limiter.ask(other(a), "K7QM-4XRD");
      // other(0) asks again, so other(1) is now the one used longest ago.
      limiter.ask(other(0), "K7QM-4XRD");
      for (let a = 0; a < 100; a++) limiter.ask(`198.51.${a >> 8}.${a & 255}`, "K7QM-4XRD");

      expect(limiter.ask(ADDRESS, "GUESS-NEXT")).toBe(60);
      // other(0) was remembered: its code isn't new, so another 30 lock it out.
      for (let i = 0; i < FREE_CODES - 1; i++) expect(limiter.ask(other(0), `NEW-${i}`)).toBe(0);
      expect(limiter.ask(other(0), "NEW-LAST")).toBe(0);
      expect(limiter.ask(other(0), "NEW-NEXT")).toBe(60);
      // other(1) wasn't: it starts again from nothing.
      for (let i = 0; i < FREE_CODES; i++) expect(limiter.ask(other(1), `NEW-${i}`)).toBe(0);
      expect(limiter.ask(other(1), "NEW-LAST")).toBe(0);
    });

    it("keeps a record that's held back by its minute's asks too", () => {
      const { limiter } = clock();
      for (let i = 0; i < ASKS_PER_WINDOW; i++) limiter.ask(ADDRESS, "LOOP-0");
      for (let a = 0; a < MAX_ADDRESSES + 100; a++) limiter.ask(other(a), "K7QM-4XRD");
      expect(limiter.ask(ADDRESS, "LOOP-0")).toBe(60);
    });

    it("lets the least recently used locked-out address go only once every address is locked out", () => {
      const { limiter } = clock();
      lockOut(limiter, ADDRESS);
      for (let a = 0; a < MAX_ADDRESSES - 1; a++) lockOut(limiter, other(a));
      lockOut(limiter, other(MAX_ADDRESSES));
      expect(limiter.ask(other(0), "GUESS-NEXT")).toBe(60);
      expect(limiter.ask(ADDRESS, "GUESS-NEXT")).toBe(0);
    });
  });

  it("keeps time by a clock the wall clock can't move", () => {
    const limiter = new ExchangeLimiter();
    lockOut(limiter, ADDRESS);
    try {
      setSystemTime(new Date(Date.now() + 24 * 60 * 60_000));
      expect(limiter.ask(ADDRESS, "GUESS-NEXT")).toBeGreaterThan(55);
    } finally {
      setSystemTime();
    }
  });
});

describe("TokenLimiter", () => {
  function tokenClock() {
    let now = 1_000_000;
    const limiter = new TokenLimiter(() => now);
    return { limiter, advance: (ms: number) => (now += ms) };
  }

  function fail(limiter: TokenLimiter, address: string, times: number) {
    for (let i = 0; i < times; i++) limiter.recordFailure(address);
  }

  it("locks an address out after five failures, for a minute and then doubling, until a success", () => {
    const { limiter, advance } = tokenClock();
    fail(limiter, ADDRESS, 4);
    expect(limiter.retryAfterSeconds(ADDRESS)).toBe(0);
    fail(limiter, ADDRESS, 1);
    expect(limiter.retryAfterSeconds(ADDRESS)).toBe(60);
    advance(60_000);
    fail(limiter, ADDRESS, 1);
    expect(limiter.retryAfterSeconds(ADDRESS)).toBe(120);
    limiter.recordSuccess(ADDRESS);
    expect(limiter.retryAfterSeconds(ADDRESS)).toBe(0);
  });

  // Issue #324, review: 30 failures a minute from anywhere used to lock out
  // every account's native sign-in.
  it("has no global cap: however many addresses are locked out, another isn't", () => {
    const { limiter } = tokenClock();
    for (let a = 0; a < 200; a++) fail(limiter, `10.0.${a >> 8}.${a & 255}`, 5);
    expect(limiter.retryAfterSeconds("10.0.0.0")).toBe(60);
    expect(limiter.retryAfterSeconds("198.51.100.4")).toBe(0);
    fail(limiter, "198.51.100.4", 4);
    expect(limiter.retryAfterSeconds("198.51.100.4")).toBe(0);
  });

  it("holds a whole IPv6 /64 to one allowance", () => {
    const { limiter } = tokenClock();
    for (let i = 1; i <= 5; i++) limiter.recordFailure(`2001:db8:1:2::${i}`);
    expect(limiter.retryAfterSeconds("2001:db8:1:2::ffff")).toBe(60);
    expect(limiter.retryAfterSeconds("2001:db8:1:3::1")).toBe(0);
    limiter.recordSuccess("2001:db8:1:2::9");
    expect(limiter.retryAfterSeconds("2001:db8:1:2::1")).toBe(0);
  });

  it(`remembers at most ${MAX_ADDRESSES} addresses, and keeps one that's locked out`, () => {
    const { limiter } = tokenClock();
    fail(limiter, ADDRESS, 5);
    fail(limiter, "198.51.100.4", 1);
    for (let a = 0; a < MAX_ADDRESSES; a++) limiter.recordFailure(`10.${a >> 16}.${(a >> 8) & 255}.${a & 255}`);
    expect(limiter.retryAfterSeconds(ADDRESS)).toBe(60);
    // Its one failure was forgotten to make room: four more don't lock it out.
    fail(limiter, "198.51.100.4", 4);
    expect(limiter.retryAfterSeconds("198.51.100.4")).toBe(0);
  });

  it("keeps time by a clock the wall clock can't move", () => {
    const limiter = new TokenLimiter();
    fail(limiter, ADDRESS, 5);
    try {
      setSystemTime(new Date(Date.now() + 24 * 60 * 60_000));
      expect(limiter.retryAfterSeconds(ADDRESS)).toBeGreaterThan(55);
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
