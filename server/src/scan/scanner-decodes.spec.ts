import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { MEDIA_CONCURRENCY_LIMIT } from "../config.js";
import { runMediaTask } from "../media/queue.js";
import { scanDecodeShare } from "./decode-window.js";

// Issue #189: the 'enrich_queued' stage's waveform decodes, driven against
// the real shared media queue (#111) with the decode itself swapped for one
// the test can hold open. The stand-in goes through runMediaTask exactly as
// waveform/decode.ts's computePeaks does, so "how many slots does a scan
// take" is measured on the same queue a stream transcode would wait on.
let holdDecodes = false;
let waiting: (() => void)[] = [];
let active = 0;
let peakActive = 0;
let decoded = new Set<number>();

mock.module("../waveform/peaks.js", () => ({
  ensurePeaksForFile: (_db: Database, fileId: number) =>
    runMediaTask("background", async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      if (holdDecodes) await new Promise<void>((resolve) => waiting.push(resolve));
      active--;
      decoded.add(fileId);
    }),
  getOrComputePeaks: async () => null,
}));

const { createScanJob, executeScan, requestCancelScanJob, requestPauseScanJob, resumeScanJob } = await import(
  "./scanner.js"
);

const share = scanDecodeShare(MEDIA_CONCURRENCY_LIMIT);

function writeSilentWav(filePath: string) {
  const dataSize = 800 * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  writeFileSync(filePath, buffer);
}

// Polls rather than sleeping a fixed time: the stages before enrich_queued
// do real tag reads, so how long they take depends on the machine.
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function releaseAll() {
  holdDecodes = false;
  const pending = waiting;
  waiting = [];
  for (const resolve of pending) resolve();
}

let db: Database;
let dir: string;
let libraryRootId: number;

beforeEach(() => {
  holdDecodes = false;
  waiting = [];
  active = 0;
  peakActive = 0;
  decoded = new Set();
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-scan-decodes-test-"));
  libraryRootId = (db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number })
    .id;
});

afterEach(() => {
  releaseAll();
  rmSync(dir, { recursive: true, force: true });
});

function jobRow(jobId: number) {
  return db.prepare("SELECT status, stage, cursor FROM scan_jobs WHERE id = ?").get(jobId) as {
    status: string;
    stage: string;
    cursor: number;
  };
}

describe("enrich_queued waveform decodes", () => {
  it("run several at once, never more than the scan's share of the media limit", async () => {
    const total = share * 3 + 2;
    for (let i = 0; i < total; i++) writeSilentWav(path.join(dir, `t${i}.wav`));
    holdDecodes = true;

    const jobId = createScanJob(db, libraryRootId, "full");
    const scan = executeScan(db, jobId, libraryRootId, dir);

    await until(() => waiting.length === share, "the decode window to fill");
    // Give the loop a chance to overrun the window if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(active).toBe(share);

    releaseAll();
    await scan;

    expect(jobRow(jobId).status).toBe("done");
    expect(peakActive).toBe(share);
    const fileIds = (db.prepare("SELECT id FROM files").all() as { id: number }[]).map((r) => r.id);
    expect(fileIds.length).toBe(total);
    for (const id of fileIds) expect(decoded.has(id)).toBe(true);
  });

  // The Pi case (4 cores, limit 3) is pinned down against a fixed-size queue
  // in decode-window.spec.ts; this is the same check on the real shared
  // queue, which only has a slot to spare when the host has more than one.
  it.if(MEDIA_CONCURRENCY_LIMIT > 1)("leave a slot free so a stream transcode starts while they're saturated", async () => {
    for (let i = 0; i < share * 2 + 1; i++) writeSilentWav(path.join(dir, `t${i}.wav`));
    holdDecodes = true;

    const jobId = createScanJob(db, libraryRootId, "full");
    const scan = executeScan(db, jobId, libraryRootId, dir);
    await until(() => waiting.length === share, "the decode window to fill");

    // What stream/cache.ts does for a transcode: a playback-priority task
    // on the same queue. It must start now, not after a decode exits.
    let transcodeStarted = false;
    const transcode = runMediaTask("playback", async () => {
      transcodeStarted = true;
    });
    await until(() => transcodeStarted, "the stream transcode to start");
    expect(waiting.length).toBe(share); // every scan decode still held open
    await transcode;

    releaseAll();
    await scan;
    expect(jobRow(jobId).status).toBe("done");
  });

  it("finish before a pause persists the cursor, so resume skips nothing", async () => {
    for (let i = 0; i < share * 2 + 3; i++) writeSilentWav(path.join(dir, `t${i}.wav`));
    holdDecodes = true;

    const jobId = createScanJob(db, libraryRootId, "full");
    const scan = executeScan(db, jobId, libraryRootId, dir);
    await until(() => waiting.length === share, "the decode window to fill");

    requestPauseScanJob(db, jobId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still waiting on the held decodes: nothing is marked paused, and
    // enrich_queued hasn't written a cursor of its own yet — the row still
    // holds the one 'layout' left behind.
    expect(jobRow(jobId)).toEqual({ status: "running", stage: "layout", cursor: 1 });

    releaseAll();
    await scan;

    const paused = jobRow(jobId);
    expect(paused.status).toBe("paused");
    expect(paused.stage).toBe("enrich_queued");
    expect(active).toBe(0);
    const beforeCursor = db
      .prepare("SELECT file_id FROM scan_run_files WHERE job_id = ? AND seq < ?")
      .all(jobId, paused.cursor) as { file_id: number }[];
    expect(beforeCursor.length).toBe(paused.cursor);
    for (const { file_id } of beforeCursor) expect(decoded.has(file_id)).toBe(true);

    await resumeScanJob(db, jobId);
    expect(jobRow(jobId).status).toBe("done");
    const fileIds = (db.prepare("SELECT id FROM files").all() as { id: number }[]).map((r) => r.id);
    for (const id of fileIds) expect(decoded.has(id)).toBe(true);
  });

  it("finish before a cancel finalizes the job, leaving nothing running behind it", async () => {
    for (let i = 0; i < share * 2 + 3; i++) writeSilentWav(path.join(dir, `t${i}.wav`));
    holdDecodes = true;

    const jobId = createScanJob(db, libraryRootId, "full");
    let scanReturned = false;
    const scan = executeScan(db, jobId, libraryRootId, dir).then(() => (scanReturned = true));
    await until(() => waiting.length === share, "the decode window to fill");

    requestCancelScanJob(db, jobId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scanReturned).toBe(false);
    expect(jobRow(jobId).status).toBe("running");

    releaseAll();
    await scan;

    expect(jobRow(jobId).status).toBe("canceled");
    expect(active).toBe(0);
  });
});
