import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { parseFstabMountPoints } from "../scan/reachability.js";
import { isAudioFile } from "../scan/walk.js";

// Issue #121: the folder picker for a server that isn't on the machine
// running the UI. Tauri's native dialog can only show the client's own
// disks, which is the wrong machine whenever the server is a Pi or a NAS.
//
// Browsing starts from a short list of roots (mount points, home, /music
// in Docker) and never leaves them. /proc and /sys aren't blocked by name;
// they just aren't roots and aren't under one, so there's no way to walk
// into them.

export type BrowseRoot = { path: string; kind: "home" | "mount" | "music" };

export type BrowseEntry = {
  name: string;
  path: string;
  // Shallow: audio files directly inside this folder or one level below
  // it, and folders directly inside it. null when the folder couldn't be
  // read in time.
  audioFiles: number | null;
  folders: number | null;
};

export type BrowseListing = {
  // null for the list of roots itself.
  path: string | null;
  // null at a root (and at the root list): "up" from a root goes back to
  // the root list, not to its real parent.
  parent: string | null;
  docker: boolean;
  audioFiles: number | null;
  entries: BrowseEntry[];
};

export type BrowseError = { status: 400 | 403 | 404 | 504; error: string; reason: string };

export type BrowseDeps = {
  // Seams for browse.spec.ts. A test can't unplug an NFS server, but a
  // readdir that never resolves looks exactly like one that's gone away.
  readdir?: (dir: string) => Promise<Dirent[]>;
  isDirectory?: (p: string) => Promise<boolean>;
  readFile?: (p: string) => Promise<string>;
  home?: string | null;
  platform?: NodeJS.Platform;
  docker?: boolean;
  dataDir?: string;
  // How long one request may wait on the filesystem, start to finish.
  timeoutMs?: number;
  // Each test gets its own, so one test's hung fake read isn't shared
  // into the next.
  inFlight?: Map<string, Promise<unknown>>;
};

// Shorter than reachability.ts's 10s on purpose: that one gates a scan
// nobody is watching, this one has someone looking at a spinner.
const BROWSE_TIMEOUT_MS = 5_000;
// Child folders read at once while counting. An artist folder can hold a
// few thousand albums, and over NFS each readdir is a round trip.
const COUNT_CONCURRENCY = 8;

// Mount points that are never somebody's music: kernel and runtime
// filesystems, boot partitions, snap squashfs images, and the files Docker
// bind-mounts into every container (/etc/hosts and friends).
const SYSTEM_MOUNT_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/boot",
  "/snap",
  "/tmp",
  "/etc",
  "/var/lib/docker",
  "/var/lib/containers",
];

class BrowseTimeout extends Error {}

function isAtOrAbove(candidate: string, target: string): boolean {
  const rel = path.relative(candidate, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// The same race reachability.ts's checkLibraryRoot runs: a hard-mounted
// NFS share whose server has gone doesn't fail a readdir, it blocks it, so
// the request gives up rather than waiting with it. The blocked read itself
// can't be cancelled; see shared() below for what keeps that bounded.
async function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowseTimeout()), Math.max(0, deadline - Date.now()));
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// A read that hung keeps a filesystem thread blocked until the mount comes
// back, and nothing can take it back. Without this, every retry of the same
// dead folder (the picker's "try again", a second tab) would block one
// more. Requests for a path that's still being read share the read already
// waiting instead of starting another.
const sharedInFlight = new Map<string, Promise<unknown>>();

