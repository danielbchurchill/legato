import { beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { getDuplicatePair, readBitDepth } from "./hygiene.js";
import { resolveQueueTracks } from "./routes/queue.js";
import { hygieneRoutes } from "./routes/hygiene.js";

/* #469: the two sides of a possible duplicate, and which file the track
 * plays after a merge, by the rule POST /queue/resolve plays by. */

let db: Database;
let root: number;

beforeEach(() => {
  db = openDb(":memory:");
  root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/music') RETURNING id").get() as { id: number }).id;
});

function recording(title: string): number {
  const id = (
    db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as { id: number }
  ).id;
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(id);
  return id;
}

type Fields = {
  format?: string | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  file_size?: number;
  match_source?: string;
  fuzzy_candidate_node_id?: number | null;
  missing_since?: string | null;
};

function file(nodeId: number, path: string, fields: Fields = {}): number {
  const f = {
    format: "FLAC",
    bitrate: 900_000,
    sample_rate: 44_100,
    file_size: 30_000_000,
    match_source: "unmatched",
    fuzzy_candidate_node_id: null,
    missing_since: null,
    ...fields,
  };
  return (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, format, bitrate,
                            sample_rate, match_source, fuzzy_candidate_node_id, missing_since)
         VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        nodeId,
        root,
        path,
        f.file_size,
        f.format,
        f.bitrate,
        f.sample_rate,
        f.match_source,
        f.fuzzy_candidate_node_id,
        f.missing_since,
      ) as {
      id: number;
    }
  ).id;
}

/** A possible duplicate: `pending` looks like the recording `existing` has. */
function pair(pendingFields: Fields, existingFields: Fields) {
  const existing = recording("Come Together");
  const existingFile = file(existing, "/music/a/come-together.flac", existingFields);
  const own = recording("come together");
  const pendingFile = file(own, "/music/b/come-together.mp3", {
    ...pendingFields,
    match_source: "fuzzy_pending",
    fuzzy_candidate_node_id: existing,
  });
  return { existing, existingFile, own, pendingFile };
}

const depths: Record<string, number | null> = {
  "/music/a/come-together.flac": 24,
  "/music/b/come-together.mp3": null,
};
const bitDepthOf = async (path: string) => depths[path] ?? null;

/** What POST /queue/resolve would play for the recording once `fileId` is
 * merged into it. */
function playedAfterMerge(fileId: number, into: number): number | undefined {
  db.prepare("UPDATE files SET recording_node_id = ? WHERE id = ?").run(into, fileId);
  return resolveQueueTracks(db, [into])[0]?.fileId;
}

describe("getDuplicatePair", () => {
  it("describes both sides: format, bitrate, sample rate, bit depth where known, size and path", async () => {
    const { existingFile, pendingFile } = pair(
      { format: "MPEG", bitrate: 320_000, sample_rate: 44_100, file_size: 9_000_000 },
      { format: "FLAC", bitrate: 2_100_000, sample_rate: 96_000, file_size: 80_000_000 },
    );
    const result = await getDuplicatePair(db, pendingFile, bitDepthOf);
    expect(result).toEqual({
      file: {
        id: pendingFile,
        path: "/music/b/come-together.mp3",
        format: "MPEG",
        bitrate: 320_000,
        sampleRate: 44_100,
        bitDepth: null,
        size: 9_000_000,
        missing: false,
      },
      candidate: [
        {
          id: existingFile,
          path: "/music/a/come-together.flac",
          format: "FLAC",
          bitrate: 2_100_000,
          sampleRate: 96_000,
          bitDepth: 24,
          size: 80_000_000,
          missing: false,
        },
      ],
      playsAfterMerge: existingFile,
      reason: "bitrate",
    });
  });

  it("names the file playback actually picks: the higher bitrate, whichever side it's on", async () => {
    const { existing, pendingFile } = pair({ bitrate: 1_000_000 }, { bitrate: 320_000 });
    const result = await getDuplicatePair(db, pendingFile, bitDepthOf);
    expect(result?.playsAfterMerge).toBe(pendingFile);
    expect(result?.reason).toBe("bitrate");
    expect(playedAfterMerge(pendingFile, existing)).toBe(result!.playsAfterMerge!);
  });

  it("falls back to the file Legato found first when the bitrates tie or aren't known", async () => {
    const { existing, existingFile, pendingFile } = pair({ bitrate: null }, { bitrate: null });
    const result = await getDuplicatePair(db, pendingFile, bitDepthOf);
    expect(result).toMatchObject({ playsAfterMerge: existingFile, reason: "first" });
    expect(playedAfterMerge(pendingFile, existing)).toBe(existingFile);
  });

  it("says a file is the only one on disk when the other is missing, and reads no header for the missing one", async () => {
    const read: string[] = [];
    const { existing, pendingFile } = pair(
      { bitrate: 128_000 },
      { bitrate: 900_000, missing_since: "2026-01-01 00:00:00" },
    );
    const result = await getDuplicatePair(db, pendingFile, async (path) => {
      read.push(path);
      return null;
    });
    expect(result).toMatchObject({ playsAfterMerge: pendingFile, reason: "only" });
    expect(result?.candidate[0]?.missing).toBe(true);
    expect(read).toEqual(["/music/b/come-together.mp3"]);
    expect(playedAfterMerge(pendingFile, existing)).toBe(pendingFile);
  });

  it("counts every file the track already has", async () => {
    const { existing, pendingFile } = pair({ bitrate: 900_000 }, { bitrate: 320_000 });
    const best = file(existing, "/music/c/come-together.flac", { bitrate: 1_400_000 });
    const result = await getDuplicatePair(db, pendingFile, bitDepthOf);
    expect(result?.candidate.map((f) => f.id)[0]).toBe(best);
    expect(result?.candidate).toHaveLength(2);
    expect(result?.playsAfterMerge).toBe(best);
    expect(playedAfterMerge(pendingFile, existing)).toBe(best);
  });

  it("answers null for a file that isn't a possible duplicate", async () => {
    const own = recording("Alone");
    const plain = file(own, "/music/alone.flac");
    expect(await getDuplicatePair(db, plain, bitDepthOf)).toBeNull();
    expect(await getDuplicatePair(db, 999, bitDepthOf)).toBeNull();
  });

  it("is served at GET /hygiene/duplicates/:fileId, 404 once it's resolved", async () => {
    const app = Fastify();
    await app.register(hygieneRoutes(db), { prefix: "/api/v1" });
    const { pendingFile } = pair({}, {});
    const res = await app.inject({ method: "GET", url: `/api/v1/hygiene/duplicates/${pendingFile}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ file: { id: pendingFile } });
    db.prepare("UPDATE files SET match_source = 'manual' WHERE id = ?").run(pendingFile);
    expect((await app.inject({ method: "GET", url: `/api/v1/hygiene/duplicates/${pendingFile}` })).statusCode).toBe(
      404,
    );
  });
});

describe("readBitDepth", () => {
  // A real FLAC, as tagwrite/writer.spec.ts makes one: the header is what's
  // read. ffmpeg is already the server's own dependency.
  it("reads a lossless file's bit depth from its header, and null for a file it can't read", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "legato-bitdepth-"));
    try {
      const flac = path.join(dir, "tone.flac");
      execFileSync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-sample_fmt", "s16", flac], {
        stdio: "ignore",
      });
      expect(await readBitDepth(flac)).toBe(16);
      expect(await readBitDepth(path.join(dir, "gone.flac"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
