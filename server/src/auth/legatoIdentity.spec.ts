import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import type { Database } from "../sqlite.js";
import { installLegatoIdentity, LegatoIdentity } from "./legatoIdentity.js";
import {
  fakeLegatoFetch,
  makeTestKey,
  signTestToken,
  testClaims,
  TEST_ISSUER,
  type LegatoReport,
  type TestKey,
} from "./legato-test-keys.js";
import { serverIdForPublicKey } from "./serverKey.js";
import { createSession } from "./sessions.js";
import { buildTestApp, createOwnerForTest } from "./test-app.js";

// Issue #114 end to end through the real gate and routes: a legato.fm token
// in, a users row out, and the privacy promise that an unlinked server
// never contacts legato.fm.

const START_MS = Date.UTC(2026, 9, 1, 12, 0, 0);

type Harness = Awaited<ReturnType<typeof setup>>;
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type SetupOptions = {
  db?: Database;
  origin?: string | null;
  fetchFails?: boolean;
  answer?: (report: LegatoReport) => Response | Error;
  log?: (level: "info" | "warn", message: string) => void;
};

async function setup(options: SetupOptions = {}) {
  const db = options.db ?? openDb(":memory:");
  let nowMs = START_MS;
  let published: TestKey[] = [makeTestKey()];
  const served = fakeLegatoFetch(() => published, options.answer);
  const failing = { calls: [] as string[] };
  const fetchImpl = options.fetchFails
    ? ((async (input: string | URL | Request) => {
        failing.calls.push(String(input));
        throw new Error("offline");
      }) as unknown as typeof fetch)
    : served.impl;
  const identity = new LegatoIdentity(db, {
    origin: options.origin === undefined ? TEST_ISSUER : options.origin,
    fetch: fetchImpl,
    now: () => nowMs,
    log: options.log,
  });
  installLegatoIdentity(db, identity);
  cleanups.push(() => identity.stop());
  const { app } = await buildTestApp(db);
  cleanups.push(() => void app.close());

  const nowSeconds = () => Math.floor(nowMs / 1000);
  const token = (overrides: Record<string, unknown> = {}, key = published[0]!) =>
    signTestToken(key, testClaims(identity.serverId(), nowSeconds(), overrides));

  return {
    db,
    app,
    identity,
    token,
    fetchCalls: () => (options.fetchFails ? failing.calls : served.calls),
    reports: () => served.reports,
    advance: (ms: number) => {
      nowMs += ms;
    },
    publish: (keys: TestKey[]) => {
      published = keys;
    },
    published: () => published,
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function me(h: Harness, token: string) {
  return h.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(token) });
}

async function linkOwner(h: Harness, ownerToken: string, linkToken = h.token({ scope: "link" })) {
  return h.app.inject({
    method: "POST",
    url: "/api/v1/auth/legato/link",
    headers: bearer(ownerToken),
    payload: { token: linkToken },
  });
}

describe("migration 0032", () => {
  it("gives the server a stable 128-bit id, made once", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "legato-0032-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "legato.db");
    const first = openDb(file);
    const id = new LegatoIdentity(first, { origin: TEST_ISSUER }).serverId();
    first.close();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const second = openDb(file);
    expect(new LegatoIdentity(second, { origin: TEST_ISSUER }).serverId()).toBe(id);
    second.close();
  });

  it("adds a nullable legato_account_id that one account can hold only once", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (provider, provider_user_id, role) VALUES ('google', 'a', 'legacy'), ('github', 'b', 'legacy')").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE legato_account_id IS NULL").get()).toEqual({ n: 2 });
    db.prepare("UPDATE users SET legato_account_id = '7' WHERE provider_user_id = 'a'").run();
    expect(() => db.prepare("UPDATE users SET legato_account_id = '7' WHERE provider_user_id = 'b'").run()).toThrow(/UNIQUE/);
  });
});

