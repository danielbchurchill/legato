import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { openDb } from "../db.js";
import { installLegatoIdentity, LegatoIdentity } from "../auth/legatoIdentity.js";
import { fakeLegatoFetch, makeTestKey, signTestToken, testClaims, type LegatoReport } from "../auth/legato-test-keys.js";
import { buildTestApp, createOwnerForTest } from "../auth/test-app.js";
import { readTunnelCredential, storeTunnelCredential } from "../auth/tunnelCredential.js";
import type { Database } from "../sqlite.js";
import type { TunnelState } from "./client.js";
import { startFakeRelay, type FakeRotation } from "./fake-relay.js";
import { installRelayTunnel, RelayTunnel, tunnelUrl } from "./relayTunnel.js";

// Issue #310: when this server keeps a tunnel open to legato.fm, and with
// what. The privacy page's promise is the first test: a server that isn't
// linked never contacts legato.fm.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY_MS = 24 * 3600 * 1000;
const NEXT_YEAR = new Date(Date.now() + 365 * DAY_MS).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

async function setup(
  options: {
    answer?: (report: LegatoReport) => Response | Error;
    listen?: boolean;
    replace?: boolean;
    slowAnswerTo?: string;
    rotate?: () => FakeRotation;
    rotateCheckMs?: number;
  } = {},
) {
  const fake = startFakeRelay({ accept: (credential) => credential.startsWith("live-"), replace: options.replace, rotate: options.rotate });
  cleanups.push(() => fake.stop());
  const db = openDb(":memory:");
  const key = makeTestKey();
  const served = fakeLegatoFetch(() => [key], options.answer);
  const identity = new LegatoIdentity(db, { origin: fake.origin, fetch: served.impl });
  installLegatoIdentity(db, identity);
  cleanups.push(() => identity.stop());
  const { app } = await buildTestApp(db);
  cleanups.push(() => app.close());
  // Holds one route's answer back, the way a slow uplink would.
  app.addHook("onSend", async (request) => {
    if (request.url === options.slowAnswerTo) await sleep(200);
  });
  const owner = await createOwnerForTest(app);
  // Listening, for a spec whose requests come down the tunnel and are
  // replayed against this server; otherwise nothing answers on port 9.
  const port = options.listen ? Number(new URL(await app.listen({ port: 0, host: "127.0.0.1" })).port) : 9;
  const lines: { level: string; message: string }[] = [];
  const tunnel = new RelayTunnel(db, {
    port,
    log: (level, message) => lines.push({ level, message }),
    client: { backoff: { baseMs: 20, capMs: 80 } },
    rotateCheckMs: options.rotateCheckMs,
  });
  installRelayTunnel(db, tunnel);
  cleanups.push(() => tunnel.stop());

  const link = (accountId: string) => db.prepare("UPDATE users SET legato_account_id = ? WHERE role = 'owner'").run(accountId);
  const store = (accountId: string, credential: string, expiresAt = NEXT_YEAR, origin = fake.origin) =>
    storeTunnelCredential(db, { origin, accountId, credential, expiresAt });
  const linkToken = (accountId: string) =>
    signTestToken(
      key,
      testClaims(identity.serverId(), Math.floor(Date.now() / 1000), {
        iss: fake.origin,
        sub: accountId,
        scope: "link",
        jti: `link-${accountId}`,
      }),
    );
  return { db, app, fake, tunnel, owner, lines, link, store, linkToken, reports: served.reports };
}

async function until(state: () => TunnelState, wanted: TunnelState, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (state() !== wanted) {
    if (Date.now() > deadline) throw new Error(`stayed ${state()}, never ${wanted}`);
    await sleep(10);
  }
}

function stored(db: Database, origin: string): string | null {
  return readTunnelCredential(db, origin)?.credential ?? null;
}

