import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "bun:test";
import { buildTestApp } from "../auth/test-app.js";
import { openDb } from "../db.js";
import { mediaSlotsInUse } from "../media/queue.js";
import { filesRoutes } from "../routes/files.js";
import { backoffDelay, TunnelClient, type TunnelState } from "./client.js";
import { startFakeRelay, type FakeRelay } from "./fake-relay.js";

// Issue #310: this server's end of legato.fm's tunnel, against a stand-in
// relay. relay/src/tunnel.spec.ts runs the same client against the real one.

const FAST = { baseMs: 20, capMs: 80 };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function waitFor(client: TunnelClient, state: TunnelState, timeoutMs = 3_000): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stayed ${client.state}, never ${state}`)), timeoutMs);
    const off = client.onState((next) => {
      if (next !== state) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function relay(accept: (credential: string) => boolean = () => true): FakeRelay {
  const started = startFakeRelay({ accept });
  cleanups.push(() => started.stop());
  return started;
}

function client(url: string, target: string, extra: Partial<ConstructorParameters<typeof TunnelClient>[0]> = {}) {
  const started = new TunnelClient({ url, credential: "the-credential", target, backoff: FAST, ...extra });
  cleanups.push(() => started.stop());
  started.start();
  return started;
}

async function listen(app: FastifyInstance): Promise<string> {
  cleanups.push(() => app.close());
  return app.listen({ port: 0, host: "127.0.0.1" });
}

describe("backoffDelay", () => {
  it("doubles from the base up to the cap, with up to half of each delay left to chance", () => {
    const backoff = { baseMs: 1_000, capMs: 60_000 };
    expect([0, 1, 2, 3, 6, 7, 20].map((attempt) => backoffDelay(attempt, backoff, () => 1))).toEqual([
      1_000, 2_000, 4_000, 8_000, 60_000, 60_000, 60_000,
    ]);
    expect(backoffDelay(3, backoff, () => 0)).toBe(4_000);
    expect(backoffDelay(3, backoff, () => 0.5)).toBe(6_000);
  });
});

describe("TunnelClient", () => {
  it("signs in with its credential, as legato-server and nothing more specific", async () => {
    const fake = relay();
    const tunnel = client(fake.url, "http://127.0.0.1:9");
    await waitFor(tunnel, "connected");
    expect(fake.auths).toEqual(["the-credential"]);
    expect(fake.userAgents).toEqual(["legato-server"]);
  });

  it("replays a request against this server, where it never counts as coming from this machine", async () => {
    // A server with no owner shows its setup code to a page on this machine
    // (auth/setupCode.ts). The tunnel replays requests from 127.0.0.1, so
    // without its mark a request from anywhere would look like one.
    const { app } = await buildTestApp(openDb(":memory:"));
    const origin = await listen(app);
    const direct = await fetch(`${origin}/api/v1/auth/setup`);
    expect(direct.status).toBe(200);

    const fake = relay();
    const tunnel = client(fake.url, origin);
    await waitFor(tunnel, "connected");
    const relayed = await fake.request({
      method: "GET",
      path: "/api/v1/auth/setup",
      // A device can't take the mark off by sending its own.
      headers: { "x-legato-tunnel": "", host: "127.0.0.1" },
    });
    expect(relayed.status).toBe(403);
    expect(JSON.parse(relayed.body.toString()).reason).toBe("setup_code_hidden");
  });

  it("streams audio through the existing stream route, ranges included", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "legato-tunnel-stream-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sourcePath = path.join(dir, "track.flac");
    execFileSync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", sourcePath], { stdio: "ignore" });
    const db = openDb(":memory:");
    const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as { id: number };
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
    const { id: fileId } = db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, file_hash)
         VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 0, ?) RETURNING id`,
      )
      .get(node.id, root.id, sourcePath, "abcdef0123456789abcdef0123456789abcdef01") as { id: number };
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir: path.join(dir, "streams") }), { prefix: "/api/v1" });
    const origin = await listen(app);

    const fake = relay();
    const tunnel = client(fake.url, origin);
    await waitFor(tunnel, "connected");
    const source = readFileSync(sourcePath);

    const whole = await fake.request({ method: "GET", path: `/api/v1/files/${fileId}/stream`, headers: {} });
    expect(whole.status).toBe(200);
    expect(whole.headers["content-type"]).toBe("audio/flac");
    expect(whole.body.equals(source)).toBe(true);

    const part = await fake.request({
      method: "GET",
      path: `/api/v1/files/${fileId}/stream?quality=original`,
      headers: { range: "bytes=100-199" },
    });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 100-199/${source.length}`);
    expect(part.body.equals(source.subarray(100, 200))).toBe(true);
  });

  it("gives a transcode's media-queue slot back when legato.fm cancels the stream", async () => {
    // Twenty minutes of audio: a few seconds of encoding, still going when
    // the device hangs up.
    const dir = mkdtempSync(path.join(tmpdir(), "legato-tunnel-cancel-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sourcePath = path.join(dir, "long.flac");
    execFileSync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1200", sourcePath], { stdio: "ignore" });
    const db = openDb(":memory:");
    const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as { id: number };
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
    const { id: fileId } = db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, file_hash)
         VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 0, ?) RETURNING id`,
      )
      .get(node.id, root.id, sourcePath, "cafe0123456789abcdef0123456789abcdef0123") as { id: number };
    const cacheDir = path.join(dir, "streams");
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir, abandonGraceMs: 50 }), { prefix: "/api/v1" });
    const origin = await listen(app);

    const fake = relay();
    const tunnel = client(fake.url, origin);
    await waitFor(tunnel, "connected");
    const before = mediaSlotsInUse();
    void fake.request({ method: "GET", path: `/api/v1/files/${fileId}/stream?quality=opus160`, headers: {} }).catch(() => {});
    const shard = path.join(cacheDir, "opus160", "ca");
    while (!existsSync(shard) || readdirSync(shard).length === 0) await sleep(10);
    expect(mediaSlotsInUse()).toBe(before + 1);

    fake.send({ type: "cancel", requestId: fake.lastRequestId });
    const deadline = Date.now() + 2_000;
    while ((mediaSlotsInUse() > before || readdirSync(shard).length > 0) && Date.now() < deadline) await sleep(10);
    expect(mediaSlotsInUse()).toBe(before);
    // Nothing left that looks like a finished variant, nor a temp file.
    expect(readdirSync(shard)).toEqual([]);
  });

  it("answers a path that isn't a path on this server with an error, not a request elsewhere", async () => {
    const fake = relay();
    const tunnel = client(fake.url, "http://127.0.0.1:9");
    await waitFor(tunnel, "connected");
    await expect(fake.request({ method: "GET", path: "http://example.com/", headers: {} })).rejects.toThrow("not a path on this server");
  });

  it("replays a path with raw UTF-8 in it as its percent-encoding, rather than crashing", async () => {
    // Sent unencoded, a search for 日本 made node:http throw inside the
    // socket's message listener, and Bun exited with code 1.
    const app = Fastify();
    app.get("/*", async (request) => ({ url: request.url, q: (request.query as { q?: string }).q }));
    const origin = await listen(app);
    const fake = relay();
    const tunnel = client(fake.url, origin);
    await waitFor(tunnel, "connected");

    const answer = await fake.request({ method: "GET", path: "/api/v1/search?q=日本 x", headers: {} });
    expect(JSON.parse(answer.body.toString())).toEqual({ url: "/api/v1/search?q=%E6%97%A5%E6%9C%AC%20x", q: "日本 x" });
    const latin = await fake.request({ method: "GET", path: "/api/v1/search?q=Björk", headers: {} });
    expect(JSON.parse(latin.body.toString()).q).toBe("Björk");
  });

  it("fails a request it can't replay, and only that request", async () => {
    const app = Fastify();
    app.all("/*", async (request) => ({ method: request.method, headers: request.headers }));
    const origin = await listen(app);
    const fake = relay();
    const tunnel = client(fake.url, origin);
    await waitFor(tunnel, "connected");

    const refused = [
      { method: "GE T", path: "/x", headers: {} },
      { method: "GET\r\nX-Injected: 1", path: "/x", headers: {} },
      { method: 42, path: "/x", headers: {} },
      { method: "GET", path: 42, headers: {} },
      { method: "POST", path: "/x", headers: {}, body: 42 },
      { method: "POST", path: "/x", headers: {}, body: { not: "base64" } },
      { method: "GET", path: "/x", headers: "not a header list" },
    ];
    for (const frame of refused) {
      await expect(fake.request(frame as unknown as Parameters<FakeRelay["request"]>[0])).rejects.toThrow();
    }

    // A header that can't be sent is left off; the request still goes.
    const answer = await fake.request({
      method: "GET",
      path: "/x",
      headers: {
        "x-split": "a\r\nx-injected: 1",
        "bad name": "x",
        "x-wide": "日本",
        "x-number": 5 as unknown as string,
        "x-fine": "kept",
      },
    });
    const { headers } = JSON.parse(answer.body.toString()) as { headers: Record<string, string> };
    expect(headers["x-fine"]).toBe("kept");
    for (const name of ["x-split", "x-injected", "bad name", "x-wide", "x-number"]) expect(headers[name]).toBeUndefined();
    expect(tunnel.state).toBe("connected");
  });

  it("never lets a frame throw out of its message listener", async () => {
    const app = Fastify();
    app.get("/ok", async () => "ok");
    const origin = await listen(app);
    const fake = relay();
    const tunnel = client(fake.url, origin);
    await waitFor(tunnel, "connected");

    for (const frame of [
      { type: "request" },
      { type: "request", requestId: 5, method: "GET", path: "/ok", headers: {} },
      { type: "request", requestId: "r", method: "GET", path: "/ok", headers: null },
      { type: "request", requestId: "r", method: "GET", path: "/ok", headers: { "\u0000": "x" } },
      { type: "request", requestId: "r", method: "GET", path: "/\ud800", headers: {} },
      { type: "auth-ok", extra: [] },
      { type: "response-start", requestId: "r", status: 99999, headers: {} },
      null,
      "request",
      [],
    ]) {
      fake.send(frame);
    }
    await sleep(100);
    const answer = await fake.request({ method: "GET", path: "/ok", headers: {} });
    expect(answer.body.toString()).toBe("ok");
  });

  it("warns once when legato.fm refuses the credential, and asks again only on the long wait", async () => {
    const fake = relay(() => false);
    const warnings: string[] = [];
    const tunnel = client(fake.url, "http://127.0.0.1:9", { log: (level, message) => level === "warn" && warnings.push(message) });
    await waitFor(tunnel, "refused");
    await sleep(FAST.capMs * 4);
    expect(tunnel.state).toBe("refused");
    expect(fake.opened).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("It will ask again every hour");
    expect(warnings[0]).toContain("link this server to your legato.fm account again");
  });

  it("comes back by itself once legato.fm accepts the credential again, warning once in between", async () => {
    // A relay restored from an old backup refuses a credential it minted
    // since, until it's put right.
    let accepting = false;
    const fake = relay(() => accepting);
    const lines: { level: string; message: string }[] = [];
    const tunnel = client(fake.url, "http://127.0.0.1:9", {
      refusedRetryMs: 60,
      random: () => 0,
      log: (level, message) => lines.push({ level, message }),
    });
    await waitFor(tunnel, "refused");
    // Refused at least twice more, each time on the long wait's schedule.
    while (fake.auths.length < 3) await sleep(10);
    await waitFor(tunnel, "refused");

    accepting = true;
    await waitFor(tunnel, "connected", 1_000);
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1);
    expect(lines.at(-1)!.message).toContain("accepted this server's tunnel credential again");
  });

  it("asks again at once when told to after a refusal", async () => {
    let accepting = false;
    const fake = relay(() => accepting);
    const tunnel = client(fake.url, "http://127.0.0.1:9");
    await waitFor(tunnel, "refused");
    accepting = true;
    tunnel.retryRefused();
    await waitFor(tunnel, "connected", 1_000);
    expect(fake.opened).toBe(2);
  });

  it("backs off between failed attempts, doubling up to the cap, and logs the outage once", async () => {
    // Accepts the TCP connection and hangs up straight away: a relay that's
    // down behind a proxy that isn't.
    const attempts: number[] = [];
    const server = createServer((socket) => {
      attempts.push(Date.now());
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address() as { port: number };

    const lines: string[] = [];
    client(`ws://127.0.0.1:${port}/tunnel`, "http://127.0.0.1:9", {
      random: () => 1,
      log: (_level, message) => lines.push(message),
    });
    while (attempts.length < 6) await sleep(10);
    const gaps = attempts.slice(1).map((at, i) => at - attempts[i]!);
    // 20, 40, 80, 80, 80 ms, plus however long each attempt took to fail.
    expect(gaps[0]!).toBeGreaterThanOrEqual(15);
    expect(gaps[1]!).toBeGreaterThanOrEqual(35);
    expect(gaps[2]!).toBeGreaterThanOrEqual(70);
    expect(gaps[4]!).toBeGreaterThanOrEqual(70);
    expect(Math.max(...gaps)).toBeLessThan(400);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("couldn't open the tunnel");
  });

  it("reconnects when the relay restarts, and says so", async () => {
    const lines: string[] = [];
    const first = relay();
    const tunnel = client(first.url, "http://127.0.0.1:9", { log: (_level, message) => lines.push(message) });
    await waitFor(tunnel, "connected");

    first.stop();
    await waitFor(tunnel, "waiting");
    // On the same port, as a restarted relay would be.
    const second = startFakeRelay({ accept: () => true, port: Number(new URL(first.url).port) });
    cleanups.push(() => second.stop());
    await waitFor(tunnel, "connected");
    expect(lines.some((line) => line.includes("tunnel dropped"))).toBe(true);
    expect(lines.at(-1)).toContain("connected again");
  });

  it("reconnects when the relay stops answering its pings", async () => {
    // Completes the WebSocket handshake, says auth-ok, then goes silent:
    // what a network change looks like before TCP notices.
    const sockets: Socket[] = [];
    const silent: Server = createServer((socket) => {
      sockets.push(socket);
      socket.once("data", (data) => {
        const key = /sec-websocket-key: (.+)\r\n/i.exec(data.toString())![1]!.trim();
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const payload = Buffer.from(JSON.stringify({ type: "auth-ok" }));
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => silent.close(resolve));
    });
    const { port } = silent.address() as { port: number };

    const tunnel = client(`ws://127.0.0.1:${port}/tunnel`, "http://127.0.0.1:9", { heartbeatMs: 30 });
    await waitFor(tunnel, "connected");
    await waitFor(tunnel, "waiting");
    await waitFor(tunnel, "connected");
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps one heartbeat however many times it's told it signed in", async () => {
    const fake = relay();
    const tunnel = client(fake.url, "http://127.0.0.1:9", { heartbeatMs: 40 });
    await waitFor(tunnel, "connected");
    for (let i = 0; i < 4; i++) fake.send({ type: "auth-ok" });
    await sleep(400);
    // Each extra auth-ok used to start another heartbeat that nothing
    // stopped. They took turns clearing each other's pongs, so the client
    // decided a healthy connection had died and dropped it.
    expect(tunnel.state).toBe("connected");
    expect(fake.opened).toBe(1);
    // About ten beats in 400 ms, from one heartbeat.
    expect(fake.pings).toBeGreaterThanOrEqual(5);
    expect(fake.pings).toBeLessThanOrEqual(13);
    tunnel.stop();
    const atStop = fake.pings;
    await sleep(200);
    expect(fake.pings).toBe(atStop);
  });

  it("lets an answer already under way go back before it stops, but doesn't wait on a long one", async () => {
    const app = Fastify();
    app.get("/quick", async () => {
      await sleep(50);
      return "quick";
    });
    // A stream that never ends, like audio still playing.
    app.get("/endless", (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "audio/flac" });
      reply.raw.write("x");
    });
    const origin = await listen(app);
    const fake = relay();
    const tunnel = client(fake.url, origin);
    await waitFor(tunnel, "connected");

    const quick = fake.request({ method: "GET", path: "/quick", headers: {} });
    await sleep(10);
    tunnel.stop();
    expect((await quick).body.toString()).toBe("quick");
    while (fake.closed < 1) await sleep(10);

    const again = client(fake.url, origin);
    await waitFor(again, "connected");
    const endless = fake.request({ method: "GET", path: "/endless", headers: {} });
    await sleep(50);
    const stoppedAt = Date.now();
    again.stop();
    await expect(endless).rejects.toThrow("disconnected");
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
  });

  it("aborts its own request when legato.fm cancels it, and sends nothing more for it", async () => {
    const app = Fastify();
    let hungUp!: () => void;
    const closed = new Promise<void>((resolve) => (hungUp = resolve));
    app.get("/endless", (request, reply) => {
      reply.raw.writeHead(200, { "content-type": "audio/flac" });
      const beat = setInterval(() => reply.raw.write("x"), 10);
      request.raw.socket.on("close", () => {
        clearInterval(beat);
        hungUp();
      });
    });
    const origin = await listen(app);
    const fake = relay();
    const tunnel = client(fake.url, origin);
    await waitFor(tunnel, "connected");

    let settled = false;
    void fake.request({ method: "GET", path: "/endless", headers: {} }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await sleep(50);
    fake.send({ type: "cancel", requestId: fake.lastRequestId });
    await closed;
    await sleep(50);
    expect(settled).toBe(false);
    expect(tunnel.state).toBe("connected");
    // A cancel for nothing, or for a request already over, is ignored.
    fake.send({ type: "cancel", requestId: fake.lastRequestId });
    fake.send({ type: "cancel", requestId: "never-sent" });
    fake.send({ type: "cancel" });
    expect((await fake.request({ method: "GET", path: "/endless-not", headers: {} })).status).toBe(404);
  });

  it("stops when told to, and stays stopped", async () => {
    const fake = relay();
    const tunnel = client(fake.url, "http://127.0.0.1:9");
    await waitFor(tunnel, "connected");
    tunnel.stop();
    await sleep(FAST.capMs * 3);
    expect(tunnel.state).toBe("stopped");
    expect(fake.opened).toBe(1);
    expect(fake.closed).toBe(1);
  });
});
