import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mediaSlotsInUse } from "../media/queue.js";
import { cachePath } from "../stream/cache.js";
import { filesRoutes, parseRange } from "./files.js";

const SIZE = 1000;

describe("parseRange", () => {
  it("returns null with no Range header — the caller sends a plain 200", () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
  });

  it("returns null for a non-bytes unit", () => {
    expect(parseRange("items=0-10", SIZE)).toBeNull();
  });

  it("parses an open-ended range, what a mobile <audio> element probes with first", () => {
    expect(parseRange("bytes=0-", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("parses a fully bounded range", () => {
    expect(parseRange("bytes=200-499", SIZE)).toEqual({ start: 200, end: 499 });
  });

  it("parses a suffix range as the last N bytes", () => {
    expect(parseRange("bytes=-500", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("clamps a suffix range larger than the file to the whole file", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("marks a start at or past the end of the file unsatisfiable, the route's 416", () => {
    expect(parseRange("bytes=1000-1500", SIZE)).toBe("unsatisfiable");
    expect(parseRange("bytes=1000-", SIZE)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", SIZE)).toBe("unsatisfiable");
  });

  it("clamps an end past the file size to the last byte, as RFC 7233 asks", () => {
    expect(parseRange("bytes=0-999", SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=0-1000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("rejects start > end", () => {
    expect(parseRange("bytes=500-200", SIZE)).toBeNull();
  });

  it("falls back to a full response for a multi-range request rather than mis-parsing it", () => {
    expect(parseRange("bytes=0-100,200-300", SIZE)).toBeNull();
  });

  it("rejects garbage instead of throwing", () => {
    expect(parseRange("bytes=abc-def", SIZE)).toBeNull();
    expect(parseRange("bytes=", SIZE)).toBeNull();
  });
});

describe("GET /api/v1/files/:id/stream", () => {
  const HASH = "abcdef0123456789abcdef0123456789abcdef01";
  let db: Database;
  let dir: string;
  let sourcePath: string;
  let fileId: number;

  beforeEach(() => {
    db = openDb(":memory:");
    dir = mkdtempSync(path.join(tmpdir(), "legato-files-route-test-"));
    sourcePath = path.join(dir, "track.flac");
    execFileSync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", sourcePath], { stdio: "ignore" });

    const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
      id: number;
    };
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
    fileId = (
      db
        .prepare(
          `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, file_hash)
           VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 0, ?) RETURNING id`,
        )
        .get(node.id, root.id, sourcePath, HASH) as { id: number }
    ).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(query = "", headers: Record<string, string> = {}) {
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir: path.join(dir, "streams") }), { prefix: "/api/v1" });
    return app.inject({ method: "GET", url: `/api/v1/files/${fileId}/stream${query}`, headers });
  }

  it("passes the source file straight through for original, the default", async () => {
    const source = readFileSync(sourcePath);
    for (const query of ["", "?quality=original"]) {
      const res = await get(query);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("audio/flac");
      expect(res.headers["content-length"]).toBe(String(source.length));
      expect(res.headers.etag).toBe(`"${HASH}"`);
      expect(res.rawPayload.equals(source)).toBe(true);
    }
  });

  it("answers a Range on original with 206 and the exact bytes", async () => {
    const source = readFileSync(sourcePath);
    const res = await get("?quality=original", { range: "bytes=10-19" });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 10-19/${source.length}`);
    expect(res.rawPayload.equals(source.subarray(10, 20))).toBe(true);
  });

  it("answers a Range past the end with 416 and the real length", async () => {
    const size = readFileSync(sourcePath).length;
    const res = await get("", { range: `bytes=${size}-` });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${size}`);
  });

  // Issue #130: the desktop shell's keep-awake reads this to know the
  // server is streaming. A 416 sends no audio, so it must not count.
  it("records stream activity for audio bytes sent, and not for a refused range", async () => {
    let notes = 0;
    const activity = { note: () => notes++, meter: (s: Readable) => s.on("data", () => notes++) };
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir: path.join(dir, "streams"), activity }), { prefix: "/api/v1" });

    const size = readFileSync(sourcePath).length;
    const refused = await app.inject({ url: `/api/v1/files/${fileId}/stream`, headers: { range: `bytes=${size}-` } });
    expect(refused.statusCode).toBe(416);
    expect(notes).toBe(0);

    const played = await app.inject({ url: `/api/v1/files/${fileId}/stream` });
    expect(played.statusCode).toBe(200);
    expect(notes).toBeGreaterThan(0);
  });

  it("refuses an unknown quality with 400 instead of guessing", async () => {
    const res = await get("?quality=flac320");
    expect(res.statusCode).toBe(400);
  });

  it("streams a fresh Opus 160 encode without a Content-Length, then serves the cached file with one", async () => {
    const fresh = await get("?quality=opus160", { range: "bytes=0-" });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers["content-type"]).toBe("audio/ogg; codecs=opus");
    expect(fresh.headers["content-length"]).toBeUndefined();
    expect(fresh.rawPayload.subarray(0, 4).toString()).toBe("OggS");

    const cached = readFileSync(cachePath(HASH, "opus160", path.join(dir, "streams")));
    expect(fresh.rawPayload.equals(cached)).toBe(true);

    const hit = await get("?quality=opus160");
    expect(hit.headers["content-length"]).toBe(String(cached.length));
    expect(hit.rawPayload.equals(cached)).toBe(true);
  });

  it("holds a mid-file Range on a fresh encode until it finishes, then answers 206", async () => {
    const res = await get("?quality=aac160", { range: "bytes=100-199" });
    const cached = readFileSync(cachePath(HASH, "aac160", path.join(dir, "streams")));
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-type"]).toBe("audio/mp4");
    expect(res.headers["content-range"]).toBe(`bytes 100-199/${cached.length}`);
    expect(res.rawPayload.equals(cached.subarray(100, 200))).toBe(true);
  });

  it("stops an encode once the only player hangs up, and caches nothing", async () => {
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1200", sourcePath], { stdio: "ignore" });
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir: path.join(dir, "streams"), abandonGraceMs: 30 }), { prefix: "/api/v1" });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const hangUp = new AbortController();
      const player = await fetch(`${origin}/api/v1/files/${fileId}/stream?quality=opus160`, { signal: hangUp.signal });
      await player.body!.getReader().read();
      const before = mediaSlotsInUse();
      hangUp.abort();

      const shard = path.dirname(cachePath(HASH, "opus160", path.join(dir, "streams")));
      const deadline = Date.now() + 2_000;
      while (mediaSlotsInUse() >= before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mediaSlotsInUse()).toBe(before - 1);
      while (readdirSync(shard).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readdirSync(shard)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("keeps an encode going for a seek waiting on it after the player that started it hangs up", async () => {
    // Five minutes of audio, so the encode is still going when the first
    // listener leaves and its grace runs out.
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=300", sourcePath], { stdio: "ignore" });
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir: path.join(dir, "streams"), abandonGraceMs: 30 }), { prefix: "/api/v1" });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const url = `${origin}/api/v1/files/${fileId}/stream?quality=opus96`;
      const hangUp = new AbortController();
      const player = await fetch(url, { signal: hangUp.signal });
      await player.body!.getReader().read();
      const seek = fetch(url, { headers: { range: "bytes=1000-1999" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      hangUp.abort();

      const sought = await seek;
      expect(sought.status).toBe(206);
      const cached = readFileSync(cachePath(HASH, "opus96", path.join(dir, "streams")));
      expect(Buffer.from(await sought.arrayBuffer()).equals(cached.subarray(1000, 2000))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 502 before any audio header when ffmpeg can't read the source", async () => {
    db.prepare("UPDATE files SET file_path = ? WHERE id = ?").run(path.join(dir, "missing.flac"), fileId);
    const res = await get("?quality=opus96");
    expect(res.statusCode).toBe(502);
  });

  it("returns 404 for original when the file has vanished from disk since the scan", async () => {
    db.prepare("UPDATE files SET file_path = ? WHERE id = ?").run(path.join(dir, "missing.flac"), fileId);
    const res = await get();
    expect(res.statusCode).toBe(404);
  });
});