describe("RelayTunnel", () => {
  it("never contacts legato.fm from a server that isn't linked", async () => {
    const h = await setup();
    h.tunnel.sync();
    await sleep(100);
    expect(h.tunnel.state).toBe("stopped");
    expect(h.fake.opened).toBe(0);
  });

  it("opens the tunnel with the stored credential once the account is linked, and keeps the one it has", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");
    h.tunnel.sync();
    await sleep(50);
    expect(h.fake.auths).toEqual(["live-1"]);
    expect(h.fake.opened).toBe(1);
  });

  it("wants the url of the legato.fm it trusts, over ws or wss to match", () => {
    expect(tunnelUrl("https://auth.legato.fm")).toBe("wss://auth.legato.fm/tunnel");
    expect(tunnelUrl("http://127.0.0.1:8911")).toBe("ws://127.0.0.1:8911/tunnel");
  });

  it("doesn't offer a credential from a different legato.fm", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1", NEXT_YEAR, "https://elsewhere.example");
    h.tunnel.sync();
    await sleep(100);
    expect(h.fake.opened).toBe(0);
  });

  it("forgets, unused, a credential whose account isn't linked here any more", async () => {
    // An unlink from before #310 left its credential behind.
    const h = await setup();
    h.store("42", "live-1");
    h.tunnel.sync();
    await sleep(100);
    expect(h.fake.opened).toBe(0);
    expect(stored(h.db, h.fake.origin)).toBeNull();
  });

  it("doesn't use an expired credential, and says so once", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1", "2026-01-01T00:00:00.000Z");
    h.tunnel.sync();
    h.tunnel.sync();
    await sleep(100);
    expect(h.fake.opened).toBe(0);
    expect(h.lines.filter((line) => line.level === "warn").map((line) => line.message)).toEqual([
      expect.stringContaining("tunnel credential expired at 2026-01-01T00:00:00.000Z"),
    ]);
  });

  it("closes the tunnel and forgets the credential when the owner unlinks", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");

    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/v1/auth/legato/link",
      headers: { authorization: `Bearer ${h.owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    await until(() => h.tunnel.state, "stopped");
    expect(stored(h.db, h.fake.origin)).toBeNull();
    await sleep(100);
    expect(h.fake.closed).toBe(1);
    expect(h.fake.opened).toBe(1);
  });

  it("answers an unlink made through the tunnel before it closes the tunnel", async () => {
    // From a phone through legato.fm: the tunnel carrying the request is
    // the one the unlink closes. It used to close before the answer went
    // back, so the phone saw a 502 for an unlink that had happened.
    const h = await setup({ listen: true });
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");

    const res = await h.fake.request({
      method: "DELETE",
      path: "/api/v1/auth/legato/link",
      headers: { authorization: `Bearer ${h.owner.token}` },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString())).toEqual({ ok: true, legatoNotified: true });
    await until(() => h.tunnel.state, "stopped");
    expect(stored(h.db, h.fake.origin)).toBeNull();
    while (h.fake.closed < 1) await sleep(10);
    expect(h.fake.opened).toBe(1);
  });

  it("keeps the server up when syncing the tunnel after an unlink throws", async () => {
    // The sync runs once the unlink's answer has gone, outside Fastify's
    // error handling. SQLITE_BUSY there (the recompute Worker holding the
    // write lock past busy_timeout) or a database already closed at
    // shutdown was an uncaught exception, and Bun exits on one.
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");
    const failing = spyOn(h.tunnel, "sync").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    cleanups.push(() => process.off("uncaughtException", onUncaught));

    const res = await h.app.inject({
      method: "DELETE",
      url: "/api/v1/auth/legato/link",
      headers: { authorization: `Bearer ${h.owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    await sleep(50);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(uncaught).toEqual([]);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
  });

  it("opens the tunnel as soon as a link brings a credential", async () => {
    const h = await setup({
      answer: (report) =>
        report.url.endsWith("/linked-servers")
          ? Response.json({ linked: {}, tunnel: { credential: "live-from-link", expiresAt: NEXT_YEAR } })
          : Response.json({ ok: true }),
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/legato/link",
      headers: { authorization: `Bearer ${h.owner.token}` },
      payload: { token: h.linkToken("42") },
    });
    expect(res.statusCode).toBe(200);
    await until(() => h.tunnel.state, "connected");
    expect(h.fake.auths).toEqual(["live-from-link"]);
  });

  it("answers a link made through the tunnel before the credential it brings replaces the tunnel", async () => {
    // From a phone through legato.fm. Once the client signs in with the
    // link's new credential, legato.fm closes the old connection, failing
    // whatever is still on its way up it: the phone saw a 502 for a link
    // that had happened.
    const h = await setup({
      listen: true,
      replace: true,
      slowAnswerTo: "/api/v1/auth/legato/link",
      answer: (report) =>
        report.url.endsWith("/linked-servers")
          ? Response.json({ linked: {}, tunnel: { credential: "live-from-link", expiresAt: NEXT_YEAR } })
          : Response.json({ ok: true }),
    });
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");

    const res = await h.fake.request({
      method: "POST",
      path: "/api/v1/auth/legato/link",
      headers: { authorization: `Bearer ${h.owner.token}`, "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ token: h.linkToken("42") })).toString("base64"),
    });
    expect(res.status).toBe(200);
    while (h.fake.auths.length < 2) await sleep(10);
    await until(() => h.tunnel.state, "connected");
    expect(h.fake.auths).toEqual(["live-1", "live-from-link"]);
  });

  it("linking a different account forgets the old account's credential and closes its tunnel", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");

    // legato.fm records the new link but brings no credential with it.
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/legato/link",
      headers: { authorization: `Bearer ${h.owner.token}` },
      payload: { token: h.linkToken("43") },
    });
    expect(res.statusCode).toBe(200);
    expect(stored(h.db, h.fake.origin)).toBeNull();
    expect(h.tunnel.state).toBe("stopped");
    expect(h.reports.map((report) => report.url)).toEqual([`${h.fake.origin}/linked-servers`, `${h.fake.origin}/linked-servers/unlink`]);
  });

  it("asks again about a refused credential on every link change, and connects once a new one arrives", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "revoked-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "refused");
    await sleep(150);
    // Not on the backoff's short delays: the next try is an hour away.
    expect(h.fake.opened).toBe(1);

    // A link change with the same credential still stored asks once more.
    h.tunnel.sync();
    while (h.fake.auths.length < 2) await sleep(10);
    await until(() => h.tunnel.state, "refused");
    expect(h.fake.auths).toEqual(["revoked-1", "revoked-1"]);

    h.store("42", "live-2");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");
    expect(h.fake.auths).toEqual(["revoked-1", "revoked-1", "live-2"]);
    expect(h.lines.filter((line) => line.level === "warn")).toHaveLength(1);
  });
});

