import { createPublicKey, verify } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { authRoutes } from "../routes/auth.js";
import type { Database } from "../sqlite.js";
import { maskEmail, ServerClaims } from "./claim.js";
import { installLegatoIdentity, LegatoIdentity } from "./legatoIdentity.js";
import { makeTestKey, signTestToken, testClaims, TEST_ISSUER } from "./legato-test-keys.js";
import { ownerExists } from "./owner.js";
import { serverIdForPublicKey } from "./serverKey.js";
import { SetupCodes } from "./setupCode.js";
import { readTunnelCredential } from "./tunnelCredential.js";

// Issue #237 from the server's side: an open /setup page is the only thing
// that makes it ask legato.fm about its code; a claim shows whose account
// it is; and linking that account is a choice made when the owner is
// created, which leaves nothing behind when it isn't made.

const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0);
const CREDENTIAL = "c0ffee".repeat(10) + "c0ff";

// A /setup page on the LAN, the only kind GET /auth/setup shows the code to.
const LAN_PAGE = { remoteAddress: "192.168.1.20", headers: { host: "192.168.1.10:8899" } };

type Call = { url: string; body: Record<string, unknown> | null };

// legato.fm as far as this server can tell: the JWKS, /pair/exchange and
// the link report, with claims made by the spec rather than a phone.
function fakeRelay(nowSeconds: () => number) {
  const key = makeTestKey();
  const claimed = new Map<string, { sub: string; name: string; email: string }>();
  const used = new Set<string>();
  const expired = new Set<string>();
  const calls: Call[] = [];
  let down = false;
  let refuseLinks = false;
  // Retry-After for a 429 from /pair/exchange: a number, "none" for a 429
  // without one, or null for no 429 at all.
  let limited: number | "none" | null = null;

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (down) throw new Error("offline");
    if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [key.jwk] });
    if (url.endsWith("/pair/exchange")) {
      if (limited !== null) {
        const headers: Record<string, string> = limited === "none" ? {} : { "Retry-After": String(limited) };
        return Response.json(
          { error: "Too many unknown setup codes from this address.", reason: "rate_limited" },
          { status: 429, headers },
        );
      }
      const code = body!.code as string;
      if (used.has(code)) return Response.json({ error: "pairing code used", reason: "used" }, { status: 410 });
      if (expired.has(code)) return Response.json({ error: "pairing code expired", reason: "expired" }, { status: 410 });
      const claim = claimed.get(code);
      if (!claim) return Response.json({ error: "pairing code not found", reason: "not_found" }, { status: 404 });
      claimed.delete(code);
      used.add(code);
      const aud = serverIdForPublicKey(body!.publicKey as string);
      const claims = {
        ...testClaims(aud, nowSeconds()),
        sub: claim.sub,
        scope: "link",
        tunnel: true,
        name: claim.name,
        email: claim.email,
      };
      return Response.json({ linkToken: signTestToken(key, claims), expiresAt: "" });
    }
    if (url.endsWith("/linked-servers")) {
      if (refuseLinks) return Response.json({ error: "That proof has already been used.", reason: "used" }, { status: 409 });
      return Response.json({ linked: {}, tunnel: { credential: CREDENTIAL, expiresAt: "2027-10-08T12:00:00.000Z" } });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;

  return {
    impl,
    calls,
    exchanges: () => calls.filter((call) => call.url.endsWith("/pair/exchange")),
    reports: () => calls.filter((call) => call.url.endsWith("/linked-servers")),
    claim: (code: string, account = { sub: "7", name: "Rowan", email: "rowan@example.com" }) => claimed.set(code, account),
    use: (code: string) => used.add(code),
    expire: (code: string) => expired.add(code),
    goDown: () => {
      down = true;
    },
    refuseLinks: () => {
      refuseLinks = true;
    },
    limit: (retryAfter: number | "none" | null) => {
      limited = retryAfter;
    },
  };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(options: { db?: Database; origin?: string | null; relay?: ReturnType<typeof fakeRelay>; codes?: string[] } = {}) {
  const db = options.db ?? openDb(":memory:");
  let nowMs = START_MS;
  const now = () => nowMs;
  const relay = options.relay ?? fakeRelay(() => Math.floor(nowMs / 1000));
  const logs: string[] = [];
  const log = (_level: "info" | "warn", message: string) => void logs.push(message);
  const identity = new LegatoIdentity(db, {
    origin: options.origin === undefined ? TEST_ISSUER : options.origin,
    fetch: relay.impl,
    now,
    log,
  });
  installLegatoIdentity(db, identity);
  const codes = options.codes ?? ["AAAA-AAAA", "BBBB-BBBB", "CCCC-CCCC", "DDDD-DDDD"];
  const setupCodes = new SetupCodes({ now, generate: () => codes.shift()! });
  const claims = new ServerClaims({ setupCodes, identity: () => identity, now, log });

  const app = Fastify();
  await app.register(cookie);
  await app.register(authRoutes(db, { setupCodes, claims }), { prefix: "/api/v1" });
  cleanups.push(() => app.close());

  const checkIn = async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/setup", ...LAN_PAGE });
    await claims.settled();
    return res;
  };
  // What the page sees once the request a check-in started has answered.
  const view = async () => {
    await checkIn();
    return (await app.inject({ method: "GET", url: "/api/v1/auth/setup", ...LAN_PAGE })).json().claim;
  };
  const createOwner = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/owner",
      payload: { password: "correct horse battery", setupCode: setupCodes.current().code, ...extra },
      ...LAN_PAGE,
    });
  const linkedAccount = () =>
    (db.prepare("SELECT legato_account_id FROM users WHERE role = 'owner'").get() as { legato_account_id: string | null } | undefined)
      ?.legato_account_id;

  return {
    db,
    app,
    relay,
    identity,
    setupCodes,
    claims,
    logs,
    checkIn,
    view,
    createOwner,
    linkedAccount,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("when the server asks legato.fm", () => {
  it("never, until a /setup page checks in, and then at most every five seconds", async () => {
    const h = await setup();
    h.advance(60 * 60_000);
    await Bun.sleep(0);
    expect(h.relay.calls).toEqual([]);

    await h.checkIn();
    await h.checkIn();
    await h.checkIn();
    expect(h.relay.exchanges().map((call) => call.body!.code)).toEqual(["AAAA-AAAA"]);
    h.advance(5_000);
    await h.checkIn();
    expect(h.relay.exchanges()).toHaveLength(2);

    // The page closed: nothing more, however long it's left.
    h.advance(60 * 60_000);
    await Bun.sleep(0);
    expect(h.relay.exchanges()).toHaveLength(2);
  });

  it("never once the owner exists", async () => {
    const h = await setup();
    expect((await h.createOwner()).statusCode).toBe(201);
    h.advance(5_000);
    expect((await h.checkIn()).statusCode).toBe(409);
    expect(h.relay.calls).toEqual([]);
  });

  it("never with legato.fm off, and then the page has no QR", async () => {
    const h = await setup({ origin: null });
    const body = (await h.checkIn()).json();
    expect(body).toMatchObject({ claimUrl: null, claim: null });
    expect(h.relay.calls).toEqual([]);
  });

  it("signs what it asks with its identity key, for this service and this code", async () => {
    const h = await setup();
    await h.checkIn();
    const body = h.relay.exchanges()[0]!.body!;
    const serverId = h.identity.serverId();
    expect(serverIdForPublicKey(body.publicKey as string)).toBe(serverId);
    const message = ["legato.fm claim proof", TEST_ISSUER, serverId, "AAAA-AAAA", String(START_MS / 1000)].join("\n");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: body.publicKey as string }, format: "jwk" });
    expect(verify(null, Buffer.from(message), key, Buffer.from(body.signature as string, "base64url"))).toBe(true);
    expect(body.issuedAt).toBe(START_MS / 1000);
  });

  it("keeps asking about the code it just replaced, for a couple of minutes", async () => {
    const h = await setup();
    await h.checkIn();
    h.advance(10 * 60_000);
    await h.checkIn();
    expect(
      h.relay
        .exchanges()
        .slice(1)
        .map((call) => call.body!.code),
    ).toEqual(["BBBB-BBBB", "AAAA-AAAA"]);
    h.advance(3 * 60_000);
    await h.checkIn();
    expect(
      h.relay
        .exchanges()
        .slice(3)
        .map((call) => call.body!.code),
    ).toEqual(["BBBB-BBBB"]);
  });

  it("picks up a claim of the code it just replaced", async () => {
    const h = await setup();
    await h.checkIn();
    h.advance(10 * 60_000);
    h.relay.claim("AAAA-AAAA");
    expect(await h.view()).toMatchObject({ state: "claimed", account: { name: "Rowan" } });
  });

  it("says once that legato.fm can't be reached, not on every check-in", async () => {
    const h = await setup();
    h.relay.goDown();
    for (let i = 0; i < 3; i++) {
      expect(await h.view()).toEqual({ state: "waiting", unreachable: true, busy: false });
      h.advance(5_000);
    }
    expect(h.logs.filter((line) => line.includes("couldn't reach"))).toHaveLength(1);
  });
});

