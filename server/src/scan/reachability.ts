import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Database } from "../sqlite.js";
import { hasAnyAudioFile } from "./walk.js";

// Issue #192: a library root on a drive or NFS mount that isn't there
// looks, to the walker and to chokidar, exactly like a library whose every
// file was deleted — and both used to act on it that way, marking the
// whole library missing. This module answers the one question they need
// first: is the root actually reachable?
//
// State is in memory on purpose, not a library_roots column. It is a
// snapshot of the filesystem right now, not a fact about the library:
// every server start re-derives it (watchLibraryRoot seeds it at boot),
// and a stored value would only ever be a stale guess about a drive that
// may have come back while the server was down.

export type UnreachableReason = "missing" | "not_mounted" | "empty" | "timeout";

export type RootReachability = {
  libraryRootId: number;
  path: string;
  // null until the first check for this root finishes (boot seeding is
  // async), so a client can tell "not checked yet" from "checked, fine".
  reachable: boolean | null;
  reason: UnreachableReason | null;
  message: string | null;
  checkedAt: string | null;
};

export type ReachabilityResult =
  | { reachable: true }
  | { reachable: false; reason: UnreachableReason; message: string };

const state = new Map<number, RootReachability>();

// The deepest mount point at or above each root, as seen the last time
// the root checked out fine. "For a root configured as a mount point, it
// is still a mount point" needs to know which roots those are; fstab
// answers that for boot-time mounts on Linux, and this answers it for
// everything else (macOS volumes, manual mounts) once the root has been
// seen mounted at least once in this process's lifetime.
const learnedMountPoints = new Map<number, string>();

// A hard-mounted NFS share whose server has gone away doesn't fail a
// stat(), it blocks it. Past this, the root is treated as unreachable
// rather than letting a scan (or the watcher) wait on it forever.
const CHECK_TIMEOUT_MS = 10_000;

export type ReachabilityDeps = {
  // Seams for reachability.spec.ts — no test can mount or unmount a real
  // filesystem, but pointing fstab at a temp file lists a plain directory
  // as a configured mount point, which is exactly what an unmounted one
  // looks like.
  fstabPath?: string | null;
  timeoutMs?: number;
};

export function markRootPending(libraryRootId: number, rootPath: string): void {
  if (state.has(libraryRootId)) return;
  state.set(libraryRootId, {
    libraryRootId,
    path: rootPath,
    reachable: null,
    reason: null,
    message: null,
    checkedAt: null,
  });
}

export function recordReachability(libraryRootId: number, rootPath: string, result: ReachabilityResult): void {
  state.set(libraryRootId, {
    libraryRootId,
    path: rootPath,
    reachable: result.reachable,
    reason: result.reachable ? null : result.reason,
    message: result.reachable ? null : result.message,
    checkedAt: new Date().toISOString(),
  });
}

export function getRootReachability(libraryRootId: number): RootReachability | undefined {
  return state.get(libraryRootId);
}

export function listRootReachability(): RootReachability[] {
  return [...state.values()].sort((a, b) => a.libraryRootId - b.libraryRootId);
}

// A removed root shouldn't keep showing up in /health as disconnected.
export function forgetRoot(libraryRootId: number): void {
  state.delete(libraryRootId);
  learnedMountPoints.delete(libraryRootId);
}

// The H9 message itself: says what's wrong, where, and — the part a user
// actually needs — that nothing was lost because of it.
export function unreachableMessage(rootPath: string, detail: string): string {
  return `library drive at ${rootPath} isn't reachable; files weren't marked missing (${detail})`;
}

async function deviceOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).dev;
  } catch {
    return null;
  }
}

// The same test mountpoint(1) makes: a directory on a different device
// from its parent is where some filesystem is mounted. An unmounted
// mount point is just an empty directory on its parent's device.
async function isMountPoint(dir: string): Promise<boolean> {
  const parent = path.dirname(dir);
  if (parent === dir) return true; // the filesystem root
  const [own, parentDev] = await Promise.all([deviceOf(dir), deviceOf(parent)]);
  return own !== null && parentDev !== null && own !== parentDev;
}

async function deepestMountPoint(rootPath: string): Promise<string | null> {
  let dir = path.resolve(rootPath);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached "/" — every path is under that one
    if (await isMountPoint(dir)) return dir;
    dir = parent;
  }
}

