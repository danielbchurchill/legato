import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { upsertUser, createSession } from "./accounts.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { mintTunnelCredential } from "./pairing.js";
import { connectFakeHomeServer, type FakeHomeServerHandle } from "./testing/fake-home-server.js";
import { startFixtureServer, sleep, type FixtureServerHandle } from "./testing/fixture-http-server.js";

async function listenApp(app: FastifyInstance): Promise<{ httpUrl: string; wsUrl: string }> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return { httpUrl: address, wsUrl: address.replace(/^http/, "ws") };
}

// Every /relay/* request in these tests needs a signed-in relay account —
// see routes/relay.ts's header comment for why the session, not a URL
// segment, decides which tunnel a request reaches. Signing in for real
// means a live OAuth round trip, so tests provision the account and
// session directly against the db (the same way server/'s auth.spec.ts
// tests its own upsertUser/createSession without a live round trip) and
// hand back a Cookie header any fetch() call below can reuse.
let signInCounter = 0;
function signIn(db: Database.Database): { userId: number; cookieHeader: string } {
  signInCounter += 1;
  const user = upsertUser(db, "google", {
    providerUserId: `test-user-${signInCounter}`,
    email: "test@example.com",
    displayName: "Test User",
    avatarUrl: null,
  });
  const { token } = createSession(db, user.id);
  return { userId: user.id, cookieHeader: `relay_session=${token}` };
}

