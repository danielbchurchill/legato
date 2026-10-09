import { afterEach, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { installLegatoIdentity, LegatoIdentity } from "../auth/legatoIdentity.js";
import { fakeLegatoFetch, makeTestKey, signTestToken, testClaims, type LegatoReport } from "../auth/legato-test-keys.js";
import { buildTestApp, createOwnerForTest } from "../auth/test-app.js";
import { readTunnelCredential, storeTunnelCredential } from "../auth/tunnelCredential.js";
import type { Database } from "../sqlite.js";
import type { TunnelState } from "./client.js";
import { startFakeRelay } from "./fake-relay.js";
import { installRelayTunnel, RelayTunnel, tunnelUrl } from "./relayTunnel.js";

// Issue #310: when this server keeps a tunnel open to legato.fm, and with
// what. The privacy page's promise is the first test: a server that isn't
// linked never contacts legato.fm.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NEXT_YEAR = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();

async function setup(options: { answer?: (report: LegatoReport) => Response | Error; listen?: boolean } = {}) {
  const fake = startFakeRelay({ accept: (credential) => credential.startsWith("live-") });
  cleanups.push(() => fake.stop());
  const db = openDb(":memory:");
  const key = makeTestKey();
  const served = fakeLegatoFetch(() => [key], options.answer);
  const identity = new LegatoIdentity(db, { origin: fake.origin, fetch: served.impl });
  installLegatoIdentity(db, identity);
  cleanups.push(() => identity.stop());
  const { app } = await buildTestApp(db);
  cleanups.push(() => app.close());
  const owner = await createOwnerForTest(app);
  // Listening, for a spec whose requests come down the tunnel and are
  // replayed against this server; otherwise nothing answers on port 9.
  const port = options.listen ? Number(new URL(await app.listen({ port: 0, host: "127.0.0.1" })).port) : 9;
  const lines: { level: string; message: string }[] = [];
  const tunnel = new RelayTunnel(db, {
    port,
    log: (level, message) => lines.push({ level, message }),
    client: { backoff: { baseMs: 20, capMs: 80 } },
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