function isAtOrAbove(candidate: string, rootPath: string): boolean {
  const rel = path.relative(candidate, rootPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// fstab's second field, with its octal escapes (\040 for a space) undone.
// "/" is skipped because it can't be unmounted out from under a running
// server, and swap/none aren't directories at all.
export function parseFstabMountPoints(contents: string): string[] {
  const points: string[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(/\s+/);
    const target = fields[1];
    if (!target || !target.startsWith("/") || target === "/") continue;
    points.push(target.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))));
  }
  return points;
}

async function configuredMountPoints(rootPath: string, fstabPath: string | null): Promise<string[]> {
  if (!fstabPath) return [];
  try {
    const contents = await readFile(fstabPath, "utf8");
    return parseFstabMountPoints(contents).filter((point) => isAtOrAbove(point, rootPath));
  } catch {
    return []; // no fstab (Windows, most Macs, Docker) is the normal case
  }
}

function countLiveFiles(db: Database, libraryRootId: number): number {
  const row = db
    .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM files WHERE library_root_id = ? AND missing_since IS NULL")
    .get(libraryRootId) as { n: number };
  return row.n;
}

export type CheckOptions = {
  // How many audio files a walk of the root just found, when the caller
  // already walked it (the scanner). Omitted, the check looks for one
  // itself. Either way "empty" only counts as unreachable when the DB
  // still has live files under the root — a brand-new, genuinely empty
  // library is fine.
  audioFilesFound?: number;
  // The scanner's pre-walk check has nothing to compare yet and must not
  // do its own walk first; it only wants the cheap stat-level checks.
  skipEmptyCheck?: boolean;
};

async function runCheck(
  db: Database,
  libraryRootId: number,
  rootPath: string,
  options: CheckOptions,
  fstabPath: string | null,
): Promise<ReachabilityResult> {
  let rootStat;
  try {
    rootStat = await stat(rootPath);
  } catch {
    return { reachable: false, reason: "missing", message: unreachableMessage(rootPath, "the folder doesn't exist") };
  }
  if (!rootStat.isDirectory()) {
    return { reachable: false, reason: "missing", message: unreachableMessage(rootPath, "it isn't a folder") };
  }

  const learned = learnedMountPoints.get(libraryRootId);
  const expected = new Set(await configuredMountPoints(rootPath, fstabPath));
  if (learned) expected.add(learned);
  for (const point of expected) {
    if (!(await isMountPoint(point))) {
      return {
        reachable: false,
        reason: "not_mounted",
        message: unreachableMessage(rootPath, `${point} isn't mounted`),
      };
    }
  }

  if (!options.skipEmptyCheck) {
    const live = countLiveFiles(db, libraryRootId);
    if (live > 0) {
      const found = options.audioFilesFound ?? ((await hasAnyAudioFile(rootPath)) ? 1 : 0);
      if (found === 0) {
        return {
          reachable: false,
          reason: "empty",
          message: unreachableMessage(rootPath, `the folder is empty, but ${live} indexed files live there`),
        };
      }
    }
  }

  const mountPoint = await deepestMountPoint(rootPath);
  if (mountPoint) learnedMountPoints.set(libraryRootId, mountPoint);
  return { reachable: true };
}

// Runs every check the issue lists — the root exists and is a folder,
// every mount point it depends on is still mounted, and it isn't empty
// while the DB says music lives there — and records the outcome, so
// /health reports whatever the most recent scan or watcher event saw.
export async function checkLibraryRoot(
  db: Database,
  libraryRootId: number,
  rootPath: string,
  options: CheckOptions = {},
  deps: ReachabilityDeps = {},
): Promise<ReachabilityResult> {
  const fstabPath = deps.fstabPath === undefined ? (process.platform === "win32" ? null : "/etc/fstab") : deps.fstabPath;
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReachabilityResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          reachable: false,
          reason: "timeout",
          message: unreachableMessage(rootPath, `it didn't answer within ${Math.round(timeoutMs / 1000)}s`),
        }),
      timeoutMs,
    );
    timer.unref?.();
  });

  const result = await Promise.race([runCheck(db, libraryRootId, rootPath, options, fstabPath), timeout]);
  clearTimeout(timer);
  recordReachability(libraryRootId, rootPath, result);
  return result;
}