// Issue #324: legato.fm answers 429 when something on this server's network
// has asked about too many codes nobody claimed.
describe("when legato.fm says to wait", () => {
  it("waits as long as it says, says on /setup that legato.fm is busy, and logs it once", async () => {
    const h = await setup();
    h.relay.limit(30);
    expect(await h.view()).toEqual({ state: "waiting", unreachable: false, busy: true });
    expect(h.relay.exchanges()).toHaveLength(1);

    // Check-ins every five seconds, and no asking until the thirty are up.
    for (let t = 5_000; t < 30_000; t += 5_000) {
      h.advance(5_000);
      await h.checkIn();
    }
    expect(h.relay.exchanges()).toHaveLength(1);
    h.advance(5_000);
    expect(await h.view()).toMatchObject({ busy: true });
    expect(h.relay.exchanges()).toHaveLength(2);

    // Still a 429: still busy, and no second log line.
    h.advance(30_000);
    await h.checkIn();
    expect(h.relay.exchanges()).toHaveLength(3);
    expect(h.logs.filter((line) => line.includes("busy"))).toEqual([
      "legato.fm: busy, so checking for a claim again in 30 s (something on this network asked about too many codes nobody claimed)",
    ]);
    expect(h.logs.filter((line) => line.includes("refused"))).toEqual([]);

    // Over: a claim made meanwhile is picked up as usual.
    h.relay.limit(null);
    h.relay.claim("AAAA-AAAA");
    h.advance(30_000);
    expect(await h.view()).toMatchObject({ state: "claimed", account: { name: "Rowan" } });
  });

  it("never shows a 429 as a refusal, and stops saying busy once legato.fm answers", async () => {
    const h = await setup();
    h.relay.limit(10);
    expect((await h.view()).state).toBe("waiting");
    h.relay.limit(null);
    h.advance(10_000);
    expect(await h.view()).toEqual({ state: "waiting", unreachable: false, busy: false });
  });

  it("waits a minute when it isn't told how long, and never more than fifteen", async () => {
    const h = await setup();
    h.relay.limit("none");
    await h.checkIn();
    h.advance(59_000);
    await h.checkIn();
    expect(h.relay.exchanges()).toHaveLength(1);
    h.advance(1_000);
    await h.checkIn();
    expect(h.relay.exchanges()).toHaveLength(2);

    h.relay.limit(24 * 60 * 60);
    h.advance(60_000);
    await h.checkIn();
    expect(h.relay.exchanges()).toHaveLength(3);
    h.advance(15 * 60_000);
    await h.checkIn();
    expect(h.relay.exchanges()).toHaveLength(4);
  });
});