// Issue #115: a credential lasts 90 days, and the server swaps it for the
// next one over the tunnel it has open, well before it runs out.
describe("RelayTunnel rotation", () => {
  it("asks for a replacement once less than 60 days are left, stores it, and moves the open tunnel onto it", async () => {
    const expiresAt = inDays(90);
    const h = await setup({ rotate: () => ({ credential: "live-2", expiresAt }) });
    h.link("42");
    h.store("42", "live-1", inDays(59));
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");
    while (h.fake.auths.length < 2) await sleep(10);

    expect(h.fake.auths).toEqual(["live-1", "live-2"]);
    expect(readTunnelCredential(h.db, h.fake.origin)).toEqual({ origin: h.fake.origin, accountId: "42", credential: "live-2", expiresAt });
    // No reconnect: a stream playing through the tunnel plays on.
    expect(h.fake.opened).toBe(1);
    expect(h.tunnel.state).toBe("connected");
    expect(h.tunnel.current?.credential).toBe("live-2");
    // Already replaced, so it doesn't ask again, and a sync keeps the tunnel.
    h.tunnel.sync();
    await sleep(100);
    expect(h.fake.rotates).toBe(1);
    expect(h.fake.opened).toBe(1);
  });

  it("doesn't ask while more than 60 days are left", async () => {
    const h = await setup({ rotate: () => ({ credential: "live-2", expiresAt: inDays(90) }) });
    h.link("42");
    h.store("42", "live-1", inDays(61));
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");
    await sleep(100);
    expect(h.fake.rotates).toBe(0);
  });

  it("asks once an hour at most when legato.fm doesn't answer, as one from before rotation won't", async () => {
    const h = await setup({ rotate: () => null });
    h.link("42");
    h.store("42", "live-1", inDays(10));
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");
    while (h.fake.rotates < 1) await sleep(10);
    // A reconnect is a moment to ask, but not within the hour.
    h.tunnel.stop();
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");
    await sleep(100);
    expect(h.fake.rotates).toBe(1);
    expect(stored(h.db, h.fake.origin)).toBe("live-1");
  });

  it("takes a replacement that arrives on the connection whenever it comes", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");

    h.fake.send({ type: "credential", credential: "live-2", expiresAt: inDays(90) });
    while (h.fake.auths.length < 2) await sleep(10);
    expect(h.fake.auths).toEqual(["live-1", "live-2"]);
    expect(stored(h.db, h.fake.origin)).toBe("live-2");
    expect(h.lines.map((line) => line.message)).toContainEqual(expect.stringContaining("replaced this server's tunnel credential"));
  });

  // The coordinator's review asks: a server that was off for longer than
  // 60 days comes back with a credential nearly gone, and one off for
  // longer than 90 comes back with one that's gone.
  it("rotates as soon as the tunnel connects after more than 60 days offline", async () => {
    const h = await setup({ rotate: () => ({ credential: "live-2", expiresAt: inDays(90) }) });
    h.link("42");
    h.store("42", "live-1", inDays(3));
    h.tunnel.sync();
    while (h.fake.auths.length < 2) await sleep(10);
    expect(h.fake.auths).toEqual(["live-1", "live-2"]);
    expect(stored(h.db, h.fake.origin)).toBe("live-2");
  });

  it("doesn't connect or ask after more than 90 days offline, and Settings says it's expired", async () => {
    const h = await setup({ rotate: () => ({ credential: "live-2", expiresAt: inDays(90) }) });
    h.link("42");
    h.store("42", "live-1", inDays(-1));
    h.tunnel.sync();
    await sleep(100);
    expect(h.fake.opened).toBe(0);
    expect(h.fake.rotates).toBe(0);
    expect(h.tunnel.status).toBe("expired");
  });

  it("comes back on the replacement it stored when the tunnel drops before it could move onto it", async () => {
    const h = await setup({ rotate: () => ({ credential: "live-2", expiresAt: inDays(90), then: "drop" }) });
    h.link("42");
    h.store("42", "live-1", inDays(30));
    h.tunnel.sync();
    while (h.fake.auths.length < 2) await sleep(10);
    await until(() => h.tunnel.state, "connected");
    // The new connection signs in with the replacement, and that first
    // sign-in is what retires the old one on legato.fm.
    expect(h.fake.auths).toEqual(["live-1", "live-2"]);
    expect(h.fake.opened).toBe(2);
    expect(stored(h.db, h.fake.origin)).toBe("live-2");
    expect(h.fake.rotates).toBe(1);
  });

  it("comes back on the old credential when the tunnel drops before the replacement arrives, and asks again an hour later", async () => {
    let answers = 0;
    const h = await setup({
      rotateCheckMs: 20,
      rotate: () => (answers++ === 0 ? "drop" : { credential: "live-2", expiresAt: inDays(90) }),
    });
    h.link("42");
    h.store("42", "live-1", inDays(30));
    h.tunnel.sync();
    while (h.fake.opened < 2) await sleep(10);
    await until(() => h.tunnel.state, "connected");
    await sleep(100);
    expect(h.fake.auths).toEqual(["live-1", "live-1"]);
    expect(h.fake.rotates).toBe(1);

    setSystemTime(new Date(Date.now() + 61 * 60_000));
    try {
      while (h.fake.auths.length < 3) await sleep(10);
    } finally {
      setSystemTime();
    }
    expect(h.fake.auths).toEqual(["live-1", "live-1", "live-2"]);
    expect(stored(h.db, h.fake.origin)).toBe("live-2");
    expect(h.fake.opened).toBe(2);
  });

  it("drops a replacement for a credential it no longer holds, and keeps the tunnel on the one it has", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");

    // A link stored another credential, and the sync that acts on it hasn't run yet.
    h.store("42", "live-from-link");
    h.fake.send({ type: "credential", credential: "live-2", expiresAt: inDays(90) });
    await sleep(100);
    expect(h.fake.auths).toEqual(["live-1"]);
    expect(stored(h.db, h.fake.origin)).toBe("live-from-link");
    expect(h.tunnel.current?.credential).toBe("live-1");
  });

  it("keeps the credential it has when the replacement can't be stored", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");

    const locked = spyOn(h.db, "transaction").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      h.fake.send({ type: "credential", credential: "live-2", expiresAt: inDays(90) });
      await sleep(100);
    } finally {
      locked.mockRestore();
    }
    expect(h.fake.auths).toEqual(["live-1"]);
    expect(stored(h.db, h.fake.origin)).toBe("live-1");
    expect(h.tunnel.state).toBe("connected");
    expect(h.lines.filter((line) => line.level === "warn").map((line) => line.message)).toEqual([
      expect.stringContaining("couldn't store this server's new tunnel credential"),
    ]);
  });

  it("is refused like any other credential when the replacement was revoked before the tunnel moved onto it", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");

    h.fake.send({ type: "credential", credential: "revoked-2", expiresAt: inDays(90) });
    await until(() => h.tunnel.state, "refused");
    expect(h.tunnel.status).toBe("refused");
  });
});