function shared<T>(inFlight: Map<string, Promise<unknown>>, key: string, start: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const work = start().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

function resolveDeps(deps: BrowseDeps) {
  const read = deps.readdir ?? ((dir: string) => readdir(dir, { withFileTypes: true }));
  const isDir =
    deps.isDirectory ??
    (async (p: string) => {
      try {
        return (await stat(p)).isDirectory();
      } catch {
        return false;
      }
    });
  const inFlight = deps.inFlight ?? sharedInFlight;
  return {
    readdir: (dir: string) => shared(inFlight, `readdir:${dir}`, () => read(dir)),
    isDirectory: (p: string) => shared(inFlight, `isdir:${p}`, () => isDir(p)),
    readFile: deps.readFile ?? ((p: string) => readFile(p, "utf8")),
    home: deps.home === undefined ? homedir() : deps.home,
    platform: deps.platform ?? process.platform,
    docker: deps.docker ?? isInContainer(),
    dataDir: path.resolve(deps.dataDir ?? DATA_DIR),
    timeoutMs: deps.timeoutMs ?? BROWSE_TIMEOUT_MS,
  };
}

type Resolved = ReturnType<typeof resolveDeps>;

// Docker writes /.dockerenv into every container, Podman /run/.containerenv.
export function isInContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

async function mountPoints(d: Resolved, deadline: number): Promise<string[]> {
  if (d.platform === "linux") {
    // /proc/mounts is fstab's format, so reachability.ts's parser reads it
    // as is. It lists what's mounted right now, which is what's browsable;
    // an fstab entry that isn't mounted would only be an empty folder.
    try {
      const mounts = await withDeadline(d.readFile("/proc/mounts"), deadline);
      return parseFstabMountPoints(mounts).filter(
        (point) =>
          !SYSTEM_MOUNT_PREFIXES.some((prefix) => isAtOrAbove(prefix, point)) && !isAtOrAbove(d.dataDir, point),
      );
    } catch {
      return [];
    }
  }
  if (d.platform === "darwin") {
    // "Macintosh HD" in /Volumes is a symlink back to /, so only real
    // directories count: external drives, mounted shares.
    try {
      const entries = await withDeadline(d.readdir("/Volumes"), deadline);
      return entries.filter((e) => e.isDirectory()).map((e) => path.join("/Volumes", e.name));
    } catch {
      return [];
    }
  }
  if (d.platform === "win32") {
    const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`);
    const present = await Promise.all(
      letters.map((drive) => withDeadline(d.isDirectory(drive), deadline).catch(() => false)),
    );
    return letters.filter((_, i) => present[i]);
  }
  return [];
}

export async function browseRoots(deps: BrowseDeps = {}): Promise<BrowseRoot[]> {
  const d = resolveDeps(deps);
  return rootsFor(d, Date.now() + d.timeoutMs);
}

async function rootsFor(d: Resolved, deadline: number): Promise<BrowseRoot[]> {
  const roots: BrowseRoot[] = [];
  const seen = new Set<string>();
  const add = (p: string, kind: BrowseRoot["kind"]) => {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push({ path: resolved, kind });
  };

  if (d.docker) {
    // The compose file mounts the library here (docs/install/docker.md).
    // A container's home directory is nothing anyone put music in.
    if (await withDeadline(d.isDirectory("/music"), deadline).catch(() => false)) add("/music", "music");
  } else if (d.home) {
    add(d.home, "home");
  }
  for (const point of await mountPoints(d, deadline)) add(point, "mount");
  return roots;
}

function sortByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

type Counts = { audioFiles: number | null; folders: number | null; direct: number | null };

function tally(entries: Dirent[]): { audioFiles: number; subfolders: string[] } {
  let audioFiles = 0;
  const subfolders: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) subfolders.push(entry.name);
    else if (isAudioFile(entry.name)) audioFiles++;
  }
  return { audioFiles, subfolders };
}

// Issue #121's shallow count: audio files
// at this folder's top level plus those in its first level of subfolders.
// One level alone would show an artist folder as "3 folders" when it holds
// 36 tracks across three albums; two levels is what makes it read "36 audio
// files". Symlinks aren't followed at the second level, to keep a folder
// that links back to its parent from multiplying the work.
async function countChildren(d: Resolved, dir: string, deadline: number): Promise<Counts> {
  try {
    const top = tally(await withDeadline(d.readdir(dir), deadline));
    let audioFiles = top.audioFiles;
    for (const name of top.subfolders) {
      try {
        audioFiles += tally(await withDeadline(d.readdir(path.join(dir, name)), deadline)).audioFiles;
      } catch (err) {
        // One unreadable subfolder (permissions) shouldn't blank out the
        // count for its siblings; a timeout means the whole count is unknown.
        if (err instanceof BrowseTimeout) throw err;
      }
    }
    return { audioFiles, folders: top.subfolders.length, direct: top.audioFiles };
  } catch {
    // Timed out, or unreadable (permissions, a broken symlink). The folder
    // is still listed; it just can't say what's in it.
    return { audioFiles: null, folders: null, direct: null };
  }
}

async function withCounts(
  d: Resolved,
  folders: { name: string; path: string }[],
  deadline: number,
): Promise<{ entries: BrowseEntry[]; directAudioFiles: number }> {
  const results: BrowseEntry[] = new Array(folders.length);
  let directAudioFiles = 0;
  let next = 0;
  const worker = async () => {
    while (next < folders.length) {
      const i = next++;
      const folder = folders[i]!;
      const { direct, ...counts } = await countChildren(d, folder.path, deadline);
      directAudioFiles += direct ?? 0;
      results[i] = { ...folder, ...counts };
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, folders.length) }, worker));
  return { entries: results, directAudioFiles };
}

function readError(err: unknown, dir: string, timeoutMs: number): BrowseError {
  if (err instanceof BrowseTimeout) {
    return {
      status: 504,
      reason: "timeout",
      error: `${dir} didn't answer within ${Math.round(timeoutMs / 1000)}s. If it's a network share or a USB drive, check that it's still connected.`,
    };
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { status: 404, reason: "missing", error: `${dir} doesn't exist on the server.` };
  if (code === "ENOTDIR") return { status: 400, reason: "not_directory", error: `${dir} isn't a folder.` };
  if (code === "EACCES" || code === "EPERM") {
    return { status: 403, reason: "permission", error: `The server's user can't read ${dir}.` };
  }
  return { status: 404, reason: "unreadable", error: `${dir} couldn't be read (${code ?? String(err)}).` };
}

export async function browse(
  requested: string | undefined,
  deps: BrowseDeps = {},
): Promise<BrowseListing | BrowseError> {
  const d = resolveDeps(deps);
  const deadline = Date.now() + d.timeoutMs;
  const roots = await rootsFor(d, deadline);

  if (requested === undefined || requested === "") {
    const { entries } = await withCounts(
      d,
      roots.map((root) => ({ name: root.path, path: root.path })),
      deadline,
    );
    return { path: null, parent: null, docker: d.docker, audioFiles: null, entries };
  }

  if (requested.includes("\0") || !path.isAbsolute(requested)) {
    return { status: 400, reason: "invalid_path", error: "path must be an absolute path on the server." };
  }
  // resolve() collapses every ".." before the containment check, so
  // /home/daniel/../../etc is judged as /etc, not as something under home.
  // Symlinks inside a root are followed: the owner made them, and a
  // ~/Music pointing at another disk is the usual reason one exists.
  const dir = path.resolve(requested);
  const root = roots.find((r) => isAtOrAbove(r.path, dir));
  if (!root) {
    return {
      status: 403,
      reason: "outside_roots",
      error: `${dir} isn't under any folder this server offers for browsing.`,
    };
  }

  let entries: Dirent[];
  try {
    entries = await withDeadline(d.readdir(dir), deadline);
  } catch (err) {
    return readError(err, dir, d.timeoutMs);
  }

  const folders: { name: string; path: string }[] = [];
  let audioFiles = 0;
  for (const entry of entries) {
    // Dot-folders are config and caches (~/.cache, ~/.local), never a
    // library, and a home directory has dozens of them.
    if (entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      folders.push({ name: entry.name, path: child });
    } else if (entry.isSymbolicLink()) {
      const target = await withDeadline(d.isDirectory(child), deadline).catch(() => false);
      if (target) folders.push({ name: entry.name, path: child });
    } else if (isAudioFile(entry.name)) {
      audioFiles++;
    }
  }
  folders.sort(sortByName);
  const counted = await withCounts(d, folders, deadline);

  return {
    path: dir,
    parent: dir === root.path ? null : path.dirname(dir),
    docker: d.docker,
    // Same two levels as each entry's count. A subfolder that didn't
    // answer adds nothing, so this is a floor rather than a guess.
    audioFiles: audioFiles + counted.directAudioFiles,
    entries: counted.entries,
  };
}

export function isBrowseError(result: BrowseListing | BrowseError): result is BrowseError {
  return "status" in result;
}