describe("privacy: an unlinked server never contacts legato.fm", () => {
  it("makes no request at startup, schedules nothing, and refuses tokens without fetching", async () => {
    const h = await setup();
    await createOwnerForTest(h.app);
    h.identity.syncSchedule();
    expect(h.identity.scheduled).toBe(false);

    const res = await me(h, h.token());
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("not_linked");

    const status = await h.app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(status.json().legato).toEqual({
      serverId: h.identity.serverId(),
      publicKey: status.json().legato.publicKey,
      issuer: TEST_ISSUER,
      linked: null,
    });
    expect(serverIdForPublicKey(status.json().legato.publicKey)).toBe(h.identity.serverId());

    await Bun.sleep(0);
    expect(h.fetchCalls()).toEqual([]);
  });

  it("LEGATO_ID_ORIGIN=off refuses tokens and linking, and never fetches", async () => {
    const h = await setup({ origin: null });
    const { token: owner } = await createOwnerForTest(h.app);
    expect((await me(h, h.token())).json().error).toMatch(/turned off/);
    const res = await linkOwner(h, owner);
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toBe("legato_disabled");
    expect(h.fetchCalls()).toEqual([]);
  });
});

describe("linking the owner", () => {
  it("fetches the keys once, links, starts the daily refresh, and the owner gets in by token", async () => {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);

    const res = await linkOwner(h, owner);
    expect(res.statusCode).toBe(200);
    expect(res.json().linked).toEqual({ accountId: "42", email: "owner@example.com", name: "Test Owner" });
    expect(h.fetchCalls()).toEqual([`${TEST_ISSUER}/.well-known/jwks.json`, `${TEST_ISSUER}/linked-servers`]);
    expect(h.identity.scheduled).toBe(true);

    const access = await me(h, h.token());
    expect(access.statusCode).toBe(200);
    expect(access.json().user).toMatchObject({ role: "owner", provider: "local" });

    const status = await h.app.inject({ method: "GET", url: "/api/v1/auth/status", headers: bearer(owner) });
    expect(status.json().legato.linked).toBe(true);
  });

  it("unlinking stops the daily refresh and the token stops working", async () => {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);
    await linkOwner(h, owner);
    const unlink = await h.app.inject({ method: "DELETE", url: "/api/v1/auth/legato/link", headers: bearer(owner) });
    expect(unlink.statusCode).toBe(200);
    expect(h.identity.scheduled).toBe(false);
    expect((await me(h, h.token())).json().reason).toBe("not_linked");
  });

  it("refuses a non-owner, a bad token, and an account already linked elsewhere", async () => {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);

    h.db.prepare("INSERT INTO users (provider, provider_user_id, role, legato_account_id) VALUES ('google', 'g', 'legacy', '99')").run();
    const legacyId = (h.db.prepare("SELECT id FROM users WHERE provider = 'google'").get() as { id: number }).id;
    const legacy = createSession(h.db, legacyId).token;
    expect((await linkOwner(h, legacy)).json().reason).toBe("owner_only");

    expect((await linkOwner(h, owner, h.token({ aud: "f".repeat(32), scope: "link" }))).json().reason).toBe("wrong_audience");
    expect((await linkOwner(h, owner, h.token({ sub: "99", scope: "link" }))).statusCode).toBe(409);
    expect((await h.app.inject({ method: "POST", url: "/api/v1/auth/legato/link", headers: bearer(owner), payload: {} })).statusCode).toBe(400);
  });

  it("502s with a clear message when legato.fm can't be reached on a first link", async () => {
    const h = await setup({ fetchFails: true });
    const { token: owner } = await createOwnerForTest(h.app);
    const res = await linkOwner(h, owner);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain(TEST_ISSUER);
  });
});

