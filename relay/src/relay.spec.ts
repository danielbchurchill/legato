import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import type { Database } from "./sqlite.js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { RequestFrame } from "./protocol.js";
import { REQUEST_BODY_LIMIT } from "./routes/relay.js";
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

  it("carries a body up to REQUEST_BODY_LIMIT, and answers 413 past it without forwarding anything", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const received: number[] = [];
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, (req, res) => {
      let length = 0;
      req.on("data", (chunk: Buffer) => (length += chunk.length));
      req.on("end", () => {
        received.push(length);
        res.end(String(length));
      });
    });
    const post = (body: BodyInit, contentType: string) =>
      fetch(`${httpUrl}/relay/${serverId}/api/v1/layout/settled`, {
        method: "PUT",
        headers: { cookie: cookieHeader, "content-type": contentType },
        body,
        duplex: "half",
      } as RequestInit);

    const atLimit = await post(Buffer.alloc(REQUEST_BODY_LIMIT, "a"), "application/json");
    expect(await atLimit.text()).toBe(String(REQUEST_BODY_LIMIT));

    for (const contentType of ["application/json", "text/plain", "application/octet-stream"]) {
      const over = await post(Buffer.alloc(REQUEST_BODY_LIMIT + 1, "a"), contentType);
      expect(over.status).toBe(413);
      // Fastify's own refusal is sandboxed like everything else here.
      expect(over.headers.get("content-security-policy")).toBe("sandbox");
      expect(over.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // Without a Content-Length to refuse up front, it's cut off once past.
    const streamed = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(REQUEST_BODY_LIMIT / 4));
        controller.close();
      },
    });
    expect((await post(streamed, "application/octet-stream")).status).toBe(413);
    expect(received).toEqual([REQUEST_BODY_LIMIT]);
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

  it("forwards the path after the id as the device sent it, however the id was written", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, (req, res) => res.end(`path ${req.url}`));
    const get = async (path: string) => (await fetch(`${httpUrl}${path}`, { headers: { cookie: cookieHeader } })).text();

    // The decoded id is shorter than the raw one, which used to cut the
    // path short: this reached the server as /01/api/v1/health.
    const encodedId = `%${serverId.charCodeAt(0).toString(16)}${serverId.slice(1)}`;
    expect(await get(`/relay/${encodedId}/api/v1/health?x=1`)).toBe("path /api/v1/health?x=1");
    expect(await get(`/relay/${encodedId}?x=1`)).toBe("path /?x=1");
    expect(await get(`/relay/${serverId}/a%2Fb/c%20d?q=%E6%97%A5`)).toBe("path /a%2Fb/c%20d?q=%E6%97%A5");
  });

  it("tells the home server the device's address, which no device can put there itself", async () => {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const { serverId, cookieHeader } = await linkedAndConnected(tunnelUrl, (req, res) => res.end(String(req.headers["x-legato-tunnel"])));

    // The socket's peer, whatever the device says. Off Fly, as here, that
    // includes a Fly-Client-IP header, which only Fly's proxy may write
    // (rate-limit.ts's clientAddress, whose spec covers the header on Fly).
    const forged = await fetch(`${httpUrl}/relay/${serverId}/x`, {
      headers: { cookie: cookieHeader, "fly-client-ip": "203.0.113.9", "x-legato-tunnel": "127.0.0.2" },
    });
    expect(await forged.text()).toBe("127.0.0.1");
    const direct = await fetch(`${httpUrl}/relay/${serverId}/x`, { headers: { cookie: cookieHeader, "x-legato-tunnel": "10.0.0.1" } });
    expect(await direct.text()).toBe("127.0.0.1");
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
type Answer = (requestId: string, request: RequestFrame) => object[];

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
  async function rawHomeServer(tunnelUrl: string, credential: string, answer: Answer) {
    const socket = new WebSocket(tunnelUrl);
    sockets.push(socket);
    const state = { closed: false, cancelled: [] as string[] };
    socket.addEventListener("close", () => (state.closed = true));
    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credential })));
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as RequestFrame | { type: string; requestId: string };
        if (frame.type === "auth-ok") resolve();
        if (frame.type === "cancel") state.cancelled.push(frame.requestId);
        if (frame.type !== "request") return;
        for (const out of answer(frame.requestId, frame as RequestFrame)) {
          socket.send(JSON.stringify({ requestId: frame.requestId, ...out }));
        }
      });
    });
    return state;
  }

  async function setUp(answer: Answer) {
    app = buildApp({ db });
    const { httpUrl, tunnelUrl } = await listenApp(app);
    const account = signIn(db);
    const { serverId, credential } = linkServer(db, account.userId);
    const tunnel = await rawHomeServer(tunnelUrl, credential, answer);
    const headers = { cookie: account.cookieHeader };
    const url = (path: string) => `${httpUrl}/relay/${serverId}${path}`;
    const get = Object.assign((path = "/x") => fetch(url(path), { headers }), { url, headers });
    return { tunnel, get, httpUrl, serverId, cookie: account.cookieHeader };
  }

  // One request on a socket of its own, written by hand, and every byte
  // the relay writes back until it closes the connection or goes quiet.
  // What a pooled keep-alive connection (Fly's proxy to the relay) would
  // go on to read as the next response is whatever comes after the first.
  async function rawExchange(httpUrl: string, path: string, cookie: string, quietMs = 300): Promise<{ text: string; closed: boolean }> {
    const { hostname, port } = new URL(httpUrl);
    const socket = connect(Number(port), hostname);
    let text = "";
    let closed = false;
    socket.on("data", (data: Buffer) => (text += data.toString("latin1")));
    socket.on("close", () => (closed = true));
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`);
    let last = text.length;
    for (;;) {
      await sleep(quietMs);
      if (closed || text.length === last) break;
      last = text.length;
    }
    socket.destroy();
    return { text, closed };
  }

  async function waitForClose(tunnel: { closed: boolean }) {
    const until = Date.now() + 2_000;
    while (!tunnel.closed && Date.now() < until) await sleep(10);
  }

  const start = (status: unknown, headers: unknown = {}) => ({ type: "response-start", status, headers });
  const chunk = (data: unknown) => ({ type: "response-chunk", data });
  const text = (data: string) => chunk(Buffer.from(data).toString("base64"));
  const end = { type: "response-end" };

  it("never lets a server's Content-Length put a second response on the device's connection", async () => {
    // Fly's proxy keeps HTTP/1.1 connections to the relay open and reuses
    // them for other people's requests, so bytes past the declared length
    // would be read as the answer to someone else's next request, and
    // without the sandbox.
    const smuggled = "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 7\r\n\r\nsmuggle";
    const { tunnel, httpUrl, serverId, cookie } = await setUp(() => [start(200, { "content-length": "5" }), text(`hello${smuggled}`), end]);

    const { text: wire, closed } = await rawExchange(httpUrl, `/relay/${serverId}/x`, cookie);
    expect(wire).toStartWith("HTTP/1.1 200");
    expect(wire).not.toContain("smuggle");
    expect(closed).toBe(true);
    await waitForClose(tunnel);
    expect(tunnel.closed).toBe(true);
  });

  it("breaks the connection off when a body runs past its Content-Length", async () => {
    // Over two chunks: none of the second goes out.
    const long = await setUp(() => [start(200, { "content-length": "6" }), text("abcd"), text("efgh"), end]);
    const tooLong = await rawExchange(long.httpUrl, `/relay/${long.serverId}/x`, long.cookie);
    expect("abcd").toStartWith(tooLong.text.split("\r\n\r\n")[1]!);
    expect(tooLong.closed).toBe(true);
    await waitForClose(long.tunnel);
    expect(long.tunnel.closed).toBe(true);
  });

  it("breaks the connection off when a body ends short of its Content-Length", async () => {
    // A clean end would leave the device waiting for bytes that never
    // come, and reading the next response as the rest of this one.
    const short = await setUp(() => [start(200, { "content-length": "10" }), text("abc"), end]);
    const tooShort = await rawExchange(short.httpUrl, `/relay/${short.serverId}/x`, short.cookie);
    expect("abc").toStartWith(tooShort.text.split("\r\n\r\n")[1]!);
    expect(tooShort.closed).toBe(true);
    await waitForClose(short.tunnel);
    expect(short.tunnel.closed).toBe(true);
  });

  it("leaves off a Content-Length that isn't a plain number, and every hop-by-hop header", async () => {
    let headers: Record<string, string> = {};
    const { tunnel, get } = await setUp(() => [start(200, { "content-type": "text/plain", ...headers }), text("hello"), end]);

    for (const length of ["5x", "-5", "1e1", "0x5", "", "5, 5"]) {
      headers = { "content-length": length };
      const response = await get();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
    }
    // The same name twice, in two cases.
    headers = { "Content-Length": "5", "content-length": "500" };
    expect(await (await get()).text()).toBe("hello");

    headers = {
      "transfer-encoding": "gzip",
      connection: "close, cache-control",
      "keep-alive": "timeout=1",
      upgrade: "h2c",
      "cache-control": "no-store",
    };
    const response = await get();
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The relay's own connection headers, never the server's.
    expect(response.headers.get("upgrade")).toBeNull();
    expect(response.headers.get("keep-alive")).not.toBe("timeout=1");
    expect(response.headers.get("connection")).not.toContain("close");
    expect(tunnel.closed).toBe(false);
  });

  it("carries a 206 with its Content-Length, so a player can seek", async () => {
    const audio = "0123456789";
    const { tunnel, get } = await setUp((_id, request) => {
      const [first, last] = (request.headers.range ?? "bytes=0-9").slice(6).split("-").map(Number);
      return [
        start(206, {
          "content-type": "audio/flac",
          "accept-ranges": "bytes",
          "content-range": `bytes ${first}-${last}/${audio.length}`,
          "content-length": String(last! - first! + 1),
        }),
        text(audio.slice(first, last! + 1)),
        end,
      ];
    });

    for (const [range, body] of [["bytes=2-5", "2345"], ["bytes=6-9", "6789"], ["bytes=0-0", "0"]] as const) {
      const response = await fetch(get.url("/stream"), { headers: { ...get.headers, range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-length")).toBe(String(body.length));
      expect(response.headers.get("content-range")).toBe(`bytes ${range.slice(6)}/10`);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(await response.text()).toBe(body);
    }
    expect(tunnel.closed).toBe(false);
  });

  it("keeps legato.fm's cookies, storage and address bar out of a home server's hands", async () => {
    let location = "https://elsewhere.example/";
    const { tunnel, get, serverId } = await setUp(() => [
      start(302, {
        location,
        refresh: "0; url=https://elsewhere.example/",
        "clear-site-data": '"cookies", "storage"',
        "set-cookie": "relay_session=planted; Path=/",
        "access-control-allow-origin": "https://elsewhere.example",
        "access-control-allow-credentials": "true",
        link: "<https://elsewhere.example/x.css>; rel=preload; as=style",
        "content-type": "text/plain",
      }),
      text("moved"),
      end,
    ]);

    // A Legato server never redirects anywhere through the relay (its
    // only redirects are its own Google and GitHub sign-ins), so a
    // Location goes nowhere, not even to another of its own paths.
    for (const where of [location, `/relay/${serverId}/elsewhere`]) {
      location = where;
      const response = await fetch(get.url("/x"), { headers: get.headers, redirect: "manual" });
      expect(response.status).toBe(302);
      expect(await response.text()).toBe("moved");
      for (const name of ["location", "refresh", "clear-site-data", "set-cookie", "access-control-allow-origin", "link"]) {
        expect(response.headers.get(name)).toBeNull();
      }
      expect(response.headers.get("content-type")).toBe("text/plain");
    }
    expect(tunnel.closed).toBe(false);
  });

  it("passes the headers a home server's own routes send", async () => {
    // What server/src sends on the routes a client uses through the relay,
    // header for header, beside the ones @fastify/cors adds to every
    // answer (server/src/index.ts). A home server's client never sends a
    // Content-Length (server/src/tunnel/client.ts), so none here.
    const cors = { vary: "Origin", "access-control-allow-origin": "https://app.example", "access-control-allow-credentials": "true" };
    const routes: Record<string, { status: number; headers: Record<string, string> }> = {
      // routes/files.ts, sendFile: an original FLAC, and a seek in it.
      "/api/v1/files/1/stream": {
        status: 206,
        headers: {
          "content-type": "audio/flac",
          "cache-control": "private, no-cache",
          etag: '"abc123"',
          "accept-ranges": "bytes",
          "content-range": "bytes 2-5/10",
        },
      },
      // routes/files.ts: a transcode still being written.
      "/api/v1/files/1/stream?quality=opus160": {
        status: 200,
        headers: {
          "content-type": "audio/ogg; codecs=opus",
          "cache-control": "private, max-age=31536000, immutable",
          "accept-ranges": "bytes",
        },
      },
      // routes/cover.ts.
      "/api/v1/nodes/7/cover": {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          etag: '"cafe-thumb"',
          "cache-control": "private, max-age=86400",
          "x-cover-source": "musicbrainz",
        },
      },
      "/api/v1/stats": { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      // routes/auth.ts, the sign-in limiter.
      "/api/v1/auth/login": { status: 429, headers: { "content-type": "application/json; charset=utf-8", "retry-after": "30" } },
      // routes/web-client.ts.
      "/": { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } },
    };
    const { tunnel, get } = await setUp((_id, request) => {
      const route = routes[request.path]!;
      return [start(route.status, { ...route.headers, ...cors }), text("body"), end];
    });

    for (const [path, route] of Object.entries(routes)) {
      const response = await get(path);
      expect(response.status).toBe(route.status);
      expect(await response.text()).toBe("body");
      for (const [name, value] of Object.entries(route.headers)) expect(response.headers.get(name)).toBe(value);
      expect(response.headers.get("vary")).toBe("Origin");
      // Who may read legato.fm's answers is legato.fm's to say.
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
    }
    expect(tunnel.closed).toBe(false);
  });

  it("passes a HEAD's Content-Length with no body after it", async () => {
    const { tunnel, get } = await setUp((_id, request) =>
      request.method === "HEAD" ? [start(200, { "content-length": "10" }), end] : [start(200), text("after"), end],
    );

    const head = await fetch(get.url("/stream"), { method: "HEAD", headers: get.headers });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(await (await get()).text()).toBe("after");
    expect(tunnel.closed).toBe(false);
  });

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
    // Each one it gave up on, the server was told to stop sending.
    expect(tunnel.cancelled).toHaveLength(5);
  });

  it("tells the home server to stop when the device hangs up mid-answer", async () => {
    const { tunnel, get } = await setUp(() => [start(200, { "content-type": "audio/flac" }), chunk(Buffer.from("first").toString("base64"))]);
    const hangUp = new AbortController();
    const response = await fetch(get.url("/stream"), { headers: get.headers, signal: hangUp.signal });
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("first");
    hangUp.abort();

    const until = Date.now() + 2_000;
    while (tunnel.cancelled.length === 0 && Date.now() < until) await sleep(10);
    expect(tunnel.cancelled).toHaveLength(1);
    expect(tunnel.closed).toBe(false);
  });

  it("drops a header HTTP can't carry and passes the rest", async () => {
    const { tunnel, get } = await setUp(() => [
      start(200, {
        "content-type": "text/plain",
        etag: "a\r\nset-cookie: relay_session=planted",
        "bad name": "x",
        vary: "日本",
        "retry-after": 5,
        "cache-control": "no-store",
      }),
      chunk(Buffer.from("body").toString("base64")),
      end,
    ]);

    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body");
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const name of ["etag", "set-cookie", "retry-after"]) expect(response.headers.get(name)).toBeNull();
    // The relay's own, in place of the one it dropped.
    expect(response.headers.get("vary")).toBe("Origin");
    expect(tunnel.closed).toBe(false);
  });

  it("fails a request whose answer ends before it starts, rather than passing it off as a success", async () => {
    const { tunnel, get } = await setUp(() => [end]);

    const response = await fetch(get.url("/api/v1/nodes/7"), { method: "DELETE", headers: get.headers });
    expect(response.status).toBe(502);
    await waitForClose(tunnel);
    expect(tunnel.closed).toBe(true);
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
