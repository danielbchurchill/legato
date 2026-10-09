import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { connectHomeServer, linkServer, listenApp, signIn } from "./testing/tunnel-harness.js";
import { startFixtureServer, sleep, type FixtureServerHandle } from "./testing/fixture-http-server.js";
import type { TunnelClient } from "../../server/src/tunnel/client.js";

describe("relay HTTP forwarding", () => {
  let db: Database;
  let app: FastifyInstance | undefined;
  let homeServers: TunnelClient[] = [];
  let fixtures: FixtureServerHandle[] = [];

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    for (const homeServer of homeServers) homeServer.stop();
    await app?.close();
    for (const fixture of fixtures) await fixture.close();
    app = undefined;
    homeServers = [];
    fixtures = [];
  });

  async function fixture(handler: Parameters<typeof startFixtureServer>[0]): Promise<FixtureServerHandle> {
    const started = await startFixtureServer(handler);
    fixtures.push(started);
    return started;
  }

  // An account, a server it has linked, that server's tunnel connected, and
  // the fixture standing in for the server's own port behind it.
  async function linkedAndConnected(
    tunnelUrl: string,
    handler: Parameters<typeof startFixtureServer>[0],
    account = signIn(db),
  ): Promise<{ serverId: string; cookieHeader: string }> {
    const target = await fixture(handler);
    const { serverId, credential } = linkServer(db, account.userId);
    homeServers.push(await connectHomeServer({ tunnelUrl, credential, targetBaseUrl: target.url }));
    return { serverId, cookieHeader: account.cookieHeader };
  }

  it("returns 401 when the caller has no relay session", async () => {
    app = buildApp({ db });
    const { httpUrl } = await listenApp(app);

    const response = await fetch(`${httpUrl}/relay/${"a".repeat(32)}/anything`);
    expect(response.status).toBe(401);
  });

  it("returns 404 for a server the account hasn't linked, connected or not", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const someoneElses = await linkedAndConnected(tunnelUrl, (_req, res) => res.end("not yours"));
    const { cookieHeader } = signIn(db);

    for (const serverId of [someoneElses.serverId, "b".repeat(32), "not-a-server-id"]) {
      const response = await fetch(`${httpUrl}/relay/${serverId}/anything`, { headers: { cookie: cookieHeader } });
      expect(response.status).toBe(404);
    }
  });

  it("returns 503 for a linked server whose tunnel isn't connected", async () => {
    app = buildApp({ db });
    const { httpUrl } = await listenApp(app);
    const { userId, cookieHeader } = signIn(db);
    const { serverId } = linkServer(db, userId);

    const response = await fetch(`${httpUrl}/relay/${serverId}/anything`, { headers: { cookie: cookieHeader } });
    expect(response.status).toBe(503);
  });

  it("round-trips a small JSON request end to end", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, (req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/stats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tracks: 337, artists: 42 }));
        return;
      }
      res.writeHead(404).end();
    });

    const response = await fetch(`${httpUrl}/relay/${serverId}/api/v1/stats`, { headers: { cookie: cookieHeader } });
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
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, (req, res) => {
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

    const requestBody = JSON.stringify({ name: "Late Night Debugging" });
    const response = await fetch(`${httpUrl}/relay/${serverId}/api/v1/playlists`, {
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

    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, async (req, res) => {
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

    const response = await fetch(`${httpUrl}/relay/${serverId}/big`, { headers: { cookie: cookieHeader } });
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
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, async (req, res) => {
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

    const [responseA, responseB] = await Promise.all([
      fetch(`${httpUrl}/relay/${serverId}/echo/a`, { headers: { cookie: cookieHeader } }),
      fetch(`${httpUrl}/relay/${serverId}/echo/b`, { headers: { cookie: cookieHeader } }),
    ]);
    const [bodyA, bodyB] = await Promise.all([responseA.text(), responseB.text()]);

    // If requestId demultiplexing were broken (e.g. a single "current
    // response" instead of a map keyed by requestId), these would come
    // back crossed or truncated instead of each matching its own request.
    expect(bodyA).toBe("alpha-first-alpha-second");
    expect(bodyB).toBe("bravo-first-bravo-second");
  });

  it("keeps two servers on one account connected at once, and each request reaches the server it names", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const account = signIn(db);
    const serverA = await linkedAndConnected(tunnelUrl, (req, res) => res.end(`server-A ${req.url}`), account);
    const serverB = await linkedAndConnected(tunnelUrl, (req, res) => res.end(`server-B ${req.url}`), account);
    expect(serverA.serverId).not.toBe(serverB.serverId);

    const [responseA, responseB, rootA] = await Promise.all([
      fetch(`${httpUrl}/relay/${serverA.serverId}/whoami`, { headers: { cookie: account.cookieHeader } }),
      fetch(`${httpUrl}/relay/${serverB.serverId}/whoami?x=1`, { headers: { cookie: account.cookieHeader } }),
      fetch(`${httpUrl}/relay/${serverA.serverId}`, { headers: { cookie: account.cookieHeader } }),
    ]);
    expect(await responseA.text()).toBe("server-A /whoami");
    expect(await responseB.text()).toBe("server-B /whoami?x=1");
    expect(await rootA.text()).toBe("server-A /");
    expect(homeServers.map((homeServer) => homeServer.state)).toEqual(["connected", "connected"]);
  });

  it("routes two accounts' requests to their own separate home-server tunnels", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const serverA = await linkedAndConnected(tunnelUrl, (_req, res) => res.end("home-server-A"));
    const serverB = await linkedAndConnected(tunnelUrl, (_req, res) => res.end("home-server-B"));

    const [responseA, responseB] = await Promise.all([
      fetch(`${httpUrl}/relay/${serverA.serverId}/whoami`, { headers: { cookie: serverA.cookieHeader } }),
      fetch(`${httpUrl}/relay/${serverB.serverId}/whoami`, { headers: { cookie: serverB.cookieHeader } }),
    ]);
    expect(await responseA.text()).toBe("home-server-A");
    expect(await responseB.text()).toBe("home-server-B");
  });

  it("keeps legato.fm's cookies on legato.fm, both ways", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, (req, res) => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "relay_session=planted; Path=/" });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null }));
    });

    const response = await fetch(`${httpUrl}/relay/${serverId}/api/v1/me`, {
      headers: { cookie: `${cookieHeader}; other=1`, authorization: "Bearer home-server-session" },
    });
    expect(await response.json()).toEqual({ cookie: null, authorization: "Bearer home-server-session" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("sandboxes everything served under /relay, so no home server's page runs as legato.fm", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const account = signIn(db);
    const { serverId, cookieHeader } = await linkedAndConnected(
      tunnelUrl,
      (req, res) => {
        if (req.url === "/page.html") {
          res.writeHead(200, { "content-type": "text/html", "x-content-type-options": "off" });
          res.end("<script>fetch('/auth/server-token', { method: 'POST' })</script>");
        } else if (req.url === "/picture.svg") {
          res.writeHead(200, { "content-type": "image/svg+xml", "content-security-policy": "default-src 'none'" });
          res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        } else {
          res.end("{}");
        }
      },
      account,
    );
    const get = (path: string, cookie = cookieHeader) => fetch(`${httpUrl}/relay/${path}`, { headers: { cookie } });

    const page = await get(`${serverId}/page.html`);
    expect(page.headers.get("content-type")).toBe("text/html");
    expect(page.headers.get("content-security-policy")).toBe("sandbox");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    // A server's own policy goes out beside the sandbox, never instead of it.
    const picture = await get(`${serverId}/picture.svg`);
    expect(picture.headers.get("content-security-policy")).toBe("default-src 'none', sandbox");
    expect(picture.headers.get("x-content-type-options")).toBe("nosniff");

    // The relay's own answers too: not signed in, not linked, not connected.
    const someoneElses = linkServer(db, signIn(db).userId).serverId;
    const notConnected = linkServer(db, account.userId).serverId;
    const refusals = [await get(`${serverId}/x`, ""), await get(`${someoneElses}/x`), await get(`${notConnected}/x`)];
    expect(refusals.map((response) => response.status)).toEqual([401, 404, 503]);
    for (const response of refusals) {
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("keeps a path that looks like a URL on the home server", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, (req, res) => res.end(`path ${req.url}`));

    const response = await fetch(`${httpUrl}/relay/${serverId}//example.com/x`, { headers: { cookie: cookieHeader } });
    expect(await response.text()).toBe("path //example.com/x");
  });
});