describe("tokens through the gate", () => {
  async function linked() {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);
    expect((await linkOwner(h, owner)).statusCode).toBe(200);
    return h;
  }

  it("refuses tampered, expired, wrong-audience, link-scoped and unknown-key tokens", async () => {
    const h = await linked();
    const good = h.token();
    const [head, , sig] = good.split(".");
    const tampered = `${head}.${Buffer.from(JSON.stringify(testClaims(h.identity.serverId(), 0, { sub: "1" }))).toString("base64url")}.${sig}`;
    expect((await me(h, tampered)).statusCode).toBe(401);

    const expired = h.token();
    h.advance(11 * 60 * 1000);
    expect((await me(h, expired)).json().error).toMatch(/expired/);

    expect((await me(h, h.token({ aud: "f".repeat(32) }))).json().error).toMatch(/different server/);

    const linkOnly = await me(h, h.token({ scope: "link" }));
    expect(linkOnly.statusCode).toBe(403);
    expect(linkOnly.json().reason).toBe("wrong_scope");

    expect((await me(h, h.token({}, makeTestKey()))).statusCode).toBe(401);
  });

  it("a verified token for an account this server doesn't know is 403, and creates no user", async () => {
    const h = await linked();
    const res = await me(h, h.token({ sub: "1000", email: "stranger@example.com" }));
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("not_a_member");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("an unknown kid on a linked server triggers one background refetch, then works", async () => {
    const h = await linked();
    const rotated = makeTestKey();
    h.publish([...h.published(), rotated]);
    const before = h.fetchCalls().length;

    expect((await me(h, h.token({}, rotated))).statusCode).toBe(401);
    await Bun.sleep(0);
    expect(h.fetchCalls().length).toBe(before + 1);
    expect((await me(h, h.token({}, rotated))).statusCode).toBe(200);

    // A second stranger within ten minutes doesn't fetch again.
    await me(h, h.token({}, makeTestKey()));
    await me(h, h.token({}, makeTestKey()));
    await Bun.sleep(0);
    expect(h.fetchCalls().length).toBe(before + 1);
  });

  it("refreshes the keys once they're a day old, and not before", async () => {
    const h = await linked();
    const before = h.fetchCalls().length;
    await h.identity.refreshIfStale();
    expect(h.fetchCalls().length).toBe(before);
    h.advance(24 * 60 * 60 * 1000);
    await h.identity.refreshIfStale();
    expect(h.fetchCalls().length).toBe(before + 1);
  });
});

describe("offline", () => {
  it("a restarted server with no network verifies from its cached keys until the token expires", async () => {
    const online = await setup();
    const { token: owner } = await createOwnerForTest(online.app);
    await linkOwner(online, owner);
    const key = online.published()[0]!;
    online.identity.stop();

    const offline = await setup({ db: online.db, fetchFails: true });
    offline.identity.syncSchedule();
    const token = offline.token({}, key);
    expect((await me(offline, token)).statusCode).toBe(200);

    offline.advance(10 * 60 * 1000 + 29 * 1000);
    expect((await me(offline, token)).statusCode).toBe(200);
    offline.advance(1000);
    expect((await me(offline, token)).statusCode).toBe(401);

    // The daily refresh failing keeps the cache rather than clearing it.
    offline.advance(24 * 60 * 60 * 1000);
    await offline.identity.refreshIfStale();
    expect(offline.fetchCalls().length).toBeGreaterThan(0);
    expect((await me(offline, offline.token({}, key))).statusCode).toBe(200);
  });
});

describe("matching Google/GitHub users by verified email", () => {
  async function withLegacy(emails: (string | null)[]) {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);
    await linkOwner(h, owner);
    emails.forEach((email, i) =>
      h.db
        .prepare("INSERT INTO users (provider, provider_user_id, email, role) VALUES (?, ?, ?, 'legacy')")
        .run(i % 2 ? "github" : "google", `p${i}`, email),
    );
    return h;
  }

  it("links the one legacy row whose email matches, case-insensitively, and only once", async () => {
    const h = await withLegacy(["Friend@Example.com", "other@example.com"]);
    const res = await me(h, h.token({ sub: "7", email: "friend@example.com " }));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ provider: "google", email: "Friend@Example.com" });
    expect(h.db.prepare("SELECT legato_account_id FROM users WHERE provider_user_id = 'p0'").get()).toEqual({
      legato_account_id: "7",
    });
    // A second account with the same address finds the row already taken.
    expect((await me(h, h.token({ sub: "8", email: "friend@example.com" }))).json().reason).toBe("not_a_member");
  });

  it("doesn't link on an unverified email, an ambiguous match, or the local owner's own address", async () => {
    const h = await withLegacy(["dup@example.com", "dup@example.com"]);
    h.db.prepare("UPDATE users SET email = 'owner2@example.com' WHERE role = 'owner'").run();
    expect((await me(h, h.token({ sub: "7", email: "dup@example.com" }))).json().reason).toBe("not_a_member");
    expect((await me(h, h.token({ sub: "8", email: "dup@example.com", email_verified: false }))).statusCode).toBe(403);
    expect((await me(h, h.token({ sub: "9", email: "owner2@example.com" }))).statusCode).toBe(403);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM users WHERE legato_account_id IS NOT NULL").get()).toEqual({ n: 1 });
  });

  it("on a server with no Google/GitHub users, matches nothing", async () => {
    const h = await withLegacy([]);
    expect((await me(h, h.token({ sub: "7", email: "anyone@example.com" }))).json().reason).toBe("not_a_member");
  });
});

