import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { File as TagLibFile, type FlacTag } from "node-taglib-sharp";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mocked } from "../testing.js";
import { deriveLocalEdges } from "../match/edges.js";
import * as mbClient from "./mbClient.js";

mock.module("./mbClient.js", () => ({ fetchRecordingArtistCredit: mock() }));

const { enqueueArtistCreditLookups, processArtistCreditLookup } = await import("./artistCredit.js");
const { runDueJobs } = await import("./worker.js");

let db: Database;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-artist-credit-test-"));
  mock.clearAllMocks();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A real FLAC carrying ARTISTS twice, the way Picard writes it. ffmpeg can't
// repeat a tag, so node-taglib-sharp (the tag writer's own library) adds it.
function flacWithArtists(name: string, artist: string, artists: string[]): string {
  const filePath = path.join(dir, name);
  execFileSync(
    "ffmpeg",
    ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-metadata", `artist=${artist}`, filePath],
    {
      stdio: "ignore",
    },
  );
  const file = TagLibFile.createFromPath(filePath);
  (file.tag as unknown as FlacTag).xiphComment.setFieldAsStrings("ARTISTS", ...artists);
  file.save();
  file.dispose();
  return filePath;
}

// A file as a scan from before #273 left it: no `artists` key in tags_raw,
// the joined node already derived.
function scannedBefore(filePath: string, tags: Record<string, unknown>, mbid: string | null = null): number {
  const node = db
    .prepare("INSERT INTO nodes (type, title, mbid) VALUES ('recording', 'x', ?) RETURNING id")
    .get(mbid) as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  const root = db.prepare("INSERT OR IGNORE INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as
    { id: number } | undefined;
  const rootId = root?.id ?? (db.prepare("SELECT id FROM library_roots WHERE path = ?").get(dir) as { id: number }).id;
  const file = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw, match_source)
       VALUES (?, ?, ?, datetime('now'), 0, ?, ?) RETURNING id`,
    )
    .get(node.id, rootId, filePath, JSON.stringify(tags), mbid ? "mbid" : "unmatched") as { id: number };
  deriveLocalEdges(db, file.id);
  return node.id;
}

function performers(recording: number): string[] {
  return (
    db
      .prepare(
        `SELECT n.title FROM edges e JOIN nodes n ON n.id = e.to_node
          WHERE e.from_node = ? AND e.type = 'performed_by' ORDER BY e.id`,
      )
      .all(recording) as { title: string }[]
  ).map((r) => r.title);
}

// Runs the queued lookups and nothing else. runDueJobs would go on to the
// photo and description lookups the closing recompute queues, which reach
// Deezer and Wikipedia.
async function runLookups(): Promise<void> {
  const queued = db
    .prepare(
      "SELECT id, node_id FROM enrich_jobs WHERE job_type = 'artist_credit_lookup' AND status = 'queued' ORDER BY id",
    )
    .all() as { id: number; node_id: number }[];
  for (const job of queued) await processArtistCreditLookup(db, job);
}

function jobs(): { node_id: number; status: string; priority: number }[] {
  return db
    .prepare(
      "SELECT node_id, status, priority FROM enrich_jobs WHERE job_type = 'artist_credit_lookup' ORDER BY node_id",
    )
    .all() as { node_id: number; status: string; priority: number }[];
}

describe("enqueueArtistCreditLookups", () => {
  it("queues a recording with a joined line whose file hasn't been read for ARTISTS, or whose credit isn't kept", () => {
    const unread = scannedBefore(path.join(dir, "a.flac"), { artist: "Cage The Elephant, Alison Mosshart" });
    const matched = scannedBefore(path.join(dir, "b.flac"), { artist: "Simon & Garfunkel", artists: null }, "mb-sg");
    scannedBefore(path.join(dir, "c.flac"), { artist: "Bob Dylan" });
    scannedBefore(path.join(dir, "d.flac"), { artist: "Earth, Wind & Fire", artists: null });

    expect(enqueueArtistCreditLookups(db)).toBe(2);
    expect(jobs()).toEqual([
      { node_id: unread, status: "queued", priority: 1 },
      { node_id: matched, status: "queued", priority: 1 },
    ]);

    // Already waiting: not queued twice.
    expect(enqueueArtistCreditLookups(db)).toBe(0);
  });

  it("queues nothing with enrichment turned off", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('enrichmentEnabled', 'false')").run();
    scannedBefore(path.join(dir, "a.flac"), { artist: "Cage The Elephant, Alison Mosshart" });

    expect(enqueueArtistCreditLookups(db)).toBe(0);
  });
});

describe("artist_credit_lookup", () => {
  it("reads the ARTISTS tag again, splits the line, and puts the new artist on the map", async () => {
    const filePath = flacWithArtists("cage.flac", "Cage The Elephant, Alison Mosshart", [
      "Cage The Elephant",
      "Alison Mosshart",
    ]);
    const recording = scannedBefore(filePath, { artist: "Cage The Elephant, Alison Mosshart" });
    enqueueArtistCreditLookups(db);

    await runLookups();

    expect(performers(recording)).toEqual(["Cage The Elephant", "Alison Mosshart"]);
    expect(db.prepare("SELECT id FROM nodes WHERE title = 'Cage The Elephant, Alison Mosshart'").get()).toBeUndefined();
    expect(jobs().map((j) => j.status)).toEqual(["done"]);
    expect(mbClient.fetchRecordingArtistCredit).not.toHaveBeenCalled();
    // The recompute after the last lookup gives the new artist its row and
    // map position without waiting for a scan.
    const alison = db.prepare("SELECT id FROM nodes WHERE type = 'artist' AND title = 'Alison Mosshart'").get() as {
      id: number;
    };
    expect(db.prepare("SELECT track_count FROM artists WHERE node_id = ?").get(alison.id)).toEqual({ track_count: 1 });
    expect(db.prepare("SELECT 1 AS placed FROM positions WHERE node_id = ?").get(alison.id)).toEqual({ placed: 1 });

    // Caught up: the next start queues nothing.
    expect(enqueueArtistCreditLookups(db)).toBe(0);
  });

  it("asks MusicBrainz for a matched recording's credit, once", async () => {
    const filePath = path.join(dir, "missing-artists.flac");
    execFileSync(
      "ffmpeg",
      ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-metadata", "artist=x", filePath],
      {
        stdio: "ignore",
      },
    );
    const recording = scannedBefore(filePath, { artist: "Cage The Elephant, Alison Mosshart" }, "mb-forever");
    mocked(mbClient.fetchRecordingArtistCredit).mockResolvedValue([
      { name: "Cage the Elephant", artist: "Cage the Elephant", joinphrase: " & " },
      { name: "Alison Mosshart", artist: "Alison Mosshart", joinphrase: "" },
    ]);
    enqueueArtistCreditLookups(db);

    await runLookups();

    expect(mbClient.fetchRecordingArtistCredit).toHaveBeenCalledWith("mb-forever");
    expect(performers(recording)).toEqual(["Cage The Elephant", "Alison Mosshart"]);
    expect(enqueueArtistCreditLookups(db)).toBe(0);
  });

  it("records a recording MusicBrainz has no credit for, so it isn't asked again", async () => {
    const filePath = flacWithArtists("sg.flac", "Simon & Garfunkel", ["Simon & Garfunkel"]);
    const recording = scannedBefore(filePath, { artist: "Simon & Garfunkel" }, "mb-gone");
    mocked(mbClient.fetchRecordingArtistCredit).mockResolvedValue(null);
    enqueueArtistCreditLookups(db);

    await runLookups();

    expect(performers(recording)).toEqual(["Simon & Garfunkel"]);
    expect(enqueueArtistCreditLookups(db)).toBe(0);
  });

  // Through the worker, so its dispatch and back-off are covered too.
  it("retries a file it can't reach, leaving the line as it was", async () => {
    const recording = scannedBefore(path.join(dir, "unplugged.flac"), { artist: "Cage The Elephant, Alison Mosshart" });
    enqueueArtistCreditLookups(db);

    await runDueJobs(db);

    expect(jobs().map((j) => j.status)).toEqual(["error"]);
    expect(performers(recording)).toEqual(["Cage The Elephant, Alison Mosshart"]);
  });
});
