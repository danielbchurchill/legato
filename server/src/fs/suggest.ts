import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { parseFstabMountPoints } from "../scan/reachability.js";
import { isJunkName } from "../scan/junk.js";
import { isAudioFile } from "../scan/walk.js";
import { BrowseTimeout, isInContainer, shared, sharedInFlight, withDeadline } from "./browse.js";

// Issue #132: on first run, the folders that look like a music library,
// each with a count, before anyone is asked to find one by hand (H6). The
// server works them out because it's the server's disks that get scanned:
// the desktop app's embedded server and a headless one on a Pi answer the
// same route, and each looks at its own file system.
//
// Where it looks is 04-library-and-scan.md's list:
//   macOS    ~/Music/Music/Media (Apple Music), ~/Music/iTunes/iTunes Media, ~/Music
//   Windows  %USERPROFILE%\Music\iTunes\iTunes Media, %USERPROFILE%\Music
//   Linux    ~/Music, /mnt/*, /media/*/*
//   Docker   /music
// and only a folder with audio in it is offered.
//
// The count is quick on purpose. It stops at COUNT_CAP files ("1,000+")
// and at the request's deadline, so a 180,000-track NAS costs a hundred or
// so directory reads, not a walk of the whole share.

export type SuggestionKind = "apple-music" | "itunes" | "music" | "mount" | "container";

export type FolderSuggestion = {
  path: string;
  kind: SuggestionKind;
  // Audio files found, up to the cap.
  audioFiles: number;
  // false when the count stopped early, at the cap or the deadline, so
  // audioFiles is a floor: "1,000+", "412+".
  complete: boolean;
};

export type FolderSuggestions = {
  // The server's home directory, so a client can write ~ for it. null in
  // a container, where home is nothing anyone put music in.
  home: string | null;
  docker: boolean;
  suggestions: FolderSuggestion[];
};

export type SuggestDeps = {
  readdir?: (dir: string) => Promise<Dirent[]>;
  realpath?: (p: string) => Promise<string>;
  isDirectory?: (p: string) => Promise<boolean>;
  readFile?: (p: string) => Promise<string>;
  home?: string | null;
  platform?: NodeJS.Platform;
  docker?: boolean;
  env?: Record<string, string | undefined>;
  dataDir?: string;
  // Where Linux's removable drives and network shares hang, and Docker's
  // library mount. Tests point these at temp folders.
  mnt?: string;
  media?: string;
  music?: string;
  cap?: number;
  timeoutMs?: number;
  inFlight?: Map<string, Promise<unknown>>;
};

export const COUNT_CAP = 1_000;
// The whole request, every candidate counted at once. Shorter than the
// folder picker's 5s: this runs before anyone asked for anything, and a
// first-run screen with its own button doesn't need to wait on a slow
// share. A count that runs out of time is shown as a floor ("412+").
const SUGGEST_TIMEOUT_MS = 3_000;
// Directory reads in flight per candidate. Over NFS each is a round trip.
const COUNT_CONCURRENCY = 4;
// More than this and the list stops being a suggestion.
const MAX_SUGGESTIONS = 6;
// Packages that hold another app's library database (Music's own
// "Music Library.musiclibrary" sits in ~/Music/Music), never audio files.
// Skipping them saves the reads and keeps the count out of another app's
// data.
const PACKAGE_SUFFIXES = [".musiclibrary", ".tvlibrary", ".photoslibrary"];
// WSL's own plumbing under /mnt, not drives.
const MNT_SKIP = new Set(["wsl", "wslg"]);

function resolveDeps(deps: SuggestDeps) {
  const read = deps.readdir ?? ((dir: string) => readdir(dir, { withFileTypes: true }));
  const real = deps.realpath ?? ((p: string) => realpath(p));
  const isDir =
    deps.isDirectory ??
    (async (p: string) => {
      try {
        return (await stat(p)).isDirectory();
      } catch {
        return false;
      }
    });
  // The folder picker's sharing: a read that hung on a dead mount is
  // joined by the next request for the same path, not repeated beside it.
  const inFlight = deps.inFlight ?? sharedInFlight;
  return {
    readdir: (dir: string) => shared(inFlight, `readdir:${dir}`, () => read(dir)),
    realpath: (p: string) => shared(inFlight, `realpath:${p}`, () => real(p)),
    isDirectory: (p: string) => shared(inFlight, `isdir:${p}`, () => isDir(p)),
    readFile: deps.readFile ?? ((p: string) => readFile(p, "utf8")),
    home: deps.home === undefined ? homedir() : deps.home,
    platform: deps.platform ?? process.platform,
    docker: deps.docker ?? isInContainer(),
    env: deps.env ?? process.env,
    dataDir: path.resolve(deps.dataDir ?? DATA_DIR),
    mnt: deps.mnt ?? "/mnt",
    media: deps.media ?? "/media",
    music: deps.music ?? "/music",
    cap: deps.cap ?? COUNT_CAP,
    timeoutMs: deps.timeoutMs ?? SUGGEST_TIMEOUT_MS,
  };
}

