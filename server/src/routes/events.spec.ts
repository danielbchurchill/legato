import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { buildTestApp, createOwnerForTest } from "../auth/test-app.js";
import { broadcast } from "../ws.js";
import { wsRoutes } from "./ws.js";

// Issue #365: GET /api/v1/events, the /ws broadcasts as server-sent events,
// for a client that reaches this server through legato.fm's HTTP-only
// tunnel.

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function listen(app: FastifyInstance): Promise<string> {
  apps.push(app);
  return app.listen({ port: 0, host: "127.0.0.1" });
}

// Reads the stream until `until` holds for everything read so far.
async function readUntil(
  reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
  until: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 3_000;
  while (!until(text)) {
    if (Date.now() > deadline) throw new Error(`stream never matched; got ${JSON.stringify(text)}`);
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("GET /api/v1/events", () => {
  it("streams every broadcast, with a media ticket, as one data line each", async () => {
    const { app } = await buildTestApp(openDb(":memory:"));
    const { mediaTicket } = await createOwnerForTest(app);
    const base = await listen(app);

    const hangUp = new AbortController();
    const res = await fetch(`${base}/api/v1/events?t=${encodeURIComponent(mediaTicket)}`, { signal: hangUp.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const reader = res.body!.getReader();
    await readUntil(reader, (text) => text.includes(": connected\n\n"));

    broadcast("scan:progress", { done: 3, note: "two\nlines" });
    const text = await readUntil(reader, (t) => /data: .*\n\n/.test(t));
    const line = text.slice(text.indexOf("data: ")).split("\n\n")[0]!;
    expect(JSON.parse(line.slice("data: ".length))).toEqual({ event: "scan:progress", payload: { done: 3, note: "two\nlines" } });

    hangUp.abort();
    // The stream is gone; a broadcast after it has no one to write to.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => broadcast("scan:progress", { done: 4 })).not.toThrow();
  });

  it("is refused without a credential, as every other route is", async () => {
    const { app } = await buildTestApp(openDb(":memory:"));
    await createOwnerForTest(app);
    const res = await app.inject({ method: "GET", url: "/api/v1/events" });
    expect(res.statusCode).toBe(401);
  });

  it("says something on a quiet stream, so nothing in between closes it", async () => {
    const app = Fastify();
    await app.register(websocket);
    await app.register(wsRoutes({ heartbeatMs: 20 }), { prefix: "/api/v1" });
    const base = await listen(app);

    const hangUp = new AbortController();
    const res = await fetch(`${base}/api/v1/events`, { signal: hangUp.signal });
    const text = await readUntil(res.body!.getReader(), (t) => t.split(": ping\n\n").length > 2);
    expect(text.startsWith(": connected\n\n: ping\n\n")).toBe(true);
    hangUp.abort();
  });
});
