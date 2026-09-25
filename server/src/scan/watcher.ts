import chokidar, { type FSWatcher } from "chokidar";
import type { Database } from "../sqlite.js";
import { broadcast } from "../ws.js";
import { isSelfWrite } from "../tagwrite/guard.js";
import { markMissing, runIncrementalScan, scanFile } from "./scanner.js";
import { isAudioFile } from "./walk.js";
import { CHOKIDAR_IGNORED } from "./junk.js";
import {
  isNearWatchLimit,
  isWatchExhaustionError,
  readMaxUserWatches,
  watchExhaustionReason,
  type WatchFallbackReason,
} from "./watch-limit.js";

const activeWatchers = new Map<number, FSWatcher>();

// One periodic-rescan timer per root currently degraded to polling.
// unwatchLibraryRoot() clears it, and watchLibraryRoot() never sets one
// without going through fallBackToPolling() first — so a removed or
// freshly-rewatched root can never be left with a stray timer still
// hitting the database for it (issue #122).
const fallbackTimers = new Map<number, ReturnType<typeof setInterval>>();

const DEFAULT_FALLBACK_MINUTES = 30;

// docs/plans/04-library-and-scan.md calls the interval "configurable" —
// this reads the same generic key/value settings table every other
// per-install knob in this app already goes through (routes/settings.ts),
// rather than inventing a bespoke config surface just for one timer.
function fallbackIntervalMs(db: Database): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'watchFallbackMinutes'").get() as
    | { value: string }
    | undefined;
  const minutes = row ? Number.parseFloat(row.value) : NaN;
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_FALLBACK_MINUTES) * 60_000;
}

function setWatchStatus(
  db: Database,
  libraryRootId: number,
  status: "watching" | "fallback",
  reason: WatchFallbackReason | null,
): void {
  db.prepare("UPDATE library_roots SET watch_status = ?, watch_fallback_reason = ? WHERE id = ?").run(
    status,
    reason,
    libraryRootId,
  );
  // Same broadcaster as scan:progress/scan:done — the settings screen and
  // LibrarySetup already hold a WS connection open for those, so this is
  // one more event name on it rather than a second channel (see
  // src/hooks/useWs.ts).
  broadcast("watch:status", { libraryRootId, watchStatus: status, reason });
}

// Reactive (chokidar actually threw ENOSPC/EMFILE) and proactive (the
// watched-directory count closed in on max_user_watches before it had to)
// both funnel through here, so either path produces the exact same DB
// row, broadcast, and periodic-rescan timer — see watch-limit.ts for the
// pure detection logic this wraps.
function fallBackToPolling(
  db: Database,
  libraryRootId: number,
  rootPath: string,
  reason: WatchFallbackReason,
): void {
  if (fallbackTimers.has(libraryRootId)) return; // already degraded, nothing new to do

  const watcher = activeWatchers.get(libraryRootId);
  activeWatchers.delete(libraryRootId);
  // Closing it here, not just abandoning it, matters: a watcher that's
  // already out of capacity keeps re-emitting the same 'error' for every
  // subsequent fs event chokidar can't act on otherwise.
  if (watcher) void watcher.close();

  setWatchStatus(db, libraryRootId, "fallback", reason);
  console.warn(`[watcher] library root ${libraryRootId}: ${reason}, falling back to periodic incremental rescans`);

  const rescan = () => {
    runIncrementalScan(db, libraryRootId, rootPath, (progress) => broadcast("scan:progress", progress)).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        broadcast("scan:error", { libraryRootId, error: message });
      },
    );
  };

  const timer = setInterval(rescan, fallbackIntervalMs(db));
  timer.unref?.(); // this alone shouldn't keep the process (or a test) alive
  fallbackTimers.set(libraryRootId, timer);
}

// Shared by 'ready' (the initial directory tree — the highest-risk moment
// on a library that's already big when the watcher first starts, since
// ignoreInitial suppresses 'addDir' for every one of those directories)
// and 'addDir' (everything watched after that, e.g. a whole new artist
// folder dropped in at once).
function checkWatchLimit(
  watcher: FSWatcher,
  db: Database,
  libraryRootId: number,
  rootPath: string,
  maxUserWatches: () => number | null,
): void {
  // unwatchLibraryRoot() can run before a 'ready'/'addDir' that was already
  // in flight gets here (the root was removed, or the process is shutting
  // down mid-walk) — acting on it anyway would start a fallback timer for
  // a root nothing will ever clear again, quietly retrying forever against
  // a library_root_id that may no longer exist.
  if (!activeWatchers.has(libraryRootId)) return; // torn down already
  if (fallbackTimers.has(libraryRootId)) return; // already fell back
  const watchedDirCount = Object.keys(watcher.getWatched()).length;
  if (isNearWatchLimit(watchedDirCount, maxUserWatches())) {
    fallBackToPolling(db, libraryRootId, rootPath, "near_limit");
  }
}

// watch/maxUserWatches are dependency-injection seams for watcher.spec.ts —
// this Mac has no inotify to actually exhaust, so tests substitute a fake
// chokidar-shaped watcher and a fake limit reader rather than needing a
// real one of either (same spirit as scanFile's injectable onWarn).
type WatchLibraryRootDeps = {
  watch?: typeof chokidar.watch;
  maxUserWatches?: () => number | null;
};

// Started once a library root's initial full scan completes. Reacts to a
// single changed/added/removed path directly via scanFile()/markMissing()
// instead of re-walking the whole root — a one-file tag edit produces a
// one-file incremental scan, not a full rewalk.
export function watchLibraryRoot(
  db: Database,
  libraryRootId: number,
  rootPath: string,
  deps: WatchLibraryRootDeps = {},
): void {
  if (activeWatchers.has(libraryRootId)) return;

  const watch = deps.watch ?? chokidar.watch;
  const maxUserWatches = deps.maxUserWatches ?? readMaxUserWatches;

  // A stray fallback timer from before this call must not keep polling
  // alongside the live watcher this call is about to start — otherwise
  // raising the limit and restarting leaves the root double-covered
  // forever instead of going back to a single source of truth.
  const staleTimer = fallbackTimers.get(libraryRootId);
  if (staleTimer) {
    clearInterval(staleTimer);
    fallbackTimers.delete(libraryRootId);
  }

  // A root landing here after a previous fallback (server restart, or the
  // limit got raised in the meantime) gets a clean slate — inotify watches
  // are per-process, so a brand new FSWatcher is a fresh chance, not a
  // permanent scar on the row.
  setWatchStatus(db, libraryRootId, "watching", null);

  const watcher = watch(rootPath, {
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
    if (isWatchExhaustionError(err)) {
      fallBackToPolling(db, libraryRootId, rootPath, watchExhaustionReason(err));
    }
  });

  watcher.on("ready", () => checkWatchLimit(watcher, db, libraryRootId, rootPath, maxUserWatches));
  watcher.on("addDir", () => checkWatchLimit(watcher, db, libraryRootId, rootPath, maxUserWatches));

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
  const timer = fallbackTimers.get(libraryRootId);
  if (timer) {
    clearInterval(timer);
    fallbackTimers.delete(libraryRootId);
  }
}
