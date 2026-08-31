import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { connectFakeHomeServer, type FakeHomeServerHandle } from "./testing/fake-home-server.js";
import { startFixtureServer, sleep, type FixtureServerHandle } from "./testing/fixture-http-server.js";

const SECRET = "top-secret-value";

async function listenApp(app: FastifyInstance): Promise<{ httpUrl: string; wsUrl: string }> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return { httpUrl: address, wsUrl: address.replace(/^http/, "ws") };
}

describe("relay HTTP forwarding", () => {
  let app: FastifyInstance | undefined;
  let homeServer: FakeHomeServerHandle | undefined;
  let fixture: FixtureServerHandle | undefined;

  afterEach(async () => {
    homeServer?.close();
    await app?.close();
    await fixture?.close();
    app = undefined;
    homeServer = undefined;
    fixture = undefined;
  });

  it("returns 503 when no home server tunnel is connected", async () => {
    app = buildApp({ sharedSecret: SECRET });
    const { httpUrl } = await listenApp(app);

    const response = await fetch(`${httpUrl}/relay/anything`);
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

    app = buildApp({ sharedSecret: SECRET });
    const { httpUrl, wsUrl } = await listenApp(app);
    homeServer = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: SECRET,
      targetBaseUrl: fixture.url,
    });

    const response = await fetch(`${httpUrl}/relay/api/v1/stats`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tracks: 337, artists: 42 });
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

    app = buildApp({ sharedSecret: SECRET });
    const { httpUrl, wsUrl } = await listenApp(app);
    homeServer = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: SECRET,
      targetBaseUrl: fixture.url,
    });

    const response = await fetch(`${httpUrl}/relay/big`);
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

    app = buildApp({ sharedSecret: SECRET });
    const { httpUrl, wsUrl } = await listenApp(app);
    homeServer = await connectFakeHomeServer({
      tunnelUrl: `${wsUrl}/tunnel`,
      secret: SECRET,
      targetBaseUrl: fixture.url,
    });

    const [responseA, responseB] = await Promise.all([
      fetch(`${httpUrl}/relay/echo/a`),
      fetch(`${httpUrl}/relay/echo/b`),
    ]);
    const [bodyA, bodyB] = await Promise.all([responseA.text(), responseB.text()]);

    // If requestId demultiplexing were broken (e.g. a single "current
    // response" instead of a map keyed by requestId), these would come
    // back crossed or truncated instead of each matching its own request.
    expect(bodyA).toBe("alpha-first-alpha-second");
    expect(bodyB).toBe("bravo-first-bravo-second");
  });
});