// What a home server sends back is checked before any of it reaches a
// device's response. Anyone can claim a server and get a credential, so a
// tunnel's frames are untrusted input: before this, a response-start with
// a status of 99999 threw inside the relay's message listener and took the
// whole relay down.
describe("frames a home server sends back", () => {
  let db: Database;
  let app: FastifyInstance | undefined;
  let sockets: WebSocket[] = [];

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await app?.close();
    app = undefined;
    sockets = [];
  });

  // A tunnel that answers every request with whatever frames `answer` makes
  // for it, the way a modified home server could.
  async function rawHomeServer(tunnelUrl: string, credential: string, answer: (requestId: string) => object[]) {
    const socket = new WebSocket(tunnelUrl);
    sockets.push(socket);
    const state = { closed: false, cancelled: [] as string[] };
    socket.addEventListener("close", () => (state.closed = true));
    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credential })));
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as { type: string; requestId: string };
        if (frame.type === "auth-ok") resolve();
        if (frame.type === "cancel") state.cancelled.push(frame.requestId);
        if (frame.type !== "request") return;
        for (const out of answer(frame.requestId)) socket.send(JSON.stringify({ requestId: frame.requestId, ...out }));
      });
    });
    return state;
  }

  async function setUp(answer: (requestId: string) => object[]) {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const account = signIn(db);
    const { serverId, credential } = linkServer(db, account.userId);
    const tunnel = await rawHomeServer(tunnelUrl, credential, answer);
    const get = (path = "/x") => fetch(`${httpUrl}/relay/${serverId}${path}`, { headers: { cookie: account.cookieHeader } });
    return { tunnel, get, httpUrl };
  }

  const start = (status: unknown, headers: unknown = {}) => ({ type: "response-start", status, headers });
  const chunk = (data: unknown) => ({ type: "response-chunk", data });
  const end = { type: "response-end" };

  it("answers a status HTTP can't carry with a 502, and keeps the tunnel", async () => {
    let status: unknown = 99999;
    const { tunnel, get } = await setUp(() => [start(status), chunk(Buffer.from("x").toString("base64")), end]);

    for (const bad of [99999, 99, 600, 101, 200.5]) {
      status = bad;
      const response = await get();
      expect(response.status).toBe(502);
    }
    status = 201;
    const fine = await get();
    expect(fine.status).toBe(201);
    expect(await fine.text()).toBe("x");
    expect(tunnel.closed).toBe(false);
  });

  it("drops a header HTTP can't carry and passes the rest", async () => {
    const { tunnel, get } = await setUp(() => [
      start(200, {
        "content-type": "text/plain",
        "x-split": "a\r\nset-cookie: relay_session=planted",
        "bad name": "x",
        "x-wide": "日本",
        "x-number": 5,
        "x-fine": "kept",
      }),
      chunk(Buffer.from("body").toString("base64")),
      end,
    ]);

    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body");
    expect(response.headers.get("x-fine")).toBe("kept");
    for (const name of ["x-split", "set-cookie", "x-wide", "x-number"]) expect(response.headers.get(name)).toBeNull();
    expect(tunnel.closed).toBe(false);
  });

  it("closes a tunnel that sends frames no Legato server sends, failing only that server's requests", async () => {
    const shapes: object[][] = [
      [start("200")],
      [start(200, "headers")],
      [start(200, ["x", "y"])],
      [start(200), chunk(42)],
      [start(200), chunk(undefined)],
      [chunk(Buffer.from("early").toString("base64"))],
      [start(200), start(200)],
    ];
    for (const frames of shapes) {
      const { tunnel, get, httpUrl } = await setUp(() => frames);
      const response = await get().catch(() => null);
      // A 502 if nothing had gone out yet. Once a status has, the body
      // breaks off rather than ending as if it were whole.
      if (response && response.status !== 502) await expect(response.text()).rejects.toThrow();
      const until = Date.now() + 2_000;
      while (!tunnel.closed && Date.now() < until) await sleep(10);
      expect(tunnel.closed).toBe(true);
      // The relay itself is still up.
      expect((await fetch(`${httpUrl}/health`)).status).toBe(200);
      await app!.close();
      app = undefined;
    }
  });
});
