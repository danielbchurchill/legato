import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { unwatchLibraryRoot, watchLibraryRoot } from "./watcher.js";

type LibraryRootRow = { watch_status: string; watch_fallback_reason: string | null };

async function waitUntil(condition: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!condition()) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

// A stand-in for chokidar's FSWatcher that never touches a real filesystem
// watch — this Mac has no inotify to actually exhaust, so every test here
// drives watcher.ts through its injected `watch`/`maxUserWatches` seams
// (watchLibraryRoot's third argument) instead. It only needs to be a real
// EventEmitter (chokidar's 'error'/'ready'/'addDir' are all plain emitted
// events) plus the two methods watcher.ts actually calls on it.
class FakeWatcher extends EventEmitter {
  closed = false;
  private watched: Record<string, string[]>;

  constructor(watched: Record<string, string[]> = {}) {
    super();
    this.watched = watched;
  }

  getWatched(): Record<string, string[]> {
    return this.watched;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function fakeWatchFactory(watcher: FakeWatcher): typeof chokidar.watch {
  return (() => watcher as unknown as FSWatcher) as typeof chokidar.watch;
}

let db: Database;
let dir: string;
let libraryRootId: number;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "legato-watcher-test-"));
  const row = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(dir) as { id: number };
  libraryRootId = row.id;
});

afterEach(() => {
  unwatchLibraryRoot(libraryRootId);
  rmSync(dir, { recursive: true, force: true });
});

function loadRoot(): LibraryRootRow {
  return db
    .prepare("SELECT watch_status, watch_fallback_reason FROM library_roots WHERE id = ?")
    .get(libraryRootId) as LibraryRootRow;
}

