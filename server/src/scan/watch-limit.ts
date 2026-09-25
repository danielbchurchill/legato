import { readFileSync } from "node:fs";

// Pure detection logic for issue #122, split out of watcher.ts so the
// "is this a watch-exhaustion problem" question can be unit tested without
// a real chokidar instance or a real inotify limit — this Mac has no
// inotify at all, so every test here injects the failure instead of
// exhausting real watches (see watcher.spec.ts for the chokidar-level
// tests that build on top of these).

// Mirrors library_roots.watch_fallback_reason's CHECK constraint
// (migrations/0026_watch_status.sql) — one enum, one source of truth for
// what a fallback can be attributed to.
export type WatchFallbackReason = "enospc" | "emfile" | "near_limit";

const WATCH_EXHAUSTION_CODES = new Set(["ENOSPC", "EMFILE"]);

// chokidar's FSWatcher re-emits the raw fs error as a plain EventEmitter
// 'error' event. ENOSPC is what inotify_add_watch returns on Linux once
// fs.inotify.max_user_watches is exhausted (a name inherited from disk
// space errors, not what's actually out); EMFILE is the same exhaustion
// one layer up, the process' open-file-descriptor limit. Both mean "no
// watch capacity left," never "this one path is broken" — see
// docs/plans/04-library-and-scan.md#file-watch-limit-fallback.
export function isWatchExhaustionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code: unknown }).code;
  return typeof code === "string" && WATCH_EXHAUSTION_CODES.has(code);
}

export function watchExhaustionReason(err: unknown): WatchFallbackReason {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EMFILE" ? "emfile" : "enospc";
}

const MAX_USER_WATCHES_PATH = "/proc/sys/fs/inotify/max_user_watches";

// Linux-only by nature (macOS's FSEvents and Windows' ReadDirectoryChangesW
// have no per-user watch cap to read). readFile is injectable so tests can
// simulate a low limit without needing to actually be on Linux, or a
// missing/unreadable /proc without needing to run as a different user.
export function readMaxUserWatches(
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): number | null {
  try {
    const raw = readFile(MAX_USER_WATCHES_PATH);
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null; // not Linux, or /proc isn't mounted (some containers hide it)
  }
}

// How close to the limit counts as "close enough to act before it breaks."
// Conservative on purpose: waiting for the actual ENOSPC means whatever
// directory triggered it never got watched at all, with no record of which
// one — falling back a little early costs nothing (the periodic rescan
// covers exactly the same ground a live watch would) and never loses a
// directory silently.
const NEAR_LIMIT_RATIO = 0.9;

export function isNearWatchLimit(watchedDirCount: number, maxUserWatches: number | null): boolean {
  if (maxUserWatches === null) return false;
  return watchedDirCount >= maxUserWatches * NEAR_LIMIT_RATIO;
}
