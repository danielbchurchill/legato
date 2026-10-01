import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { directorySource, webClientRoutes } from "../routes/web-client.js";
import { isPublicRoute, redactCredentials } from "./gate.js";
import { buildTestApp, createOwnerForTest, LOCAL_PAGE, type RegisteredRoute } from "./test-app.js";

let db: Database;
let app: FastifyInstance;
let routes: RegisteredRoute[];

beforeEach(async () => {
  db = openDb(":memory:");
  ({ app, routes } = await buildTestApp(db));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// "/nodes/:id/cover" -> "/nodes/1/cover". The gate runs before params are
// validated, so any value that routes to the handler is enough.
function concreteUrl(pattern: string): string {
  return pattern.replace(/:[A-Za-z_]+/g, "1").replace(/\*/g, "x");
}

describe("every registered route", () => {
  it("found a real route table to check", () => {
    // Guards the test below against passing vacuously if registration
    // ever stops going through registerRoutes().
    expect(routes.length).toBeGreaterThan(50);
  });

  it("rejects a request with no credentials unless it's on the public list", async () => {
    const leaks: string[] = [];
    for (const { method, url } of routes) {
      if (method === "OPTIONS" || isPublicRoute(method, url)) continue;
      const res = await app.inject({ method: method as "GET", url: `${concreteUrl(url)}` });
      if (res.statusCode !== 401) leaks.push(`${method} ${url} -> ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it("rejects them the same way on an upgraded server that has data but no owner", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe("owner_required");
  });

  it("says signed_out, not owner_required, once an owner exists", async () => {
    await createOwnerForTest(app);
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.json().reason).toBe("signed_out");
  });
});

describe("public routes", () => {
  it("keeps /api/v1/health open", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("keeps /api/v1/auth/status open", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ownerExists).toBe(false);
  });

  it("returns 401, not 404, for an unmatched URL under an API prefix", async () => {
    for (const url of ["/api/v1/no-such-route", "/api/v2/stats", "/covers/abc"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });

  it("can't be reached by a path that only starts like a public one", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health/../stats" });
    expect(res.statusCode).toBe(401);
  });
});

// #116 serves the built client at / with an SPA fallback. The sign-in
// screen itself is one of those pages, so it can't sit behind sign-in.
// Registered the way index.ts does it: after the gate, outside
// registerRoutes(), with #116's real wildcard route and a throwaway dist/.
describe("the web client's own pages", () => {
  let distDir: string;

  beforeEach(async () => {
    distDir = mkdtempSync(path.join(tmpdir(), "legato-gate-dist-"));
    mkdirSync(path.join(distDir, "assets"));
    writeFileSync(path.join(distDir, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    writeFileSync(path.join(distDir, "assets", "index-abc123.js"), "console.log(1)");
    await app.close();
    ({ app } = await buildTestApp(db));
    await app.register(webClientRoutes(directorySource(distDir)));
    await app.ready();
  });

  afterEach(() => rmSync(distDir, { recursive: true, force: true }));

  it("serves GET / and a deep link without credentials", async () => {
    for (const url of ["/", "/library/artists/42", "/assets/index-abc123.js"]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode).toBe(200);
    }
  });

  it("still gates anything but GET/HEAD outside the API prefixes", async () => {
    const res = await app.inject({ method: "POST", url: "/" });
    expect(res.statusCode).toBe(401);
  });

  it("still gates an unmatched API URL rather than falling back to index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(401);
  });
});

describe("credentials", () => {
  let token: string;
  let mediaTicket: string;

  beforeEach(async () => {
    ({ token, mediaTicket } = await createOwnerForTest(app));
  });

  it("accepts a bearer token from a client with no Origin (the Pi's kiosk, curl)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/stats",
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: "100.88.83.1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a tampered bearer token", async () => {
    const flipped = (token[0] === "A" ? "B" : "A") + token.slice(1);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/stats",
      headers: { authorization: `Bearer ${flipped}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an expired session", async () => {
    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute')").run();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/stats",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token after sign-out", async () => {
    await app.inject({ method: "POST", url: "/api/v1/auth/sign-out", headers: { authorization: `Bearer ${token}` } });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/stats?t=${mediaTicket}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the media ticket on a GET, where <img> and <audio> can't send a header", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/stats?t=${mediaTicket}` });
    expect(res.statusCode).toBe(200);
  });

  it("never lets the media ticket change anything", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/playlists?t=${mediaTicket}`,
      payload: { name: "sneaky" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("doesn't accept the media ticket as a bearer token, or the token as a ticket", async () => {
    const asBearer = await app.inject({
      method: "GET",
      url: "/api/v1/stats",
      headers: { authorization: `Bearer ${mediaTicket}` },
    });
    const asTicket = await app.inject({ method: "GET", url: `/api/v1/stats?t=${token}` });
    expect(asBearer.statusCode).toBe(401);
    expect(asTicket.statusCode).toBe(401);
  });

  it("accepts the session cookie from the same host", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playlists",
      headers: { ...LOCAL_PAGE, cookie: `legato_session=${token}` },
      payload: { name: "from the web client" },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it("refuses a cookie-authenticated write from another site's page", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playlists",
      headers: { host: "127.0.0.1:8899", origin: "https://evil.example", cookie: `legato_session=${token}` },
      payload: { name: "csrf" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("redactCredentials", () => {
  it("removes the media ticket from a logged URL and leaves the rest", () => {
    expect(redactCredentials("/api/v1/covers/abc?size=thumb&t=secret")).toBe(
      "/api/v1/covers/abc?size=thumb&t=[redacted]",
    );
    expect(redactCredentials("/api/v1/ws?t=secret")).toBe("/api/v1/ws?t=[redacted]");
    expect(redactCredentials("/api/v1/stats?type=1")).toBe("/api/v1/stats?type=1");
  });
});