describe("watchLibraryRoot / reactive fallback", () => {
  it("falls back to periodic rescans on a real chokidar ENOSPC", async () => {
    let captured: FSWatcher | undefined;
    const watch: typeof chokidar.watch = (paths, options) => {
      captured = chokidar.watch(paths, options);
      return captured;
    };

    watchLibraryRoot(db, libraryRootId, dir, { watch });
    await waitUntil(() => captured !== undefined);
    expect(loadRoot()).toEqual({ watch_status: "watching", watch_fallback_reason: null });

    captured!.emit("error", Object.assign(new Error("no space left"), { code: "ENOSPC" }));

    await waitUntil(() => loadRoot().watch_status === "fallback");
    expect(loadRoot()).toEqual({ watch_status: "fallback", watch_fallback_reason: "enospc" });
    // The exhausted watcher is closed rather than left running and
    // re-erroring on every subsequent fs event it can't act on.
    await waitUntil(() => captured!.closed);
  });

  it("falls back on EMFILE the same way, tagged with the distinct reason", async () => {
    let captured: FSWatcher | undefined;
    const watch: typeof chokidar.watch = (paths, options) => {
      captured = chokidar.watch(paths, options);
      return captured;
    };

    watchLibraryRoot(db, libraryRootId, dir, { watch });
    await waitUntil(() => captured !== undefined);

    captured!.emit("error", Object.assign(new Error("too many open files"), { code: "EMFILE" }));

    await waitUntil(() => loadRoot().watch_status === "fallback");
    expect(loadRoot().watch_fallback_reason).toBe("emfile");
  });

  it("leaves an unrelated watcher error (e.g. a broken symlink) alone", async () => {
    let captured: FSWatcher | undefined;
    const watch: typeof chokidar.watch = (paths, options) => {
      captured = chokidar.watch(paths, options);
      return captured;
    };

    watchLibraryRoot(db, libraryRootId, dir, { watch });
    await waitUntil(() => captured !== undefined);

    captured!.emit("error", Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(loadRoot()).toEqual({ watch_status: "watching", watch_fallback_reason: null });
  });
});

describe("watchLibraryRoot / proactive near-limit fallback", () => {
  it("falls back once the watched directory count closes in on max_user_watches", () => {
    const fake = new FakeWatcher({ ".": [], a: [], b: [] }); // 3 watched entries
    watchLibraryRoot(db, libraryRootId, dir, {
      watch: fakeWatchFactory(fake),
      maxUserWatches: () => 3, // already at 100% of a limit of 3
    });

    fake.emit("ready");

    expect(loadRoot()).toEqual({ watch_status: "fallback", watch_fallback_reason: "near_limit" });
    expect(fake.closed).toBe(true);
  });

  it("does not fall back while comfortably under the limit", () => {
    const fake = new FakeWatcher({ ".": [] });
    watchLibraryRoot(db, libraryRootId, dir, {
      watch: fakeWatchFactory(fake),
      maxUserWatches: () => 8192,
    });

    fake.emit("ready");
    fake.emit("addDir");

    expect(loadRoot()).toEqual({ watch_status: "watching", watch_fallback_reason: null });
    expect(fake.closed).toBe(false);
  });

  it("does not fall back when the limit can't be read (non-Linux)", () => {
    const fake = new FakeWatcher({ ".": [], a: [], b: [], c: [] });
    watchLibraryRoot(db, libraryRootId, dir, {
      watch: fakeWatchFactory(fake),
      maxUserWatches: () => null,
    });

    fake.emit("ready");

    expect(loadRoot().watch_status).toBe("watching");
  });

  it("ignores a stray 'ready'/'addDir' that arrives after the root was already unwatched", () => {
    const fake = new FakeWatcher({ ".": [], a: [], b: [] });
    watchLibraryRoot(db, libraryRootId, dir, {
      watch: fakeWatchFactory(fake),
      maxUserWatches: () => 3, // would trigger near_limit if acted on
    });

    // Removed (e.g. the library root was deleted) before its own watcher's
    // async 'ready' had a chance to fire.
    unwatchLibraryRoot(libraryRootId);
    fake.emit("ready");

    // No fallback timer left running against a root that's gone — a
    // periodic rescan against a missing library_root_id would just error
    // forever with nothing left to ever clear it.
    expect(loadRoot()).toEqual({ watch_status: "watching", watch_fallback_reason: null });
  });
});

describe("periodic rescan timer", () => {
  it("picks up a file that arrived after falling back, on its own without any live watcher", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('watchFallbackMinutes', ?)").run("0.001"); // 60ms

    const fake = new FakeWatcher();
    watchLibraryRoot(db, libraryRootId, dir, {
      watch: fakeWatchFactory(fake),
      maxUserWatches: () => null,
    });
    fake.emit("error", Object.assign(new Error("no space left"), { code: "ENOSPC" }));
    await waitUntil(() => loadRoot().watch_status === "fallback");

    const filePath = path.join(dir, "new-track.flac");
    writeFileSync(filePath, "x");

    await waitUntil(() => {
      const row = db.prepare("SELECT id FROM files WHERE file_path = ?").get(filePath);
      return row !== undefined;
    }, 5000);
  });

  it("stops polling once unwatchLibraryRoot clears the timer", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('watchFallbackMinutes', ?)").run("0.001"); // 60ms

    const fake = new FakeWatcher();
    watchLibraryRoot(db, libraryRootId, dir, {
      watch: fakeWatchFactory(fake),
      maxUserWatches: () => null,
    });
    fake.emit("error", Object.assign(new Error("no space left"), { code: "ENOSPC" }));
    await waitUntil(() => loadRoot().watch_status === "fallback");

    unwatchLibraryRoot(libraryRootId);

    const filePath = path.join(dir, "arrived-after-unwatch.flac");
    writeFileSync(filePath, "x");
    await new Promise((resolve) => setTimeout(resolve, 250)); // several ticks' worth, if the timer survived

    const row = db.prepare("SELECT id FROM files WHERE file_path = ?").get(filePath);
    expect(row).toBeUndefined();
  });

  it("re-watching a still-fallen-back root clears the stale timer instead of running both at once", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('watchFallbackMinutes', ?)").run("0.001"); // 60ms

    const firstFake = new FakeWatcher();
    watchLibraryRoot(db, libraryRootId, dir, {
      watch: fakeWatchFactory(firstFake),
      maxUserWatches: () => null,
    });
    firstFake.emit("error", Object.assign(new Error("no space left"), { code: "ENOSPC" }));
    await waitUntil(() => loadRoot().watch_status === "fallback");

    // Confirm the fallback timer is really running before relying on it
    // having stopped. fallBackToPolling() already removed this root from
    // activeWatchers, which is exactly what lets a second watchLibraryRoot
    // call for the same id proceed below without going through
    // unwatchLibraryRoot first — the realistic shape of "the limit got
    // raised, watch it again" without a full process restart in between.
    const firstFile = path.join(dir, "picked-up-by-fallback.flac");
    writeFileSync(firstFile, "x");
    await waitUntil(() => db.prepare("SELECT id FROM files WHERE file_path = ?").get(firstFile) !== undefined);

    const secondFake = new FakeWatcher();
    watchLibraryRoot(db, libraryRootId, dir, {
      watch: fakeWatchFactory(secondFake),
      maxUserWatches: () => null,
    });

    expect(loadRoot()).toEqual({ watch_status: "watching", watch_fallback_reason: null });

    const secondFile = path.join(dir, "not-picked-up.flac");
    writeFileSync(secondFile, "x");
    await new Promise((resolve) => setTimeout(resolve, 250)); // several of the old 60ms ticks, if it survived

    // The fake watcher never emits 'add', and the old fallback timer
    // should have been cleared — so nothing should have scanned this file.
    const row = db.prepare("SELECT id FROM files WHERE file_path = ?").get(secondFile);
    expect(row).toBeUndefined();
  });
});
