import { describe, expect, it } from "bun:test";
import type { FastifyRequest } from "fastify";
import { CODE_ALPHABET, generateCode, maySeeSetupCode, normalizeCode, SetupCodes } from "./setupCode.js";

const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

describe("generateCode", () => {
  it("makes eight Crockford base32 characters with a dash in the middle", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(CODE_PATTERN);
  });

  it("never uses the letters Crockford drops", () => {
    expect(CODE_ALPHABET).toHaveLength(32);
    for (const letter of "ILOU") expect(CODE_ALPHABET).not.toContain(letter);
  });
});

describe("normalizeCode", () => {
  it("accepts lowercase, a missing dash and stray spaces", () => {
    expect(normalizeCode("k7qm-4xrd")).toBe("K7QM-4XRD");
    expect(normalizeCode("K7QM4XRD")).toBe("K7QM-4XRD");
    expect(normalizeCode(" k7qm 4xrd ")).toBe("K7QM-4XRD");
  });

  it("reads O as 0 and I or L as 1", () => {
    expect(normalizeCode("OOII-LL00")).toBe("0011-1100");
    expect(normalizeCode("ioli-oLIo")).toBe("1011-0110");
  });

  it("rejects anything that can't be a code", () => {
    for (const bad of ["", "K7QM-4XR", "K7QM-4XRDX", "K7QM-4XRU", "K7QM_4XRD", null, undefined, 12345678]) {
      expect(normalizeCode(bad)).toBeNull();
    }
  });
});

function onFakeClock(codes: string[]) {
  const clock = { now: 1_000_000 };
  const issued: Array<[string, string | null]> = [];
  const store = new SetupCodes({ ttlMs: 600_000, now: () => clock.now, generate: () => codes.shift()! });
  store.onIssue(({ code }, replaced) => issued.push([code, replaced]));
  return { clock, issued, store };
}

describe("SetupCodes", () => {
  it("keeps one code until it expires", () => {
    const { clock, store } = onFakeClock(["AAAA-AAAA", "BBBB-BBBB"]);
    expect(store.current()).toEqual({ code: "AAAA-AAAA", expiresAt: 1_600_000 });
    clock.now += 599_999;
    expect(store.current().code).toBe("AAAA-AAAA");
    expect(store.remainingMs()).toBe(1);
  });

  it("replaces an expired code in place and tells its listeners", () => {
    const { clock, issued, store } = onFakeClock(["AAAA-AAAA", "BBBB-BBBB"]);
    store.current();
    clock.now += 600_000;
    expect(store.current()).toEqual({ code: "BBBB-BBBB", expiresAt: 2_200_000 });
    expect(issued).toEqual([
      ["AAAA-AAAA", null],
      ["BBBB-BBBB", "AAAA-AAAA"],
    ]);
  });

  it("never hands out the code it just replaced", () => {
    const { clock, store } = onFakeClock(["AAAA-AAAA", "AAAA-AAAA", "CCCC-CCCC"]);
    store.current();
    clock.now += 600_000;
    expect(store.current().code).toBe("CCCC-CCCC");
  });

  it("accepts the live code however it's typed", () => {
    const { store } = onFakeClock(["K7QM-4X01"]);
    expect(store.check("k7qm4xol")).toBe("ok");
  });

  it("says a just-replaced code expired, rather than that it's wrong", () => {
    const { clock, store } = onFakeClock(["AAAA-AAAA", "BBBB-BBBB", "CCCC-CCCC"]);
    store.current();
    clock.now += 600_000;
    expect(store.check("aaaa-aaaa")).toBe("expired");
    expect(store.check("ZZZZ-ZZZZ")).toBe("wrong");
    expect(store.check(undefined)).toBe("wrong");
    expect(store.check("BBBB-BBBB")).toBe("ok");

    // Two codes ago is just wrong.
    clock.now += 600_000;
    expect(store.check("AAAA-AAAA")).toBe("wrong");
  });

  // Issue #237: a code whose claim is spent on legato.fm.
  it("replaces the live code on demand, as if it had expired", () => {
    const { issued, store } = onFakeClock(["AAAA-AAAA", "BBBB-BBBB"]);
    store.current();
    expect(store.replace()).toEqual({ code: "BBBB-BBBB", expiresAt: 1_600_000 });
    expect(store.check("AAAA-AAAA")).toBe("expired");
    expect(issued.at(-1)).toEqual(["BBBB-BBBB", "AAAA-AAAA"]);
  });

  it("offers the code it just replaced for claiming, for the grace period only", () => {
    const { clock, store } = onFakeClock(["AAAA-AAAA", "BBBB-BBBB"]);
    expect(store.claimable(120_000)).toEqual(["AAAA-AAAA"]);
    clock.now += 600_000;
    expect(store.claimable(120_000)).toEqual(["BBBB-BBBB", "AAAA-AAAA"]);
    clock.now += 120_000;
    expect(store.claimable(120_000)).toEqual(["BBBB-BBBB"]);
  });

  it("refreshes on its own timer, and stops once it's no longer needed", async () => {
    const store = new SetupCodes({ ttlMs: 20 });
    const issued: string[] = [];
    store.onIssue(({ code }) => issued.push(code));
    let needed = true;
    const stop = store.scheduleRefresh(() => needed);
    await Bun.sleep(170);
    needed = false;
    const countWhenStopped = issued.length;
    // First code, then at least two refreshes nobody asked for.
    expect(countWhenStopped).toBeGreaterThanOrEqual(3);
    await Bun.sleep(150);
    expect(issued.length).toBeLessThanOrEqual(countWhenStopped + 1);
    stop();
  });
});