type Resolved = ReturnType<typeof resolveDeps>;
type Candidate = { path: string; kind: SuggestionKind };

// XDG_MUSIC_DIR from user-dirs.dirs, which is how a Linux desktop names
// its music folder in another language (~/Musik, ~/Musique). The file is
// shell-ish: XDG_MUSIC_DIR="$HOME/Musik".
export function parseXdgMusicDir(contents: string, home: string): string | null {
  for (const line of contents.split("\n")) {
    const match = /^\s*XDG_MUSIC_DIR\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (!match) continue;
    const value = match[1]!.replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home);
    // "$HOME/" alone means the desktop has no music folder of its own.
    if (!path.isAbsolute(value) || path.resolve(value) === path.resolve(home)) return null;
    return path.resolve(value);
  }
  return null;
}

async function linuxMusicDir(d: Resolved, home: string, deadline: number): Promise<string | null> {
  const configHome = d.env.XDG_CONFIG_HOME || path.join(home, ".config");
  try {
    return parseXdgMusicDir(await withDeadline(d.readFile(path.join(configHome, "user-dirs.dirs")), deadline), home);
  } catch {
    return null;
  }
}

async function subfolders(d: Resolved, dir: string, deadline: number): Promise<string[]> {
  try {
    const entries = await withDeadline(d.readdir(dir), deadline);
    const folders: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) folders.push(child);
      else if (entry.isSymbolicLink() && (await withDeadline(d.isDirectory(child), deadline).catch(() => false))) {
        folders.push(child);
      }
    }
    return folders.sort();
  } catch {
    return [];
  }
}

// /mnt/* and /media/*/*: a drive or a share mounted by hand, by fstab or
// by systemd sits straight under /mnt; a desktop's automounter puts each
// drive under /media/<user>/. Some systems (usbmount, an fstab line) mount
// a drive straight under /media, so a folder there that's itself a mount
// point is the drive, not a user's folder of drives.
async function linuxMounts(d: Resolved, deadline: number): Promise<string[]> {
  let mountPoints = new Set<string>();
  try {
    mountPoints = new Set(parseFstabMountPoints(await withDeadline(d.readFile("/proc/mounts"), deadline)));
  } catch {
    // No /proc/mounts: every /media child is treated as a user's folder.
  }
  const found: string[] = [];
  for (const dir of await subfolders(d, d.mnt, deadline)) {
    if (!MNT_SKIP.has(path.basename(dir))) found.push(dir);
  }
  for (const dir of await subfolders(d, d.media, deadline)) {
    if (mountPoints.has(dir)) found.push(dir);
    else found.push(...(await subfolders(d, dir, deadline)));
  }
  return found;
}

async function candidates(d: Resolved, deadline: number): Promise<Candidate[]> {
  if (d.docker) return [{ path: d.music, kind: "container" }];
  const home = d.home;
  const list: Candidate[] = [];
  if (d.platform === "darwin") {
    if (home) {
      // On disk Music's folder is usually "Media.localized"; Finder hides
      // the suffix, which is why Apple's documentation says "Media". Both
      // names are looked for, and only one will be there.
      list.push({ path: path.join(home, "Music", "Music", "Media.localized"), kind: "apple-music" });
      list.push({ path: path.join(home, "Music", "Music", "Media"), kind: "apple-music" });
      list.push({ path: path.join(home, "Music", "iTunes", "iTunes Media"), kind: "itunes" });
      list.push({ path: path.join(home, "Music"), kind: "music" });
    }
  } else if (d.platform === "win32") {
    // homedir() is %USERPROFILE% on Windows.
    if (home) {
      list.push({ path: path.join(home, "Music", "iTunes", "iTunes Media"), kind: "itunes" });
      list.push({ path: path.join(home, "Music"), kind: "music" });
    }
  } else {
    if (home) {
      list.push({ path: path.join(home, "Music"), kind: "music" });
      const xdg = await linuxMusicDir(d, home, deadline);
      if (xdg) list.push({ path: xdg, kind: "music" });
    }
    if (d.platform === "linux") {
      for (const mount of await linuxMounts(d, deadline)) list.push({ path: mount, kind: "mount" });
    }
  }
  return list;
}

