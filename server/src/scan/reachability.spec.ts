import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { healthRoutes } from "../routes/health.js";
import {
  checkLibraryRoot,
  forgetRoot,
  getRootReachability,
  parseFstabMountPoints,
  recordReachability,
} from "./reachability.js";
import { runFullScan, runIncrementalScan } from "./scanner.js";
import { unwatchLibraryRoot, watchLibraryRoot } from "./watcher.js";

// Issue #192. Every test here uses a real temp library root that is
// deleted or emptied between scans — the on-disk shape of a drive that
// dropped (root path gone) or an unmounted mount point (root still there,
// nothing under it).

function writeSilentWav(filePath: string, seconds = 1, sampleRate = 8000) {
  const numSamples = seconds * sampleRate;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  writeFileSync(filePath, buffer);
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!condition()) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

let db: Database;
let dir: string;
let libraryRootId: number;

// Two album folders of two tracks each, so "emptied" can mean removing
// the folders (what an unmount looks like) rather than the root itself.
const ALBUMS = ["Album A", "Album B"];
function populate(): string[] {
  const written: string[] = [];
  for (const album of ALBUMS) {
    mkdirSync(path.join(dir, album), { recursive: true });
    for (const n of [1, 2]) {
      const file = path.join(dir, album, `${n}.wav`);
      writeSilentWav(file);
      written.push(file);
    }
  }
  return written;
}

function emptyRoot(): void {
  for (const album of ALBUMS) rmSync(path.join(dir, album), { recursive: true, force: true });
}

function missingCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM files WHERE missing_since IS NOT NULL").get() as { n: number }).n;
}

function loadJob(jobId: number) {
  return db.prepare("SELECT status, error_message, files_missing FROM scan_jobs WHERE id = ?").get(jobId) as {
    status: string;
    error_message: string | null;
    files_missing: number;
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-reachability-test-"));
  const row = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
  libraryRootId = row.id;
});

afterEach(() => {
  unwatchLibraryRoot(libraryRootId);
  forgetRoot(libraryRootId);
  rmSync(dir, { recursive: true, force: true });
});

describe("full scan against an unreachable root", () => {
  it("marks nothing missing when the root was deleted, and ends with the H9 message", async () => {
    populate();
    await runFullScan(db, libraryRootId, dir);
    rmSync(dir, { recursive: true, force: true });

    const jobId = await runFullScan(db, libraryRootId, dir);

    expect(missingCount()).toBe(0);
    const job = loadJob(jobId);
    expect(job.status).toBe("error");
    expect(job.error_message).toContain(`library drive at ${dir} isn't reachable; files weren't marked missing`);
    expect(getRootReachability(libraryRootId)).toMatchObject({ reachable: false, reason: "missing" });
  });

  it("marks nothing missing when the root is still there but empty (an unmounted mount point)", async () => {
    populate();
    await runFullScan(db, libraryRootId, dir);
    emptyRoot();

    const jobId = await runFullScan(db, libraryRootId, dir);

    expect(missingCount()).toBe(0);
    expect(loadJob(jobId).status).toBe("error");
    expect(loadJob(jobId).error_message).toContain("4 indexed files");
    expect(getRootReachability(libraryRootId)).toMatchObject({ reachable: false, reason: "empty" });
  });

  it("proceeds normally once the drive is back, including marking a file really deleted meanwhile", async () => {
    const written = populate();
    await runFullScan(db, libraryRootId, dir);
    emptyRoot();
    await runFullScan(db, libraryRootId, dir);
    expect(getRootReachability(libraryRootId)?.reachable).toBe(false);

    populate();
    unlinkSync(written[0]);
    const jobId = await runFullScan(db, libraryRootId, dir);

    expect(loadJob(jobId)).toMatchObject({ status: "done", error_message: null, files_missing: 1 });
    expect(missingCount()).toBe(1);
    expect(getRootReachability(libraryRootId)).toMatchObject({ reachable: true, reason: null });
  });

  it("stops an incremental scan too, and a brand-new empty root is still fine", async () => {
    const fresh = await runFullScan(db, libraryRootId, dir);
    expect(loadJob(fresh).status).toBe("done"); // nothing indexed yet, so empty is just empty

    populate();
    await runFullScan(db, libraryRootId, dir);
    rmSync(dir, { recursive: true, force: true });
    const jobId = await runIncrementalScan(db, libraryRootId, dir);
    expect(loadJob(jobId).status).toBe("error");
  });
});