describe("a claim", () => {
  it("shows whose account it is, with the email masked", async () => {
    const h = await setup();
    expect(await h.view()).toEqual({ state: "waiting", unreachable: false, busy: false });
    h.relay.claim("AAAA-AAAA");
    h.advance(5_000);
    const claim = await h.view();
    expect(claim).toMatchObject({ state: "claimed", account: { id: "7", name: "Rowan", email: "r•••@example.com" } });
    expect(JSON.stringify(claim)).not.toContain("rowan@");
    // Picked up: no more asking.
    h.advance(5_000);
    await h.checkIn();
    expect(h.relay.exchanges()).toHaveLength(2);
  });

  it("links the account, and stores the credential legato.fm sends back, when the owner chooses to", async () => {
    const h = await setup();
    h.relay.claim("AAAA-AAAA");
    await h.view();

    const res = await h.createOwner({ linkAccountId: "7" });
    expect(res.statusCode).toBe(201);
    expect(res.json().legato).toEqual({ linked: { accountId: "7", email: "rowan@example.com", name: "Rowan" } });
    expect(h.linkedAccount()).toBe("7");
    expect(h.relay.reports()).toHaveLength(1);
    expect(readTunnelCredential(h.db, TEST_ISSUER)).toEqual({
      origin: TEST_ISSUER,
      accountId: "7",
      credential: CREDENTIAL,
      expiresAt: "2027-10-08T12:00:00.000Z",
    });
    // Only for the legato.fm that issued it.
    expect(readTunnelCredential(h.db, "https://elsewhere.example")).toBeNull();
  });

  it("is dropped when the owner is created without linking: nothing reported, linked or stored", async () => {
    const h = await setup();
    h.relay.claim("AAAA-AAAA");
    await h.view();

    const res = await h.createOwner();
    expect(res.statusCode).toBe(201);
    expect(res.json().legato).toBeUndefined();
    expect(h.linkedAccount()).toBeNull();
    expect(h.relay.reports()).toEqual([]);
    expect(readTunnelCredential(h.db, TEST_ISSUER)).toBeNull();
    expect(h.claims.view()).toEqual({ state: "waiting", unreachable: false, busy: false });
  });

  it("refuses an account id that isn't the claim's, and creates and links nobody", async () => {
    const h = await setup();
    h.relay.claim("AAAA-AAAA");
    await h.view();

    const res = await h.createOwner({ linkAccountId: "8" });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("claim_mismatch");
    expect(ownerExists(h.db)).toBe(false);
    expect(h.relay.reports()).toEqual([]);
    // The claim the page did show is still there to choose.
    expect((await h.createOwner({ linkAccountId: "7" })).json().legato.linked.accountId).toBe("7");
  });

  it("refuses to link when nothing was claimed", async () => {
    const h = await setup();
    const res = await h.createOwner({ linkAccountId: "7" });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("claim_no_claim");
    expect(ownerExists(h.db)).toBe(false);
  });

  it("lapses before its token does, says so on /setup, and starts asking again", async () => {
    const h = await setup();
    h.relay.claim("AAAA-AAAA");
    await h.view();
    h.advance(10 * 60_000 - 30_000);
    expect(await h.view()).toEqual({ state: "lapsed", account: { id: "7", name: "Rowan", email: "r•••@example.com" } });

    const res = await h.createOwner({ linkAccountId: "7" });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("claim_lapsed");
    expect(ownerExists(h.db)).toBe(false);
    expect(h.relay.reports()).toEqual([]);

    // The claimed code is spent on legato.fm, so there's a new one, and a
    // claim of that replaces the notice. The spent one is never asked
    // about again, so it can't read as someone else's.
    expect(h.setupCodes.current().code).toBe("BBBB-BBBB");
    h.relay.claim("BBBB-BBBB", { sub: "9", name: "Sam", email: "sam@example.com" });
    h.advance(5_000);
    expect(await h.view()).toMatchObject({ state: "claimed", account: { id: "9" } });
    expect(h.relay.exchanges().filter((call) => call.body!.code === "AAAA-AAAA")).toHaveLength(1);
  });

  it("is forgotten by a restart, leaving nothing stored and nothing to link", async () => {
    const h = await setup();
    h.relay.claim("AAAA-AAAA");
    await h.view();
    expect(h.claims.view().state).toBe("claimed");

    // The same database, a new process: a new claims object and code store.
    const restarted = await setup({ db: h.db, relay: h.relay, codes: ["EEEE-EEEE"] });
    expect(await restarted.view()).toEqual({ state: "waiting", unreachable: false, busy: false });
    expect(readTunnelCredential(h.db, TEST_ISSUER)).toBeNull();
    expect((await restarted.createOwner({ linkAccountId: "7" })).json().reason).toBe("claim_no_claim");
    expect(h.relay.reports()).toEqual([]);
  });

  it("still creates the owner when legato.fm refuses the link, and says why", async () => {
    const h = await setup();
    h.relay.claim("AAAA-AAAA");
    await h.view();
    h.relay.refuseLinks();

    const res = await h.createOwner({ linkAccountId: "7" });
    expect(res.statusCode).toBe(201);
    expect(res.json().legato).toMatchObject({ linked: null, reason: "legato_refused" });
    expect(ownerExists(h.db)).toBe(true);
    expect(h.linkedAccount()).toBeNull();
    expect(readTunnelCredential(h.db, TEST_ISSUER)).toBeNull();
  });
});