function isAtOrUnder(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

type Count = { audioFiles: number; complete: boolean };

// Audio files under `dir`, the way the scan would find them: dot entries
// and the shared junk list (scan/junk.ts) skipped, symlinks followed. Depth
// first, so a library laid out Artist/Album/track reaches its first tracks
// after three reads rather than after listing every artist, and the cap
// comes quickly. Every folder is remembered by its real path, so a symlink
// back up the tree is read once, not until the cap.
async function countAudioFiles(d: Resolved, dir: string, real: string, deadline: number): Promise<Count> {
  const visited = new Set<string>([real]);
  const stack: { path: string; real: string }[] = [{ path: dir, real }];
  let audioFiles = 0;
  let complete = true;
  let active = 0;
  let finished = false;

  return new Promise<Count>((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve({ audioFiles: Math.min(audioFiles, d.cap), complete });
    };

    const enter = (child: string, childReal: string, children: { path: string; real: string }[]) => {
      if (visited.has(childReal) || childReal === d.dataDir) return;
      visited.add(childReal);
      children.push({ path: child, real: childReal });
    };

    const readOne = async (folder: { path: string; real: string }) => {
      let entries: Dirent[];
      try {
        entries = await withDeadline(d.readdir(folder.path), deadline);
      } catch (err) {
        // Out of time: what's counted so far is a floor. Anything else
        // (permissions, a folder gone mid-walk) the scan couldn't read
        // either, so the count stays what a scan would find.
        if (err instanceof BrowseTimeout) complete = false;
        return;
      }
      const children: { path: string; real: string }[] = [];
      for (const entry of entries) {
        if (finished || audioFiles >= d.cap) return;
        const name = entry.name;
        if (name.startsWith(".") || isJunkName(name)) continue;
        const child = path.join(folder.path, name);
        if (entry.isDirectory()) {
          if (!PACKAGE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))) {
            enter(child, path.join(folder.real, name), children);
          }
        } else if (entry.isSymbolicLink()) {
          const target = await withDeadline(d.realpath(child), deadline).catch((err: unknown) => err);
          if (target instanceof BrowseTimeout) {
            complete = false;
            return;
          }
          if (typeof target !== "string") continue; // a broken link
          if (await withDeadline(d.isDirectory(target), deadline).catch(() => false)) enter(child, target, children);
          else if (isAudioFile(name)) audioFiles++;
        } else if (isAudioFile(name)) {
          audioFiles++;
        }
      }
      // Pushed in reverse, so the next pop is the first child by name.
      children.sort((a, b) => b.path.localeCompare(a.path));
      stack.push(...children);
    };

    const pump = () => {
      if (finished) return;
      if (audioFiles >= d.cap) {
        complete = false;
        return finish();
      }
      if (Date.now() >= deadline) {
        if (stack.length > 0 || active > 0) complete = false;
        return finish();
      }
      if (stack.length === 0 && active === 0) return finish();
      while (active < COUNT_CONCURRENCY && stack.length > 0) {
        const next = stack.pop()!;
        active++;
        void readOne(next).finally(() => {
          active--;
          pump();
        });
      }
    };
    pump();
  });
}

export async function suggestLibraryFolders(deps: SuggestDeps = {}): Promise<FolderSuggestions> {
  const d = resolveDeps(deps);
  const deadline = Date.now() + d.timeoutMs;
  // Compared with real paths below, so it's one too (on macOS, /var is
  // /private/var).
  d.dataDir = await withDeadline(d.realpath(d.dataDir), deadline).catch(() => d.dataDir);
  const listed = await candidates(d, deadline);

  // Each candidate once, by where it really is: a ~/Music that's a symlink
  // to /mnt/music is one library, offered under the first name it was
  // found by (the more specific one, in the lists above). The data dir and
  // anything inside it is Legato's own, never a library.
  const reals = await Promise.all(
    listed.map(async (candidate) => {
      if (!(await withDeadline(d.isDirectory(candidate.path), deadline).catch(() => false))) return null;
      return withDeadline(d.realpath(candidate.path), deadline).catch(() => null);
    }),
  );
  const seen = new Set<string>();
  const existing: (Candidate & { real: string })[] = [];
  listed.forEach((candidate, i) => {
    const real = reals[i];
    if (!real || seen.has(real) || isAtOrUnder(d.dataDir, real)) return;
    seen.add(real);
    existing.push({ ...candidate, real });
  });

  const counted = await Promise.all(
    existing.map(async (candidate): Promise<FolderSuggestion> => ({
      path: candidate.path,
      kind: candidate.kind,
      ...(await countAudioFiles(d, candidate.path, candidate.real, deadline)),
    })),
  );
  const withAudio = counted.filter((s) => s.audioFiles > 0);
  // The platform's own folders first, in the order listed above; then
  // drives, the fullest first.
  const own = withAudio.filter((s) => s.kind !== "mount");
  const drives = withAudio
    .filter((s) => s.kind === "mount")
    .sort((a, b) => b.audioFiles - a.audioFiles || a.path.localeCompare(b.path));

  return {
    home: d.docker ? null : d.home,
    docker: d.docker,
    suggestions: [...own, ...drives].slice(0, MAX_SUGGESTIONS),
  };
}