describe("relay HTTP forwarding", () => {
  let db: Database.Database | undefined;
  let app: FastifyInstance | undefined;
  let homeServer: FakeHomeServerHandle | undefined;
  let fixture: FixtureServerHandle | undefined;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    homeServer?.close();
    await app?.close();
    await fixture?.close();
    app = undefined;
    homeServer = undefined;
    fixture = undefined;
    db = undefined;
  });

  it("returns 401 when the caller has no relay session", async () => {
    app = buildApp({ db: db! });
    const { httpUrl } = await listenApp(app);

    const response = await fetch(`${httpUrl}/relay/anything`);
    expect(response.status).toBe(401);
  });

  it("returns 503 when the caller is signed in but has no home server tunnel connected", async () => {
    app = buildApp({ db: db! });
    const { httpUrl } = await listenApp(app);
    const { cookieHeader } = signIn(db!);

    const response = await fetch(`${httpUrl}/relay/anything`, { headers: { cookie: cookieHeader } });
    expect(response.status).toBe(503);
  });

  it("round-trips a small JSON request end to end", async () => {
    fixture = await startFixtureServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/stats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tracks: 337, artists: 42 }));
        return;
      }
      res.writeHead(404).end();
    });

    app = buildApp({ db: db! });
    const { httpUrl, wsUrl } = await listenApp(app);
    const { userId, cookieHeader } = signIn(db!);
    const { token: credential } = mintTunnelCredential(db!, userId);
    homeServer = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: credential,
      targetBaseUrl: fixture.url,
    });

    const response = await fetch(`${httpUrl}/relay/api/v1/stats`, { headers: { cookie: cookieHeader } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tracks: 337, artists: 42 });
  });

  it("forwards a JSON POST body through to the home server unmodified", async () => {
    // Regression test: Fastify's built-in default parsers for
    // application/json and text/plain take precedence over a bare `*`
    // wildcard content-type parser regardless of registration order, so
    // a naive wildcard-only registration silently parses-then-drops any
    // JSON body a mobile client sends — see routes/relay.ts's header
    // comment on its content-type-parser registration.
    fixture = await startFixtureServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            contentType: req.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
    });

    app = buildApp({ db: db! });
    const { httpUrl, wsUrl } = await listenApp(app);
    const { userId, cookieHeader } = signIn(db!);
    const { token: credential } = mintTunnelCredential(db!, userId);
    homeServer = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: credential,
      targetBaseUrl: fixture.url,
    });

    const requestBody = JSON.stringify({ name: "Late Night Debugging" });
    const response = await fetch(`${httpUrl}/relay/api/v1/playlists`, {
      method: "POST",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      body: requestBody,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      contentType: "application/json",
      body: requestBody,
    });
  });

  it("streams a large chunked response incrementally, not buffered whole", async () => {
    const CHUNK_SIZE = 256 * 1024;
    const CHUNK_COUNT = 12; // 3MB total, well past anything that fits in one TCP write
    const chunkPayload = Buffer.alloc(CHUNK_SIZE, "x");

    fixture = await startFixtureServer(async (req, res) => {
      if (req.url !== "/big") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      for (let i = 0; i < CHUNK_COUNT; i++) {
        res.write(chunkPayload);
        await sleep(15);
      }
      res.end();
    });

    app = buildApp({ db: db! });
    const { httpUrl, wsUrl } = await listenApp(app);
    const { userId, cookieHeader } = signIn(db!);
    const { token: credential } = mintTunnelCredential(db!, userId);
    homeServer = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: credential,
      targetBaseUrl: fixture.url,
    });

    const response = await fetch(`${httpUrl}/relay/big`, { headers: { cookie: cookieHeader } });
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const receivedAt: number[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedAt.push(Date.now());
      totalBytes += value.length;
    }

    expect(totalBytes).toBe(CHUNK_SIZE * CHUNK_COUNT);
    // The real assertion: this arrived as multiple separate reads spread
    // over time, not one read after the relay quietly buffered the whole
    // 3MB body and flushed it at the end. A buffered implementation would
    // make receivedAt.length collapse toward 1 and the first-to-last gap
    // collapse toward 0 regardless of the 15ms writer delay above.
    expect(receivedAt.length).toBeGreaterThan(1);
    expect(receivedAt[receivedAt.length - 1] - receivedAt[0]).toBeGreaterThan(50);
  });

  it("demultiplexes two concurrent requests over the same tunnel connection", async () => {
    fixture = await startFixtureServer(async (req, res) => {
      if (req.url === "/echo/a") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("alpha-first-");
        await sleep(30);
        res.write("alpha-second");
        res.end();
        return;
      }
      if (req.url === "/echo/b") {
        // Staggered on purpose so the two responses' chunks genuinely
        // interleave on the wire (B's first chunk lands between A's two),
        // rather than the requests merely overlapping in start time.
        await sleep(10);
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("bravo-first-");
        await sleep(30);
        res.write("bravo-second");
        res.end();
        return;
      }
      res.writeHead(404).end();
    });

    app = buildApp({ db: db! });
    const { httpUrl, wsUrl } = await listenApp(app);
    const { userId, cookieHeader } = signIn(db!);
    const { token: credential } = mintTunnelCredential(db!, userId);
    homeServer = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: credential,
      targetBaseUrl: fixture.url,
    });

    const [responseA, responseB] = await Promise.all([
      fetch(`${httpUrl}/relay/echo/a`, { headers: { cookie: cookieHeader } }),
      fetch(`${httpUrl}/relay/echo/b`, { headers: { cookie: cookieHeader } }),
    ]);
    const [bodyA, bodyB] = await Promise.all([responseA.text(), responseB.text()]);

    // If requestId demultiplexing were broken (e.g. a single "current
    // response" instead of a map keyed by requestId), these would come
    // back crossed or truncated instead of each matching its own request.
    expect(bodyA).toBe("alpha-first-alpha-second");
    expect(bodyB).toBe("bravo-first-bravo-second");
  });

  it("routes two accounts' requests to their own separate home-server tunnels", async () => {
    const fixtureA = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("home-server-A");
    });
    const fixtureB = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("home-server-B");
    });

    app = buildApp({ db: db! });
    const { httpUrl, wsUrl } = await listenApp(app);

    const accountA = signIn(db!);
    const accountB = signIn(db!);
    const credentialA = mintTunnelCredential(db!, accountA.userId).token;
    const credentialB = mintTunnelCredential(db!, accountB.userId).token;

    const homeServerA = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: credentialA,
      targetBaseUrl: fixtureA.url,
    });
    const homeServerB = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: credentialB,
      targetBaseUrl: fixtureB.url,
    });

    try {
      const [responseA, responseB] = await Promise.all([
        fetch(`${httpUrl}/relay/whoami`, { headers: { cookie: accountA.cookieHeader } }),
        fetch(`${httpUrl}/relay/whoami`, { headers: { cookie: accountB.cookieHeader } }),
      ]);
      expect(await responseA.text()).toBe("home-server-A");
      expect(await responseB.text()).toBe("home-server-B");
    } finally {
      homeServerA.close();
      homeServerB.close();
      await fixtureA.close();
      await fixtureB.close();
    }
  });
});
