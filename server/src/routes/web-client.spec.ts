import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { directorySource, SERVED_BY_SERVER_MARKER, webClientRoutes } from "./web-client.js";

let distDir: string;
let app: FastifyInstance;

// A stand-in for Vite's output: the shell, one fingerprinted asset, and one
// unhashed public/ file.
beforeAll(async () => {
  distDir = mkdtempSync(path.join(tmpdir(), "legato-web-client-spec-"));
  mkdirSync(path.join(distDir, "assets"));
  writeFileSync(path.join(distDir, "index.html"), '<!doctype html><html><head><title>Legato</title></head><body><div id="root"></div></body></html>');
  writeFileSync(path.join(distDir, "assets", "index-abc123.js"), "console.log('legato')");
  writeFileSync(path.join(distDir, "favicon.png"), "png");
  // Outside dist/, for the traversal test.
  writeFileSync(path.join(path.dirname(distDir), "legato-web-client-secret.txt"), "secret");

  app = Fastify();
  app.get("/api/v1/health", async () => ({ status: "ok" }));
  await app.register(webClientRoutes(directorySource(distDir)));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(distDir, { recursive: true, force: true });
  rmSync(path.join(path.dirname(distDir), "legato-web-client-secret.txt"), { force: true });
});

describe("web client routes", () => {
  it("serves the shell at / with the served-by-server marker", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toStartWith("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toContain(`${SERVED_BY_SERVER_MARKER}</head>`);
    expect(res.body).toContain('<div id="root">');
  });

  it("marks /index.html requested by name too", async () => {
    const res = await app.inject({ method: "GET", url: "/index.html" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(SERVED_BY_SERVER_MARKER);
  });

  it("serves fingerprinted assets as immutable, with their real type", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toStartWith("text/javascript");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.body).toBe("console.log('legato')");
  });

  it("revalidates unhashed public files", async () => {
    const res = await app.inject({ method: "GET", url: "/favicon.png" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("falls back to the shell for a deep link", async () => {
    const res = await app.inject({ method: "GET", url: "/library/artists?sort=name" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(SERVED_BY_SERVER_MARKER);
  });

  it("falls back for a dotted path when the browser is navigating", async () => {
    const res = await app.inject({ method: "GET", url: "/artist/st.vincent", headers: { accept: "text/html,*/*" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(SERVED_BY_SERVER_MARKER);
  });

  it("404s a missing asset instead of answering it with HTML", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/index-gone.js", headers: { accept: "*/*" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: 404 });
  });

  it("keeps real API routes ahead of the wildcard", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.json<unknown>()).toEqual({ status: "ok" });
  });

  it("answers an unknown API path with a JSON 404, even from a browser", async () => {
    for (const url of ["/api/v1/does-not-exist", "/api", "/covers/abc"]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toStartWith("application/json");
      expect(res.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
    }
  });

  it("doesn't let an encoded ../ climb out of dist/", async () => {
    const res = await app.inject({ method: "GET", url: "/..%2flegato-web-client-secret.txt", headers: { accept: "*/*" } });
    expect(res.statusCode).toBe(404);
    // The 404 message echoes the URL, so check for the file's content.
    expect(res.body).not.toBe("secret");
  });

  // Fastify's router rejects it with a 400 before the wildcard ever sees
  // it; requestPath()'s own catch covers anything that gets past that.
  it("refuses malformed percent-encoding", async () => {
    const res = await app.inject({ method: "GET", url: "/%E0%A4%A" });
    expect(res.statusCode).toBe(400);
  });

  it("answers HEAD like GET", async () => {
    const res = await app.inject({ method: "HEAD", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toStartWith("text/html");
  });

  it("404s everything when there's no client to serve", async () => {
    const bare = Fastify();
    await bare.register(webClientRoutes(null));
    const res = await bare.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