describe("a code someone else got to first", () => {
  it("is replaced when legato.fm says it was used, and /setup says why", async () => {
    const h = await setup();
    h.relay.use("AAAA-AAAA");
    expect(await h.view()).toEqual({ state: "used" });
    expect(h.setupCodes.current().code).toBe("BBBB-BBBB");
    const body = (await h.checkIn()).json();
    expect(body.code).toBe("BBBB-BBBB");
    expect(body.claimUrl).toBe(`${TEST_ISSUER}/claim?code=BBBB-BBBB&server=${h.identity.serverId()}`);
  });

  it("says a claim of the code expired before this page picked it up", async () => {
    const h = await setup();
    h.relay.expire("AAAA-AAAA");
    expect(await h.view()).toEqual({ state: "expired" });
  });
});

describe("the claim URL", () => {
  it("is legato.fm/claim for legato.fm itself", async () => {
    const h = await setup({ origin: "https://auth.legato.fm" });
    h.relay.goDown();
    expect((await h.checkIn()).json().claimUrl).toBe(`https://legato.fm/claim?code=AAAA-AAAA&server=${h.identity.serverId()}`);
  });

  // Issue #324: legato.fm keeps the claim for the server the QR names, so
  // only this server can pick it up.
  it("names this server, by the id its key makes", async () => {
    const h = await setup();
    const url = new URL((await h.checkIn()).json().claimUrl);
    expect(url.searchParams.get("server")).toBe(h.identity.serverId());
    expect(url.searchParams.get("server")).toMatch(/^[0-9a-f]{32}$/);
    expect(serverIdForPublicKey(h.relay.exchanges()[0]!.body!.publicKey as string)).toBe(h.identity.serverId());
  });
});

describe("the tunnel credential", () => {
  it("never appears in a response or a log line", async () => {
    const h = await setup();
    h.relay.claim("AAAA-AAAA");
    await h.view();
    const created = await h.createOwner({ linkAccountId: "7" });
    const owner = { authorization: `Bearer ${created.json().token}` };
    const bodies = [created.body];
    for (const url of ["/api/v1/auth/status", "/api/v1/auth/me", "/api/v1/auth/setup"]) {
      bodies.push((await h.app.inject({ method: "GET", url, headers: owner })).body);
    }
    expect(readTunnelCredential(h.db, TEST_ISSUER)?.credential).toBe(CREDENTIAL);
    for (const text of [...bodies, ...h.logs]) expect(text).not.toContain(CREDENTIAL);
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("rowan@example.com")).toBe("r•••@example.com");
    expect(maskEmail("r@example.com")).toBe("r•••@example.com");
    expect(maskEmail("not-an-address")).toBe("•••");
    expect(maskEmail(null)).toBeNull();
  });
});
