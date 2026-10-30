import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { fillMediaSlots, queuePlayback } from "../media/test-slots.js";
import { cachePath, TranscodeJob } from "../stream/cache.js";
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
    expect(res.headers["content-type"]).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(res.headers["content-range"]).toBe(`bytes 100-199/${cached.length}`);
    expect(res.rawPayload.equals(cached.subarray(100, 200))).toBe(true);
  });

  it("finishes and caches an encode its player hung up on, so a paused player resumes from the cache", async () => {
    // A paused player's browser drops the idle connection, and on resume
    // asks for the rest. Five minutes of audio, still encoding when it
    // hangs up.
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=300", sourcePath], { stdio: "ignore" });
    const cacheDir = path.join(dir, "streams");
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir }), { prefix: "/api/v1" });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const url = `${origin}/api/v1/files/${fileId}/stream?quality=opus96`;
      const hangUp = new AbortController();
      const player = await fetch(url, { signal: hangUp.signal });
      await player.body!.getReader().read();
      hangUp.abort();

      const target = cachePath(HASH, "opus96", cacheDir);
      const deadline = Date.now() + 10_000;
      while (!existsSync(target) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const resumed = await fetch(url, { headers: { range: "bytes=1000-" } });
      expect(resumed.status).toBe(206);
      expect(Buffer.from(await resumed.arrayBuffer()).equals(readFileSync(target).subarray(1000))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("stops an encode nobody listens to once another track is waiting for its slot, and caches nothing", async () => {
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1200", sourcePath], { stdio: "ignore" });
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir: path.join(dir, "streams") }), { prefix: "/api/v1" });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    let full: { release(): void } | undefined;
    let next: { granted: Promise<void>; release(): void } | undefined;
    try {
      const hangUp = new AbortController();
      const player = await fetch(`${origin}/api/v1/files/${fileId}/stream?quality=opus160`, { signal: hangUp.signal });
      await player.body!.getReader().read();
      // The next track waits behind this encode for a slot.
      full = fillMediaSlots();
      next = queuePlayback();
      await new Promise((resolve) => setTimeout(resolve, 20));
      hangUp.abort();

      await next.granted;
      const shard = path.dirname(cachePath(HASH, "opus160", path.join(dir, "streams")));
      const deadline = Date.now() + 2_000;
      while (readdirSync(shard).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readdirSync(shard)).toEqual([]);
    } finally {
      full?.release();
      next?.release();
      await app.close();
    }
  });

  it("keeps an encode going for a seek waiting on it after the player that started it hangs up", async () => {
    // Five minutes of audio, so the encode is still going when the first
    // listener leaves, with another track waiting for a slot meanwhile.
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=300", sourcePath], { stdio: "ignore" });
    const app = Fastify();
    await app.register(filesRoutes(db, { cacheDir: path.join(dir, "streams") }), { prefix: "/api/v1" });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    let full: { release(): void } | undefined;
    let waiting: { granted: Promise<void>; release(): void } | undefined;
    try {
      const url = `${origin}/api/v1/files/${fileId}/stream?quality=opus96`;
      const hangUp = new AbortController();
      const player = await fetch(url, { signal: hangUp.signal });
      await player.body!.getReader().read();
      const seek = fetch(url, { headers: { range: "bytes=1000-1999" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      full = fillMediaSlots();
      waiting = queuePlayback();
      hangUp.abort();

      const sought = await seek;
      expect(sought.status).toBe(206);
      const cached = readFileSync(cachePath(HASH, "opus96", path.join(dir, "streams")));
      expect(Buffer.from(await sought.arrayBuffer()).equals(cached.subarray(1000, 2000))).toBe(true);
    } finally {
      full?.release();
      await waiting?.granted;
      waiting?.release();
      await app.close();
    }
  });

  it("counts a player that hangs up while its encode is being set up as gone", async () => {
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1200", sourcePath], { stdio: "ignore" });
    const cacheDir = path.join(dir, "streams");
    const app = Fastify();
    let hungUp!: () => void;
    const closed = new Promise<void>((resolve) => (hungUp = resolve));
    app.addHook("onRequest", async (_request, reply) => {
      reply.raw.once("close", () => hungUp());
    });
    await app.register(filesRoutes(db, { cacheDir }), { prefix: "/api/v1" });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    // The route's first wait is whether the variant is cached already. The
    // player hangs up during it: a tunnel's cancel does just this.
    const access = fsPromises.access;
    const checking = spyOn(fsPromises, "access").mockImplementation(async (...args: Parameters<typeof access>) => {
      await closed;
      return access(...args);
    });
    const joined: TranscodeJob[] = [];
    const join = TranscodeJob.prototype.join;
    const joining = spyOn(TranscodeJob.prototype, "join").mockImplementation(function (this: TranscodeJob) {
      joined.push(this);
      return join.call(this);
    });
    try {
      const hangUp = new AbortController();
      void fetch(`${origin}/api/v1/files/${fileId}/stream?quality=opus160`, { signal: hangUp.signal }).catch(() => {});
      while (checking.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      hangUp.abort();
      await closed;
      while (joined.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(joined[0]!.listening).toBe(0);
      // Nobody wants it, and it hadn't started: it's stopped at once.
      await expect(joined[0]!.finished).rejects.toThrow("nobody was listening");
    } finally {
      checking.mockRestore();
      joining.mockRestore();
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

  // #408: the original's audio as fragmented MP4, for the web player that
  // feeds a ManagedMediaSource on an iPhone.
  describe("original-fmp4", () => {
    async function index(query: string) {
      const app = Fastify();
      await app.register(filesRoutes(db, { cacheDir: path.join(dir, "streams") }), { prefix: "/api/v1" });
      return app.inject({ method: "GET", url: `/api/v1/files/${fileId}/stream/index${query}` });
    }

    // Every packet's own bytes, by hash: a stream copy carries the source's
    // FLAC frames unchanged, where a re-encode would make new ones.
    function packetHashes(file: string): string[] {
      const csv = execFileSync("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_data_hash",
        "MD5",
        "-show_entries",
        "packet=data_hash",
        "-of",
        "csv=p=0",
        file,
      ]);
      return csv.toString().trim().split("\n");
    }

    it("is the source's own FLAC frames in fragmented MP4, not a re-encode", async () => {
      const res = await get("?quality=original-fmp4");
      expect(res.statusCode).toBe(200);
      // Named while the remux is still being written, for addSourceBuffer.
      expect(res.headers["content-type"]).toBe('audio/mp4; codecs="fLaC"');
      expect(res.headers["content-length"]).toBeUndefined();
      expect(res.rawPayload.toString("latin1", 4, 8)).toBe("ftyp");

      const cached = cachePath(HASH, "original-fmp4", path.join(dir, "streams"));
      expect(res.rawPayload.equals(readFileSync(cached))).toBe(true);
      expect(packetHashes(cached)).toEqual(packetHashes(sourcePath));
    });

    it("leaves original the untouched source file, byte for byte, for desktop playback", async () => {
      await get("?quality=original-fmp4");
      const res = await get("?quality=original");
      expect(res.headers["content-type"]).toBe("audio/flac");
      expect(res.rawPayload.equals(readFileSync(sourcePath))).toBe(true);
    });

    it("indexes it: fLaC, the init segment, and fragments a Range request can fetch one at a time", async () => {
      const res = await index("?quality=original-fmp4");
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const body = res.json() as { codecs: string; initEnd: number; fragments: { offset: number; time: number }[]; end: number };
      expect(body.codecs).toBe("fLaC");
      expect(body.fragments[0]).toEqual({ offset: body.initEnd, time: 0 });

      const init = await get("?quality=original-fmp4", { range: `bytes=0-${body.initEnd - 1}` });
      expect(init.statusCode).toBe(206);
      expect(init.rawPayload.toString("latin1", 4, 8)).toBe("ftyp");
      const last = body.fragments.at(-1)!;
      const fragment = await get("?quality=original-fmp4", { range: `bytes=${last.offset}-${body.end - 1}` });
      expect(fragment.statusCode).toBe(206);
      expect(fragment.rawPayload.toString("latin1", 4, 8)).toBe("moof");
    });

    it("names a cached remux's codec on every Range request", async () => {
      await get("?quality=original-fmp4");
      const res = await get("?quality=original-fmp4", { range: "bytes=0-99" });
      expect(res.statusCode).toBe(206);
      expect(res.headers["content-type"]).toBe('audio/mp4; codecs="fLaC"');
    });

    it("indexes an ALAC .m4a as alac", async () => {
      const alac = path.join(dir, "track.m4a");
      execFileSync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "alac", alac], { stdio: "ignore" });
      db.prepare("UPDATE files SET file_path = ? WHERE id = ?").run(alac, fileId);
      const res = await index("?quality=original-fmp4");
      expect(res.statusCode).toBe(200);
      expect((res.json() as { codecs: string }).codecs).toBe("alac");
      expect((await get("?quality=original-fmp4")).headers["content-type"]).toBe('audio/mp4; codecs="alac"');
    });

    it("waits for a fresh AAC encode to finish before indexing it", async () => {
      const res = await index("?quality=aac160");
      expect(res.statusCode).toBe(200);
      expect((res.json() as { codecs: string }).codecs).toBe("mp4a.40.2");
      expect(existsSync(cachePath(HASH, "aac160", path.join(dir, "streams")))).toBe(true);
    });

    it("refuses an MP3 with 415, before ffmpeg opens it, so the player asks for AAC", async () => {
      const mp3 = path.join(dir, "track.mp3");
      writeFileSync(mp3, "not read");
      db.prepare("UPDATE files SET file_path = ? WHERE id = ?").run(mp3, fileId);
      expect((await get("?quality=original-fmp4")).statusCode).toBe(415);
      expect((await index("?quality=original-fmp4")).statusCode).toBe(415);
      expect(existsSync(path.join(dir, "streams"))).toBe(false);
    });

    it("leaves chapters out, which would be a second track a MediaSource refuses", async () => {
      const chapters = path.join(dir, "chapters.txt");
      writeFileSync(
        chapters,
        ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=one\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=500\nEND=1000\ntitle=two\n",
      );
      const withChapters = path.join(dir, "chapters.m4a");
      execFileSync(
        "ffmpeg",
        [
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-i",
          chapters,
          "-map",
          "0",
          "-map_chapters",
          "1",
          "-c:a",
          "aac",
          withChapters,
        ],
        { stdio: "ignore" },
      );
      db.prepare("UPDATE files SET file_path = ? WHERE id = ?").run(withChapters, fileId);
      for (const quality of ["original-fmp4", "aac160"] as const) {
        expect((await get(`?quality=${quality}`)).statusCode).toBe(200);
        const streams = execFileSync("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type",
          "-of",
          "csv=p=0",
          cachePath(HASH, quality, path.join(dir, "streams")),
        ]);
        expect(streams.toString().trim()).toBe("audio");
      }
    });

    it("only indexes the fragmented MP4 rungs", async () => {
      for (const quality of ["original", "opus160", "nonsense"]) expect((await index(`?quality=${quality}`)).statusCode).toBe(400);
      expect((await index("")).statusCode).toBe(400);
    });

    it("returns 404 for a file the scan has marked missing", async () => {
      db.prepare("UPDATE files SET missing_since = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(fileId);
      expect((await index("?quality=original-fmp4")).statusCode).toBe(404);
    });

    it("returns 502 when the source can't be read", async () => {
      db.prepare("UPDATE files SET file_path = ? WHERE id = ?").run(path.join(dir, "missing.flac"), fileId);
      expect((await index("?quality=original-fmp4")).statusCode).toBe(502);
    });
  });
});