function request(remoteAddress: string, headers: Record<string, string>): FastifyRequest {
  return { socket: { remoteAddress }, headers } as unknown as FastifyRequest;
}

describe("maySeeSetupCode", () => {
  it("shows it to a browser on the LAN or tailnet, on the server's own page", () => {
    for (const [peer, host] of [
      ["192.168.1.20", "192.168.1.5:8899"],
      ["10.0.0.4", "musicbox:8899"],
      ["172.20.1.1", "musicbox.local:8899"],
      ["100.101.102.103", "100.100.20.30:8899"],
      ["100.101.102.103", "musicbox.tail1234.ts.net:8899"],
      ["fd7a:115c:a1e0::5", "[fd7a:115c:a1e0::1]:8899"],
      ["::ffff:192.168.1.20", "music.home.arpa:8899"],
    ] as const) {
      const origin = `http://${host}`;
      expect(maySeeSetupCode(request(peer, { host, origin }))).toBe(true);
    }
  });

  it("shows it to the desktop app and to curl on the LAN", () => {
    expect(maySeeSetupCode(request("100.64.0.7", { host: "100.100.20.30:8899", origin: "tauri://localhost" }))).toBe(true);
    expect(maySeeSetupCode(request("192.168.1.20", { host: "192.168.1.5:8899" }))).toBe(true);
  });

  it("hides it from a peer on the public internet", () => {
    expect(maySeeSetupCode(request("203.0.113.9", { host: "192.168.1.5:8899" }))).toBe(false);
    expect(maySeeSetupCode(request("2001:db8::1", { host: "192.168.1.5:8899" }))).toBe(false);
  });

  it("hides it behind a reverse proxy, whose own address says nothing", () => {
    for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
      expect(maySeeSetupCode(request("192.168.1.2", { host: "192.168.1.5:8899", [header]: "203.0.113.9" }))).toBe(false);
    }
  });

  it("hides it from another website open on the LAN", () => {
    expect(
      maySeeSetupCode(request("192.168.1.20", { host: "192.168.1.5:8899", origin: "https://evil.example" })),
    ).toBe(false);
  });

  it("hides it from a DNS-rebinding page on a public domain", () => {
    const host = "rebind.evil.example:8899";
    expect(maySeeSetupCode(request("192.168.1.20", { host, origin: `http://${host}` }))).toBe(false);
  });
});
