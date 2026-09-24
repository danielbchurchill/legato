import chokidar, { type FSWatcher } from "chokidar";
import type { Database } from "../sqlite.js";
import { broadcast } from "../ws.js";
import { isSelfWrite } from "../tagwrite/guard.js";
import { markMissing, scanFile } from "./scanner.js";
import { isAudioFile } from "./walk.js";
import { CHOKIDAR_IGNORED } from "./junk.js";

const activeWatchers = new Map<number, FSWatcher>();

// Started once a library root's initial full scan completes. Reacts to a
// single changed/added/removed path directly via scanFile()/markMissing()
// instead of re-walking the whole root — a one-file tag edit produces a
// one-file incremental scan, not a full rewalk.
export function watchLibraryRoot(db: Database, libraryRootId: number, rootPath: string): void {
  if (activeWatchers.has(libraryRootId)) return;

  const watcher = chokidar.watch(rootPath, {
    ignoreInitial: true,
    // Wait for writes to settle before reacting — a tag write or an
    // in-progress copy shouldn't be read mid-write.
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    // Filesystem-junk directories chokidar can't (and shouldn't) watch:
    // ext4's lost+found is root-only (real EACCES hit scanning /mnt/music
    // on this machine), the rest are the equivalent junk on other OSes/tools.
    // Same list as the fast-glob walker (see scan/walk.ts) — one shared
    // source in scan/junk.ts so the two can't drift apart (issue #99).
    ignored: CHOKIDAR_IGNORED,
  });

  // An unwatchable subdirectory (permissions, a broken symlink, races with
  // deletion) must not take the whole server down — chokidar emits 'error'
  // as a plain EventEmitter event, and Node kills the process on an
  // unhandled one by default.
  watcher.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[watcher] ${message}`);
    broadcast("scan:error", { libraryRootId, error: message });
  });

  const handleChange = async (filePath: string) => {
    if (!isAudioFile(filePath)) return;
    try {
      if (await isSelfWrite(db, filePath)) {
        // Our own write settling, not an external edit — we already know
        // the new values (we just wrote them), so skip the full re-parse
        // + re-collapse + re-enrich-check cycle entirely. This is the
        // actual mechanism behind "no feedback loop," not just a filter
        // on top of the normal path.
        db.prepare("UPDATE files SET last_seen_at = datetime('now') WHERE file_path = ?").run(filePath);
        broadcast("scan:file", { libraryRootId, filePath, outcome: "self-write-settled" });
        return;
      }
      const outcome = await scanFile(db, libraryRootId, filePath);
      broadcast("scan:file", { libraryRootId, filePath, outcome });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast("scan:error", { libraryRootId, filePath, error: message });
    }
  };

  watcher.on("add", handleChange);
  watcher.on("change", handleChange);
  watcher.on("unlink", (filePath) => {
    if (!isAudioFile(filePath)) return;
    markMissing(db, filePath);
    broadcast("scan:file", { libraryRootId, filePath, outcome: "missing" });
  });

  activeWatchers.set(libraryRootId, watcher);
}

export function unwatchLibraryRoot(libraryRootId: number): void {
  const watcher = activeWatchers.get(libraryRootId);
  if (watcher) {
    void watcher.close();
    activeWatchers.delete(libraryRootId);
  }
}