describe("telling legato.fm about links (issue #231)", () => {
  function signedBy(publicKey: string, message: string, signature: string): boolean {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
  }

  async function linkedStatus(h: Harness, owner: string) {
    return (await h.app.inject({ method: "GET", url: "/api/v1/auth/status", headers: bearer(owner) })).json().legato.linked;
  }

  it("reports a link with the link token, signed by the key this server's id comes from", async () => {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);
    const linkToken = h.token({ scope: "link" });
    expect((await linkOwner(h, owner, linkToken)).statusCode).toBe(200);

    const [report] = h.reports();
    expect(report!.url).toBe(`${TEST_ISSUER}/linked-servers`);
    const body = report!.body as { publicKey: string; linkToken: string; signature: string };
    expect(Object.keys(body).sort()).toEqual(["linkToken", "publicKey", "signature"]);
    expect(body.linkToken).toBe(linkToken);
    expect(serverIdForPublicKey(body.publicKey)).toBe(h.identity.serverId());
    expect(signedBy(body.publicKey, `legato.fm link proof\n${linkToken}`, body.signature)).toBe(true);
  });

  it("changes nothing here when legato.fm can't be reached", async () => {
    const h = await setup({ answer: () => new Error("offline") });
    const { token: owner } = await createOwnerForTest(h.app);
    const res = await linkOwner(h, owner);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ reason: "legato_unreachable" });
    expect(res.json().error).toContain(TEST_ISSUER);
    expect(await linkedStatus(h, owner)).toBe(false);
    expect(h.identity.scheduled).toBe(false);
  });

  it("changes nothing here when legato.fm refuses, and passes its reason on", async () => {
    const h = await setup({
      answer: () => Response.json({ error: "That proof has already been used.", reason: "used" }, { status: 409 }),
    });
    const { token: owner } = await createOwnerForTest(h.app);
    const res = await linkOwner(h, owner);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "legato_refused", legatoReason: "used" });
    expect(res.json().error).toContain("That proof has already been used.");
    expect(await linkedStatus(h, owner)).toBe(false);
  });

  it("refuses an access token or an account taken here without telling legato.fm anything", async () => {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);
    const access = await linkOwner(h, owner, h.token());
    expect(access.statusCode).toBe(403);
    expect(access.json().reason).toBe("wrong_scope");

    h.db.prepare("INSERT INTO users (provider, provider_user_id, role, legato_account_id) VALUES ('google', 'g', 'legacy', '99')").run();
    expect((await linkOwner(h, owner, h.token({ sub: "99", scope: "link" }))).json().reason).toBe("account_taken");
    expect(h.reports()).toEqual([]);
  });

  it("reports an unlink, signed for this service, account and time", async () => {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);
    await linkOwner(h, owner);
    const res = await h.app.inject({ method: "DELETE", url: "/api/v1/auth/legato/link", headers: bearer(owner) });
    expect(res.json()).toEqual({ ok: true, legatoNotified: true });

    const report = h.reports()[1]!;
    expect(report.url).toBe(`${TEST_ISSUER}/linked-servers/unlink`);
    const body = report.body as { publicKey: string; accountId: string; issuedAt: number; nonce: string; signature: string };
    expect(body).toMatchObject({ accountId: "42", issuedAt: Math.floor(START_MS / 1000) });
    const message = `legato.fm unlink proof\n${TEST_ISSUER}\n${h.identity.serverId()}\n42\n${body.issuedAt}\n${body.nonce}`;
    expect(signedBy(body.publicKey, message, body.signature)).toBe(true);

    // Nothing linked, nothing to report.
    const again = await h.app.inject({ method: "DELETE", url: "/api/v1/auth/legato/link", headers: bearer(owner) });
    expect(again.json()).toEqual({ ok: true, legatoNotified: null });
    expect(h.reports()).toHaveLength(2);
  });

  it("unlinks here even when legato.fm can't be told", async () => {
    let online = true;
    const h = await setup({ answer: () => (online ? Response.json({ ok: true }) : new Error("offline")) });
    const { token: owner } = await createOwnerForTest(h.app);
    await linkOwner(h, owner);
    online = false;
    const res = await h.app.inject({ method: "DELETE", url: "/api/v1/auth/legato/link", headers: bearer(owner) });
    expect(res.json()).toEqual({ ok: true, legatoNotified: false });
    expect(await linkedStatus(h, owner)).toBe(false);
    expect(h.identity.scheduled).toBe(false);
  });

  it("linking a different account reports the old one unlinked", async () => {
    const h = await setup();
    const { token: owner } = await createOwnerForTest(h.app);
    await linkOwner(h, owner);
    expect((await linkOwner(h, owner, h.token({ sub: "43", scope: "link" }))).statusCode).toBe(200);
    expect(h.reports().map((r) => [r.url.replace(TEST_ISSUER, ""), r.body.accountId ?? null])).toEqual([
      ["/linked-servers", null],
      ["/linked-servers", null],
      ["/linked-servers/unlink", "42"],
    ]);
  });

  it("never puts the private key in a response or a log line", async () => {
    const lines: string[] = [];
    const h = await setup({ log: (_level, message) => void lines.push(message) });
    const { token: owner } = await createOwnerForTest(h.app);
    const bodies = [
      (await linkOwner(h, owner)).body,
      (await h.app.inject({ method: "GET", url: "/api/v1/auth/status", headers: bearer(owner) })).body,
      (await h.app.inject({ method: "GET", url: "/api/v1/health" })).body,
      (await h.app.inject({ method: "POST", url: "/api/v1/auth/identity", payload: { nonce: "n".repeat(32) } })).body,
      (await me(h, h.token())).body,
      (await linkOwner(h, owner, h.token())).body,
      (await h.app.inject({ method: "DELETE", url: "/api/v1/auth/legato/link", headers: bearer(owner) })).body,
      ...h.reports().map((r) => JSON.stringify(r.body)),
      ...lines,
    ].join("\n");
    const pem = (h.db.prepare("SELECT private_key FROM server_identity").get() as { private_key: string }).private_key;
    const secret = pem.split("\n").filter((line) => line && !line.startsWith("-----")).join("");
    expect(secret.length).toBeGreaterThan(40);
    expect(bodies).not.toContain(secret);
    expect(bodies).not.toContain("PRIVATE KEY");
  });
});