describe("checkLibraryRoot", () => {
  it("fails a root whose configured mount point isn't mounted", async () => {
    populate();
    await runFullScan(db, libraryRootId, dir);
    // A plain temp directory sits on its parent's device — exactly what an
    // fstab mount point looks like once whatever was mounted there is gone.
    const fstab = path.join(dir, "..", `fstab-${path.basename(dir)}`);
    writeFileSync(fstab, `UUID=abcd  ${dir}  ext4  defaults,nofail  0  2\n`);
    try {
      const result = await checkLibraryRoot(db, libraryRootId, dir, {}, { fstabPath: fstab });
      expect(result).toMatchObject({ reachable: false, reason: "not_mounted" });
      expect(getRootReachability(libraryRootId)?.message).toContain(`${dir} isn't mounted`);
    } finally {
      rmSync(fstab, { force: true });
    }
  });

  it("reads mount points out of fstab, undoing its octal escapes and skipping / and swap", () => {
    const points = parseFstabMountPoints(
      [
        "# /etc/fstab",
        "PARTUUID=1  /  ext4  defaults  0  1",
        "UUID=2  /mnt/music  ext4  defaults,nofail  0  2",
        "nas:/volume1/My\\040Music  /mnt/My\\040Music  nfs  ro  0  0",
        "/swapfile  none  swap  sw  0  0",
        "",
      ].join("\n"),
    );
    expect(points).toEqual(["/mnt/music", "/mnt/My Music"]);
  });
});

describe("watcher against an unreachable root", () => {
  // A real chokidar watch, not the fake one watcher.spec.ts uses: this is
  // the reproduction. On main, emptying the root (what an unmount does to
  // the mount-point directory) produced one 'unlink' per file and every
  // one of them was marked missing.
  async function startRealWatcher(): Promise<void> {
    let ready = false;
    const watch: typeof chokidar.watch = (paths, options) => {
      const watcher: FSWatcher = chokidar.watch(paths, options);
      watcher.on("ready", () => (ready = true));
      return watcher;
    };
    watchLibraryRoot(db, libraryRootId, dir, { watch, unlinkBurstWindowMs: 200 });
    await waitUntil(() => ready);
    await waitUntil(() => getRootReachability(libraryRootId)?.reachable === true);
  }

  it("marks nothing missing when every file under the root disappears at once", async () => {
    populate();
    await runFullScan(db, libraryRootId, dir);
    await startRealWatcher();

    emptyRoot();

    await waitUntil(() => getRootReachability(libraryRootId)?.reachable === false);
    expect(getRootReachability(libraryRootId)?.reason).toBe("empty");
    expect(missingCount()).toBe(0);

    // The drive coming back: 'add' events re-check the root and clear the flag.
    populate();
    await waitUntil(() => getRootReachability(libraryRootId)?.reachable === true);
    expect(missingCount()).toBe(0);
  });

  it("still marks one really deleted file missing", async () => {
    const written = populate();
    await runFullScan(db, libraryRootId, dir);
    await startRealWatcher();

    unlinkSync(written[0]);

    await waitUntil(() => missingCount() === 1);
    expect(getRootReachability(libraryRootId)?.reachable).toBe(true);
  });

  it("still marks a mass deletion missing when music is left under the root", async () => {
    const written = populate();
    await runFullScan(db, libraryRootId, dir);
    await startRealWatcher();

    // Three of four is over the burst threshold, so this goes through the
    // verified path — and the one file left proves the drive is there.
    for (const file of written.slice(0, 3)) unlinkSync(file);

    await waitUntil(() => missingCount() === 3);
    expect(getRootReachability(libraryRootId)?.reachable).toBe(true);
  });
});

describe("GET /api/v1/health", () => {
  it("reports each root's reachability alongside status", async () => {
    recordReachability(libraryRootId, dir, {
      reachable: false,
      reason: "not_mounted",
      message: `library drive at ${dir} isn't reachable; files weren't marked missing (${dir} isn't mounted)`,
    });
    const app = Fastify();
    await app.register(healthRoutes(), { prefix: "/api/v1" });

    const res = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; libraryRoots: unknown[] };
    expect(body.status).toBe("ok");
    expect(body.libraryRoots).toContainEqual(
      expect.objectContaining({ libraryRootId, path: dir, reachable: false, reason: "not_mounted" }),
    );
  });
});