describe("RelayTunnel status", () => {
  // Issue #115: a server whose credential legato.fm revoked says so in its
  // owner's Settings, where linking again is the way back.
  it("tells the owner, and only the owner, that legato.fm refused the tunnel", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1");
    h.tunnel.sync();
    await until(() => h.tunnel.state, "connected");
    const status = async (headers: Record<string, string>) =>
      (await h.app.inject({ method: "GET", url: "/api/v1/auth/status", headers })).json().legato;
    expect((await status({ authorization: `Bearer ${h.owner.token}` })).tunnel).toBe("connected");

    // Revoked on legato.fm: the next answer is a refusal.
    h.fake.send({ type: "auth-error", message: "this tunnel credential was revoked or has expired" });
    await until(() => h.tunnel.state, "refused");
    expect((await status({ authorization: `Bearer ${h.owner.token}` })).tunnel).toBe("refused");
    expect(await status({})).not.toHaveProperty("tunnel");
  });

  it("says expired for a stored credential that ran out, and stopped once there's none", async () => {
    const h = await setup();
    h.link("42");
    h.store("42", "live-1", "2026-01-01T00:00:00.000Z");
    h.tunnel.sync();
    expect(h.tunnel.status).toBe("expired");
    h.db.prepare("DELETE FROM tunnel_credential").run();
    h.tunnel.sync();
    expect(h.tunnel.status).toBe("stopped");
  });
});
