import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import type { Database } from "./sqlite.js";
import { sleep, startFixtureServer, type FixtureServerHandle } from "./testing/fixture-http-server.js";
import { connectHomeServer, linkServer, listenApp, signIn, startHomeServer, waitForState } from "./testing/tunnel-harness.js";
import type { TunnelClient } from "../../server/src/tunnel/client.js";

// Issue #310: the tunnel's life on the relay's side, driven by the home
// server's own tunnel client. Two servers on one account, a relay that
// restarts, a credential revoked while its tunnel is up, a tunnel that
// goes quiet, and the state "your servers" reports for each.

type ServerList = {
  servers: { serverId: string; tunnel: { connected: boolean; connectedAt?: string; lastSeenAt?: string | null } }[];
};

const HEARTBEAT_MS = 50;

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}

describe("tunnel lifecycle", () => {
  let db: Database;
  let apps: FastifyInstance[] = [];
  let homeServers: TunnelClient[] = [];
  let fixture: FixtureServerHandle;
  let warnings: string[] = [];

  beforeEach(async () => {
    db = openDb(":memory:");
    warnings = [];
    fixture = await startFixtureServer((req, res) => res.end(`home ${req.url}`));
  });

  afterEach(async () => {
    for (const homeServer of homeServers) homeServer.stop();
    for (const app of apps) await app.close();
    await fixture.close();
    apps = [];
    homeServers = [];
  });

  async function relay(port = 0) {
    const app = buildApp({ db, tunnelHeartbeatMs: HEARTBEAT_MS });
    const opened = { count: 0 };
    app.addHook("onRequest", async (request) => {
      if (request.url === "/tunnel") opened.count += 1;
    });
    apps.push(app);
    return { app, opened, ...(await listenApp(app, port)) };
  }

  const log = (level: "info" | "warn", message: string) => {
    if (level === "warn") warnings.push(message);
  };

  async function homeServer(tunnelUrl: string, credential: string): Promise<TunnelClient> {
    const client = await connectHomeServer({ tunnelUrl, credential, targetBaseUrl: fixture.url, log });
    homeServers.push(client);
    return client;
  }

  async function yourServers(httpUrl: string, token: string): Promise<ServerList["servers"]> {
    const response = await fetch(`${httpUrl}/linked-servers`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return ((await response.json()) as ServerList).servers;
  }

  it("reports each linked server's tunnel: connected and since when, or when it was last seen", async () => {
    const { httpUrl, tunnelUrl } = await relay();
    const account = signIn(db);
    const serverA = linkServer(db, account.userId);
    const serverB = linkServer(db, account.userId);
    const before = Date.now() - 1_000;

    const clientA = await homeServer(tunnelUrl, serverA.credential);
    let servers = await yourServers(httpUrl, account.token);
    expect(servers.map((server) => server.serverId)).toEqual([serverA.serverId, serverB.serverId]);
    expect(servers[0]!.tunnel.connected).toBe(true);
    expect(Date.parse(servers[0]!.tunnel.connectedAt!)).toBeGreaterThanOrEqual(before);
    expect(servers[1]!.tunnel).toEqual({ connected: false, lastSeenAt: null });

    clientA.stop();
    await until(async () => !(await yourServers(httpUrl, account.token))[0]!.tunnel.connected);
    servers = await yourServers(httpUrl, account.token);
    expect(Date.parse(servers[0]!.tunnel.lastSeenAt!)).toBeGreaterThanOrEqual(before);
  });

  it("brings a server's tunnel back once the relay is back after a restart", async () => {
    const first = await relay();
    const port = Number(new URL(first.httpUrl).port);
    const account = signIn(db);
    const { serverId, credential } = linkServer(db, account.userId);
    const client = await homeServer(first.tunnelUrl, credential);

    await first.app.close();
    await waitForState(client, "waiting");

    const second = await relay(port);
    await waitForState(client, "connected");
    const response = await fetch(`${second.httpUrl}/relay/${serverId}/after-restart`, { headers: { cookie: account.cookieHeader } });
    expect(await response.text()).toBe("home /after-restart");
    expect(warnings).toEqual([]);
  });

  it("closes a tunnel whose credential is revoked, and the server stops for good with one warning", async () => {
    const { httpUrl, tunnelUrl } = await relay();
    const account = signIn(db);
    const { serverId, credential } = linkServer(db, account.userId);
    const client = await homeServer(tunnelUrl, credential);

    db.prepare("DELETE FROM tunnel_credentials WHERE token = ?").run(credential);
    await waitForState(client, "refused");

    // Several heartbeats and retry delays later, it hasn't come back.
    await sleep(HEARTBEAT_MS * 6);
    expect(client.state).toBe("refused");
    expect((await yourServers(httpUrl, account.token))[0]!.tunnel.connected).toBe(false);
    const response = await fetch(`${httpUrl}/relay/${serverId}/x`, { headers: { cookie: account.cookieHeader } });
    expect(response.status).toBe(503);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("link this server to your legato.fm account again");
  });

  it("stops a server whose credential is refused at sign-in, without retrying", async () => {
    const { tunnelUrl, opened } = await relay();
    const client = startHomeServer({ tunnelUrl, credential: "a-credential-legato-fm-never-minted", targetBaseUrl: fixture.url, log });
    homeServers.push(client);

    await waitForState(client, "refused");
    await sleep(HEARTBEAT_MS * 6);
    expect(client.state).toBe("refused");
    expect(opened.count).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it("drops a tunnel that stops answering pings, and keeps when it was last seen", async () => {
    const { httpUrl, tunnelUrl } = await relay();
    const account = signIn(db);
    const { credential } = linkServer(db, account.userId);

    const socket = new WebSocket(tunnelUrl);
    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credential })));
      socket.addEventListener("message", () => resolve());
    });
    expect((await yourServers(httpUrl, account.token))[0]!.tunnel.connected).toBe(true);

    // Stops reading, so the relay's pings go unanswered: what a server that
    // lost power or its network looks like from here.
    socket.pause();
    await until(async () => !(await yourServers(httpUrl, account.token))[0]!.tunnel.connected);
    expect((await yourServers(httpUrl, account.token))[0]!.tunnel.lastSeenAt).not.toBeNull();
    socket.terminate();
  });

  it("records when it last heard from a server that went quiet, not when it gave up on it", async () => {
    const { httpUrl, tunnelUrl } = await relay();
    const account = signIn(db);
    const { credential } = linkServer(db, account.userId);

    // The relay's clock says 2026-01-01 while this server signs in.
    // SQLite's own datetime('now') doesn't follow it, so what's written
    // when the tunnel closes shows which time the relay recorded.
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const socket = new WebSocket(tunnelUrl);
    try {
      await new Promise<void>((resolve) => {
        socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credential })));
        socket.addEventListener("message", () => resolve());
      });
      socket.pause();
    } finally {
      setSystemTime();
    }

    await until(async () => !(await yourServers(httpUrl, account.token))[0]!.tunnel.connected);
    expect((await yourServers(httpUrl, account.token))[0]!.tunnel.lastSeenAt).toBe("2026-01-01T00:00:00.000Z");
    socket.terminate();
  });

  it("lets a newer connection for the same server replace the old one, and fails what was pending on the old one", async () => {
    const { httpUrl, tunnelUrl } = await relay();
    const account = signIn(db);
    const { serverId, credential } = linkServer(db, account.userId);

    // A connection that takes the request and never answers it.
    const stale = new WebSocket(tunnelUrl);
    let requested!: () => void;
    const gotRequest = new Promise<void>((resolve) => (requested = resolve));
    await new Promise<void>((resolve) => {
      stale.addEventListener("open", () => stale.send(JSON.stringify({ type: "auth", secret: credential })));
      stale.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as { type: string };
        if (frame.type === "auth-ok") resolve();
        if (frame.type === "request") requested();
      });
    });
    const pending = fetch(`${httpUrl}/relay/${serverId}/hangs`, { headers: { cookie: account.cookieHeader } });
    await gotRequest;

    await homeServer(tunnelUrl, credential);
    expect((await pending).status).toBe(502);
    const response = await fetch(`${httpUrl}/relay/${serverId}/fresh`, { headers: { cookie: account.cookieHeader } });
    expect(await response.text()).toBe("home /fresh");
  });
});
