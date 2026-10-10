import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import type { Database } from "./sqlite.js";
import { MAX_LIVE_CREDENTIALS_PER_SERVER, tunnelCredentialHolder } from "./pairing.js";
import { sleep, startFixtureServer, type FixtureServerHandle } from "./testing/fixture-http-server.js";
import {
  connectHomeServer,
  linkServer,
  listenApp,
  rotateFrame,
  rotateSignature,
  serverKey,
  signIn,
  startHomeServer,
  TEST_ISSUER,
  waitForState,
} from "./testing/tunnel-harness.js";
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
  // Sockets a spec opens by hand, closed however the spec ends.
  let rawSockets: WebSocket[] = [];

  beforeEach(async () => {
    db = openDb(":memory:");
    warnings = [];
    fixture = await startFixtureServer((req, res) => res.end(`home ${req.url}`));
  });

  afterEach(async () => {
    for (const socket of rawSockets) socket.terminate();
    rawSockets = [];
    for (const homeServer of homeServers) homeServer.stop();
    for (const app of apps) await app.close();
    await fixture.close();
    apps = [];
    homeServers = [];
  });

  async function relay(port = 0) {
    const app = buildApp({ db, tunnelHeartbeatMs: HEARTBEAT_MS, auth: { config: { callbackBaseUrl: TEST_ISSUER } } });
    const opened = { count: 0 };
    app.addHook("onRequest", async (request) => {
      if (request.url === "/tunnel") opened.count += 1;
    });
    apps.push(app);
    return { app, opened, ...(await listenApp(app, port)) };
  }

  function rawSocket(url: string): WebSocket {
    const socket = new WebSocket(url);
    rawSockets.push(socket);
    return socket;
  }

  const log = (level: "info" | "warn", message: string) => {
    if (level === "warn") warnings.push(message);
  };

  async function homeServer(
    tunnelUrl: string,
    credential: string,
    onCredential?: (replacement: { credential: string; expiresAt: string }) => boolean,
  ): Promise<TunnelClient> {
    const client = await connectHomeServer({ tunnelUrl, credential, targetBaseUrl: fixture.url, log, onCredential });
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

    // Both linked in the same second, so the list is in id order.
    const tunnelOf = async (serverId: string) =>
      (await yourServers(httpUrl, account.token)).find((server) => server.serverId === serverId)!.tunnel;
    const clientA = await homeServer(tunnelUrl, serverA.credential);
    const servers = await yourServers(httpUrl, account.token);
    expect(servers.map((server) => server.serverId)).toEqual([serverA.serverId, serverB.serverId].sort());
    expect((await tunnelOf(serverA.serverId)).connected).toBe(true);
    expect(Date.parse((await tunnelOf(serverA.serverId)).connectedAt!)).toBeGreaterThanOrEqual(before);
    expect(await tunnelOf(serverB.serverId)).toEqual({ connected: false, lastSeenAt: null });

    clientA.stop();
    await until(async () => !(await tunnelOf(serverA.serverId)).connected);
    expect(Date.parse((await tunnelOf(serverA.serverId)).lastSeenAt!)).toBeGreaterThanOrEqual(before);
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

  it("closes a tunnel whose credential is revoked, and the server stops with one warning until its long wait is up", async () => {
    const { httpUrl, tunnelUrl } = await relay();
    const account = signIn(db);
    const { serverId, credential } = linkServer(db, account.userId);
    const client = await homeServer(tunnelUrl, credential);

    db.prepare("DELETE FROM tunnel_credentials WHERE token = ?").run(credential);
    await waitForState(client, "refused");

    // Several heartbeats and retry delays later, it hasn't come back: the
    // next try after a refusal is an hour away.
    await sleep(HEARTBEAT_MS * 6);
    expect(client.state).toBe("refused");
    expect((await yourServers(httpUrl, account.token))[0]!.tunnel.connected).toBe(false);
    const response = await fetch(`${httpUrl}/relay/${serverId}/x`, { headers: { cookie: account.cookieHeader } });
    expect(response.status).toBe(503);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("link this server to your legato.fm account again");
  });

  it("stops a server whose credential is refused at sign-in, without retrying on the short backoff", async () => {
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

    const socket = rawSocket(tunnelUrl);
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
  });

  it("records when it last heard from a server that went quiet, not when it gave up on it", async () => {
    const { httpUrl, tunnelUrl } = await relay();
    const account = signIn(db);
    const { credential } = linkServer(db, account.userId);

    // The relay's clock says 2026-01-01 while this server signs in.
    // SQLite's own datetime('now') doesn't follow it, so what's written
    // when the tunnel closes shows which time the relay recorded.
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const socket = rawSocket(tunnelUrl);
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
  });

  it("lets a newer connection for the same server replace the old one, and fails what was pending on the old one", async () => {
    const { httpUrl, tunnelUrl } = await relay();
    const account = signIn(db);
    const { serverId, credential } = linkServer(db, account.userId);

    // A connection that takes the request and never answers it.
    const stale = rawSocket(tunnelUrl);
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

  // Issue #115: rotation over the tunnel the server is signed in with.
  describe("rotation", () => {
    const credentials = (serverId: string) =>
      (db.prepare("SELECT token FROM tunnel_credentials WHERE server_id = ? ORDER BY rowid").all(serverId) as { token: string }[]).map(
        (row) => row.token,
      );

    async function signedInSocket(tunnelUrl: string, credential: string): Promise<{ socket: WebSocket; frames: { type: string }[] }> {
      const socket = rawSocket(tunnelUrl);
      const frames: { type: string }[] = [];
      await new Promise<void>((resolve) => {
        socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credential })));
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as { type: string };
          frames.push(frame);
          if (frame.type === "auth-ok") resolve();
        });
      });
      return { socket, frames };
    }

    it("hands the server a 90-day replacement, moves its open tunnel onto it, and retires the old one", async () => {
      const { httpUrl, tunnelUrl, opened } = await relay();
      const account = signIn(db);
      const { serverId, credential, key } = linkServer(db, account.userId);
      const stored: { credential: string; expiresAt: string }[] = [];
      const client = await homeServer(tunnelUrl, credential, (replacement) => {
        stored.push(replacement);
        return true;
      });

      expect(client.askForReplacement(rotateSignature(key, credential))).toBe(true);
      await until(() => credentials(serverId).length === 1 && credentials(serverId)[0] !== credential);
      const [replacement] = stored;
      expect(credentials(serverId)).toEqual([replacement!.credential]);
      expect(client.credential).toBe(replacement!.credential);
      expect(tunnelCredentialHolder(db, replacement!.credential)).toEqual({ relayUserId: account.userId, serverId });
      const days = (Date.parse(replacement!.expiresAt) - Date.now()) / (24 * 3600 * 1000);
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);

      // The same connection, still serving, and the heartbeat now checks the
      // new credential: the old one is gone, and it stays up.
      expect(opened.count).toBe(1);
      await sleep(HEARTBEAT_MS * 3);
      expect(client.state).toBe("connected");
      const response = await fetch(`${httpUrl}/relay/${serverId}/after-rotation`, { headers: { cookie: account.cookieHeader } });
      expect(await response.text()).toBe("home /after-rotation");
      expect(warnings).toEqual([]);
    });

    // The review's stolen credential: a copy of it signs a tunnel in, as it
    // always could, but renewing it takes the server's own key.
    it("refuses a rotate with no proof, one from another key, or one for another credential, and mints nothing", async () => {
      const { tunnelUrl } = await relay();
      const account = signIn(db);
      const { serverId, credential, key } = linkServer(db, account.userId);
      const other = linkServer(db, account.userId);

      // One connection each: a refused ask still counts against the minute.
      const asks = [
        { type: "rotate" },
        rotateFrame(serverKey(), credential),
        rotateFrame(other.key, credential),
        rotateFrame(key, other.credential),
        rotateFrame(key, credential, Math.floor(Date.now() / 1000) - 10 * 60),
        { ...rotateFrame(key, credential), issuedAt: String(Math.floor(Date.now() / 1000)) },
      ];
      const sockets = [];
      for (const ask of asks) {
        const copy = await signedInSocket(tunnelUrl, credential);
        copy.socket.send(JSON.stringify(ask));
        sockets.push(copy);
      }
      await sleep(100);
      expect(sockets.flatMap((copy) => copy.frames).filter((frame) => frame.type === "credential")).toEqual([]);
      expect(credentials(serverId)).toEqual([credential]);

      // The server's own proof, on a connection of its own, still works.
      const real = await signedInSocket(tunnelUrl, credential);
      real.socket.send(JSON.stringify(rotateFrame(key, credential)));
      await until(() => real.frames.some((frame) => frame.type === "credential"));
    });

    it("doesn't renew a credential whose account no longer links the server", async () => {
      // A credential left behind by an unlink from before 5d7f91f, when
      // removing the pair didn't take its credentials with it.
      const { tunnelUrl } = await relay();
      const account = signIn(db);
      const { serverId, credential, key } = linkServer(db, account.userId);
      db.prepare("DELETE FROM linked_servers WHERE relay_user_id = ? AND server_id = ?").run(account.userId, serverId);

      const { socket, frames } = await signedInSocket(tunnelUrl, credential);
      socket.send(JSON.stringify(rotateFrame(key, credential)));
      await sleep(100);
      expect(frames.some((frame) => frame.type === "credential")).toBe(false);
      expect(credentials(serverId)).toEqual([credential]);
    });

    it("retires nothing when the server can't store the replacement", async () => {
      const { tunnelUrl } = await relay();
      const account = signIn(db);
      const { serverId, credential, key } = linkServer(db, account.userId);
      const client = await homeServer(tunnelUrl, credential, () => false);

      client.askForReplacement(rotateSignature(key, credential));
      await until(() => credentials(serverId).length === 2);
      await sleep(HEARTBEAT_MS * 3);
      expect(client.credential).toBe(credential);
      expect(client.state).toBe("connected");
      expect(credentials(serverId)[0]).toBe(credential);
    });

    it("answers one ask a minute from a connection, and stops minting once a server holds too many", async () => {
      const { tunnelUrl } = await relay();
      const account = signIn(db);
      const { serverId, credential, key } = linkServer(db, account.userId);

      const first = await signedInSocket(tunnelUrl, credential);
      first.socket.send(JSON.stringify(rotateFrame(key, credential)));
      first.socket.send(JSON.stringify(rotateFrame(key, credential)));
      await until(() => first.frames.some((frame) => frame.type === "credential"));
      await sleep(50);
      expect(first.frames.filter((frame) => frame.type === "credential")).toHaveLength(1);
      expect(credentials(serverId)).toHaveLength(2);

      // New connections with the same credential, each asking once and
      // never moving onto what they got.
      for (let i = 2; i < MAX_LIVE_CREDENTIALS_PER_SERVER + 2; i++) {
        const next = await signedInSocket(tunnelUrl, credential);
        next.socket.send(JSON.stringify(rotateFrame(key, credential)));
        await sleep(30);
      }
      expect(credentials(serverId)).toHaveLength(MAX_LIVE_CREDENTIALS_PER_SERVER);
    });

    it("refuses a tunnel that tries to move onto another server's credential, and leaves that server's alone", async () => {
      const { tunnelUrl } = await relay();
      const account = signIn(db);
      const mine = linkServer(db, account.userId);
      const older = linkServer(db, account.userId);
      const theirs = linkServer(db, account.userId, older.key);

      const { socket, frames } = await signedInSocket(tunnelUrl, mine.credential);
      const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
      socket.send(JSON.stringify({ type: "auth", secret: theirs.credential }));
      expect(await closed).toBe(4001);
      expect(frames.at(-1)).toMatchObject({ type: "auth-error" });
      // Signing in with theirs would have retired the older one.
      expect(credentials(theirs.serverId)).toEqual([older.credential, theirs.credential]);
    });

    // A tunnel that drops partway through: whichever side of the drop the
    // replacement was on, the server comes back, and nothing it might still
    // hold is retired before it's been used.
    it("lets a server whose tunnel dropped before the replacement reached it back in on the old one", async () => {
      const { tunnelUrl } = await relay();
      const account = signIn(db);
      const { serverId, credential, key } = linkServer(db, account.userId);

      const lost = await signedInSocket(tunnelUrl, credential);
      lost.socket.send(JSON.stringify(rotateFrame(key, credential)));
      lost.socket.terminate();
      await until(() => credentials(serverId).length === 2);
      const unused = credentials(serverId)[1]!;

      const client = await homeServer(tunnelUrl, credential, () => true);
      expect(client.askForReplacement(rotateSignature(key, credential))).toBe(true);
      await until(() => client.credential !== credential);
      await until(() => credentials(serverId).length === 1);
      // The new one's first use retires both the old one and the one that never arrived.
      expect(credentials(serverId)).toEqual([client.credential]);
      expect(client.credential).not.toBe(unused);
    });

    it("retires the old credential when a server whose tunnel dropped before it moved comes back on the replacement", async () => {
      const { tunnelUrl } = await relay();
      const account = signIn(db);
      const { serverId, credential, key } = linkServer(db, account.userId);

      const dropped = await signedInSocket(tunnelUrl, credential);
      dropped.socket.send(JSON.stringify(rotateFrame(key, credential)));
      await until(() => dropped.frames.some((frame) => frame.type === "credential"));
      dropped.socket.terminate();
      const { credential: replacement } = dropped.frames.find((frame) => frame.type === "credential") as unknown as { credential: string };
      expect(credentials(serverId)).toEqual([credential, replacement]);

      const client = await homeServer(tunnelUrl, replacement);
      expect(client.state).toBe("connected");
      expect(credentials(serverId)).toEqual([replacement]);
    });

    it("mints no replacement for a credential revoked while its tunnel was up", async () => {
      const { tunnelUrl } = await relay();
      const account = signIn(db);
      const { serverId, credential, key } = linkServer(db, account.userId);
      const { socket, frames } = await signedInSocket(tunnelUrl, credential);

      db.prepare("DELETE FROM tunnel_credentials WHERE token = ?").run(credential);
      socket.send(JSON.stringify(rotateFrame(key, credential)));
      await sleep(50);
      expect(frames.some((frame) => frame.type === "credential")).toBe(false);
      expect(credentials(serverId)).toEqual([]);
    });
  });
});
