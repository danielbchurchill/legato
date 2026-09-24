import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CHOKIDAR_IGNORED } from "./junk.js";
import { walkLibraryRoot } from "./walk.js";

// One fixture tree exercising every entry in scan/junk.ts's shared list,
// plus a real audio file, so both consumers (fast-glob in walk.ts,
// chokidar in watcher.ts) are proven against the same layout.
const JUNK_DIRS = [
  "@eaDir", // Synology thumbnail cache
  "#recycle", // Synology recycle bin
  "#snapshot", // Synology/QNAP/NetApp snapshot directory
  ".@__thumb", // QNAP thumbnail cache
  ".Trash-1000", // Linux desktop trash
  "lost+found", // ext4/ext3 root-only recovery directory
  "System Volume Information", // Windows/NTFS index
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-junk-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function toPosixRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("walkLibraryRoot", () => {
  it("skips NAS/OS junk directories and files while still finding real audio", async () => {
    mkdirSync(path.join(dir, "Artist", "Album"), { recursive: true });
    writeFileSync(path.join(dir, "Artist", "Album", "01 Real Track.flac"), "x");
    writeFileSync(path.join(dir, "Artist", ".DS_Store"), "x");
    writeFileSync(path.join(dir, "Artist", "._01 Real Track.flac"), "x");
    for (const junkDir of JUNK_DIRS) {
      mkdirSync(path.join(dir, "Artist", junkDir), { recursive: true });
      writeFileSync(path.join(dir, "Artist", junkDir, "junk.flac"), "x");
    }

    const found = await walkLibraryRoot(dir);

    expect(found.map((p) => toPosixRelative(dir, p))).toEqual(["Artist/Album/01 Real Track.flac"]);
  });
});

describe("CHOKIDAR_IGNORED", () => {
  it("never emits add events for junk paths while still watching real ones", async () => {
    mkdirSync(path.join(dir, "Artist", "Album"), { recursive: true });
    for (const junkDir of JUNK_DIRS) {
      mkdirSync(path.join(dir, "Artist", junkDir), { recursive: true });
    }

    const watcher = chokidar.watch(dir, { ignoreInitial: true, ignored: CHOKIDAR_IGNORED });
    const added: string[] = [];
    watcher.on("add", (filePath) => added.push(toPosixRelative(dir, filePath)));
    await new Promise<void>((resolve) => watcher.once("ready", resolve));

    // On macOS, fs.watch can drop events written in the first moments after
    // chokidar reports "ready", which made this test miss the real file ~1 run
    // in 5. Re-touch a probe until the watcher demonstrably sees it, so every
    // junk write below lands on a watcher that is actually live.
    const probe = path.join(dir, "Artist", "Album", "00 Probe.flac");
    for (let start = Date.now(); !added.includes("Artist/Album/00 Probe.flac") && Date.now() - start < 5000; ) {
      writeFileSync(probe, "x");
      await waitUntil(() => added.includes("Artist/Album/00 Probe.flac"), 250);
    }

    for (const junkDir of JUNK_DIRS) {
      writeFileSync(path.join(dir, "Artist", junkDir, "junk.flac"), "x");
    }
    writeFileSync(path.join(dir, "Artist", ".DS_Store"), "x");
    writeFileSync(path.join(dir, "Artist", "._01 Real Track.flac"), "x");
    writeFileSync(path.join(dir, "Artist", "Album", "01 Real Track.flac"), "x");

    // Wait for the real file's add event, then give any stray junk events
    // a little extra time to show up before asserting they never did.
    await waitUntil(() => added.includes("Artist/Album/01 Real Track.flac"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await watcher.close();

    expect(added).toEqual(["Artist/Album/00 Probe.flac", "Artist/Album/01 Real Track.flac"]);
  }, 15000);
});
