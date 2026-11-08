import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Dirent } from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COUNT_CAP, parseXdgMusicDir, suggestLibraryFolders, type SuggestDeps } from "./suggest.js";

// Every candidate here is a real temp folder: a fake home, a fake /mnt and
// /media, a fake /music. Nothing reads this machine's own Music folder or
// its drives.
//
// Not under os.tmpdir(): on Linux that's /tmp, the same reason
// browse.spec.ts gives. /var/tmp is disk-backed on Linux and macOS.
const TEST_TMP = process.platform === "win32" ? tmpdir() : "/var/tmp";

let base: string;
let home: string;
let mnt: string;
let media: string;
let music: string;
let dataDir: string;

function touch(...parts: string[]) {
  const file = path.join(...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
}

function deps(extra: Partial<SuggestDeps> = {}): SuggestDeps {
  return {
    home,
    platform: "linux",
    docker: false,
    env: {},
    dataDir,
    mnt,
    media,
    music,
    readFile: async (p) => {
      if (p === "/proc/mounts") return `/dev/sdc1 ${path.join(media, "usb0")} vfat rw 0 0\n`;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    inFlight: new Map(),
    ...extra,
  };
}

const summary = (result: Awaited<ReturnType<typeof suggestLibraryFolders>>) =>
  result.suggestions.map((s) => ({ path: s.path, kind: s.kind, audioFiles: s.audioFiles, complete: s.complete }));

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(TEST_TMP, "legato-suggest-")));
  home = path.join(base, "home");
  mnt = path.join(base, "mnt");
  media = path.join(base, "media");
  music = path.join(base, "music");
  dataDir = path.join(base, "data");
  for (const dir of [home, mnt, media, music, dataDir]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("suggestLibraryFolders — macOS", () => {
  it("offers Apple Music's and iTunes' media folders, then ~/Music, each with its count", async () => {
    touch(home, "Music", "Music", "Media.localized", "Music", "Artist", "Album", "01 Song.m4a");
    touch(home, "Music", "Music", "Media.localized", "Music", "Artist", "Album", "02 Song.m4a");
    touch(home, "Music", "iTunes", "iTunes Media", "Music", "Other", "Album", "01.mp3");
    touch(home, "Music", "Rips", "a.flac");
    const result = await suggestLibraryFolders(deps({ platform: "darwin" }));
    expect(summary(result)).toEqual([
      {
        path: path.join(home, "Music", "Music", "Media.localized"),
        kind: "apple-music",
        audioFiles: 2,
        complete: true,
      },
      { path: path.join(home, "Music", "iTunes", "iTunes Media"), kind: "itunes", audioFiles: 1, complete: true },
      { path: path.join(home, "Music"), kind: "music", audioFiles: 4, complete: true },
    ]);
    expect(result.home).toBe(home);
  });

  it("takes a media folder Music named without the .localized suffix", async () => {
    touch(home, "Music", "Music", "Media", "Music", "x.m4a");
    const result = await suggestLibraryFolders(deps({ platform: "darwin" }));
    expect(summary(result).map((s) => [s.path, s.kind])).toEqual([
      [path.join(home, "Music", "Music", "Media"), "apple-music"],
      [path.join(home, "Music"), "music"],
    ]);
  });

  it("doesn't read inside Music's library database, and never offers a folder with no audio", async () => {
    // The package holds Music's database, not tracks; an audio file in it
    // here only proves the count never went in.
    touch(home, "Music", "Music", "Music Library.musiclibrary", "Library.musicdb");
    touch(home, "Music", "Music", "Music Library.musiclibrary", "decoy.m4a");
    touch(home, "Music", "cover.jpg");
    const result = await suggestLibraryFolders(deps({ platform: "darwin" }));
    expect(result.suggestions).toEqual([]);
  });

  it("never looks at drives on a Mac: /Volumes isn't on the list", async () => {
    // mnt and media are set, but they're Linux's places.
    touch(mnt, "music", "a.flac");
    expect((await suggestLibraryFolders(deps({ platform: "darwin" }))).suggestions).toEqual([]);
  });
});

describe("suggestLibraryFolders — Windows", () => {
  it("offers the iTunes Media folder, then Music, from the user's profile", async () => {
    touch(home, "Music", "iTunes", "iTunes Media", "Music", "A", "B", "01.m4a");
    touch(home, "Music", "Ripped", "01.flac");
    const result = await suggestLibraryFolders(deps({ platform: "win32" }));
    expect(summary(result)).toEqual([
      { path: path.join(home, "Music", "iTunes", "iTunes Media"), kind: "itunes", audioFiles: 1, complete: true },
      { path: path.join(home, "Music"), kind: "music", audioFiles: 2, complete: true },
    ]);
  });
});

describe("suggestLibraryFolders — Linux", () => {
  it("offers ~/Music, the desktop's own music folder, then drives under /mnt and /media, fullest first", async () => {
    touch(home, "Music", "a.flac");
    touch(home, "Musik", "Album", "01.mp3");
    touch(mnt, "music", "Artist", "Album", "01.flac");
    touch(mnt, "music", "Artist", "Album", "02.flac");
    touch(mnt, "music", "Artist", "Album", "03.flac");
    mkdirSync(path.join(mnt, "empty"));
    touch(mnt, "wsl", "x.flac");
    touch(media, "alex", "Backup", "Albums", "01.ogg");
    touch(media, "alex", "Backup", "Albums", "02.ogg");
    // A drive mounted straight under /media (/proc/mounts says so): it's
    // the drive itself, not a user's folder of drives, so its albums
    // aren't offered one by one.
    touch(media, "usb0", "Album One", "01.wav");
    touch(media, "usb0", "Album Two", "01.wav");
    touch(media, "usb0", "Album Two", "02.wav");
    touch(media, "usb0", "Album Two", "03.wav");
    touch(media, "usb0", "Album Two", "04.wav");

    const realReadFile = deps().readFile!;
    const result = await suggestLibraryFolders(
      deps({
        readFile: async (p) => {
          if (p === path.join(home, ".config", "user-dirs.dirs")) {
            return 'XDG_DESKTOP_DIR="$HOME/Schreibtisch"\nXDG_MUSIC_DIR="$HOME/Musik"\n';
          }
          return realReadFile(p);
        },
      }),
    );
    expect(summary(result)).toEqual([
      { path: path.join(home, "Music"), kind: "music", audioFiles: 1, complete: true },
      { path: path.join(home, "Musik"), kind: "music", audioFiles: 1, complete: true },
      { path: path.join(media, "usb0"), kind: "mount", audioFiles: 5, complete: true },
      { path: path.join(mnt, "music"), kind: "mount", audioFiles: 3, complete: true },
      { path: path.join(media, "alex", "Backup"), kind: "mount", audioFiles: 2, complete: true },
    ]);
  });

  it("reads XDG_CONFIG_HOME's user-dirs.dirs when it's set", async () => {
    touch(home, "Musique", "01.flac");
    const config = path.join(base, "config");
    const result = await suggestLibraryFolders(
      deps({
        env: { XDG_CONFIG_HOME: config },
        readFile: async (p) => {
          if (p === path.join(config, "user-dirs.dirs")) return 'XDG_MUSIC_DIR="$HOME/Musique"';
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    );
    expect(summary(result).map((s) => s.path)).toEqual([path.join(home, "Musique")]);
  });

  it("offers one library once, under its first name, when a folder is a symlink to another", async () => {
    touch(mnt, "music", "a.flac");
    symlinkSync(path.join(mnt, "music"), path.join(home, "Music"));
    const result = await suggestLibraryFolders(deps());
    expect(summary(result)).toEqual([{ path: path.join(home, "Music"), kind: "music", audioFiles: 1, complete: true }]);
  });

  it("leaves out Legato's own data dir, and never counts what's inside it", async () => {
    // A transcode cache is audio files too.
    const data = path.join(mnt, "ssd", "legato");
    touch(data, "streams", "opus", "ab", "x.ogg");
    touch(mnt, "ssd", "Music", "a.flac");
    const result = await suggestLibraryFolders(deps({ dataDir: data }));
    expect(summary(result)).toEqual([{ path: path.join(mnt, "ssd"), kind: "mount", audioFiles: 1, complete: true }]);

    // A data dir that's a drive of its own isn't offered as one.
    touch(mnt, "legato-data", "streams", "y.ogg");
    const second = await suggestLibraryFolders(deps({ dataDir: path.join(mnt, "legato-data") }));
    expect(summary(second).map((s) => s.path)).toEqual([path.join(mnt, "ssd")]);
  });

  it("offers at most six", async () => {
    for (let i = 0; i < 9; i++) touch(mnt, `drive${i}`, "a.flac");
    expect((await suggestLibraryFolders(deps())).suggestions).toHaveLength(6);
  });
});

describe("suggestLibraryFolders — Docker", () => {
  it("offers /music and nothing else, home included", async () => {
    touch(music, "Artist", "Album", "01.flac");
    touch(home, "Music", "a.flac");
    touch(mnt, "music", "a.flac");
    const result = await suggestLibraryFolders(deps({ docker: true }));
    expect(summary(result)).toEqual([{ path: music, kind: "container", audioFiles: 1, complete: true }]);
    expect(result.home).toBeNull();
    expect(result.docker).toBe(true);
  });

  it("offers nothing when the compose file mounted no music", async () => {
    rmSync(music, { recursive: true });
    expect((await suggestLibraryFolders(deps({ docker: true }))).suggestions).toEqual([]);
  });
});

describe("the count", () => {
  it(`stops at ${COUNT_CAP.toLocaleString("en")} files and says it stopped`, async () => {
    for (let i = 0; i < COUNT_CAP + 5; i++) touch(home, "Music", `Album ${Math.floor(i / 12)}`, `${i}.flac`);
    const [only] = (await suggestLibraryFolders(deps())).suggestions;
    expect(only).toEqual({ path: path.join(home, "Music"), kind: "music", audioFiles: COUNT_CAP, complete: false });
  });

  it("reads only as far as the cap needs, not the whole tree", async () => {
    for (let a = 0; a < 40; a++) for (let t = 0; t < 10; t++) touch(home, "Music", `Artist ${a}`, "Album", `${t}.flac`);
    let reads = 0;
    const result = await suggestLibraryFolders(
      deps({
        cap: 25,
        readdir: async (dir) => {
          reads++;
          return readdirSync(dir, { withFileTypes: true }) as Dirent[];
        },
      }),
    );
    expect(summary(result)[0]).toMatchObject({ audioFiles: 25, complete: false });
    // Three albums' worth and the folders above them, give or take the
    // reads already in flight when the cap came; the walk to all 40
    // artists would be over 80.
    expect(reads).toBeLessThan(25);
  });

  it("counts what the scan would: no hidden folders, NAS junk or AppleDouble files", async () => {
    touch(home, "Music", "Album", "01.flac");
    touch(home, "Music", "Album", "._01.flac");
    touch(home, "Music", "Album", "@eaDir", "01.flac");
    touch(home, "Music", "#recycle", "old.mp3");
    touch(home, "Music", ".hidden", "x.flac");
    touch(home, "Music", "Album", "notes.txt");
    touch(home, "Music", "Album", "02.FLAC");
    const [only] = (await suggestLibraryFolders(deps())).suggestions;
    expect(only).toMatchObject({ audioFiles: 2, complete: true });
  });

  it("follows a symlink once, and a loop back up the tree doesn't inflate the count", async () => {
    touch(home, "Music", "Album", "01.flac");
    touch(base, "elsewhere", "Live", "01.flac");
    symlinkSync(path.join(base, "elsewhere"), path.join(home, "Music", "Elsewhere"));
    symlinkSync(path.join(home, "Music"), path.join(home, "Music", "Album", "loop"));
    symlinkSync(path.join(base, "missing"), path.join(home, "Music", "broken"));
    const [only] = (await suggestLibraryFolders(deps())).suggestions;
    expect(only).toMatchObject({ audioFiles: 2, complete: true });
  });

  it("gives up on a folder that doesn't answer in time, and keeps what it counted", async () => {
    touch(home, "Music", "A", "01.flac");
    touch(home, "Music", "A", "02.flac");
    touch(home, "Music", "B", "01.flac");
    const hung = path.join(home, "Music", "B");
    const started = Date.now();
    const result = await suggestLibraryFolders(
      deps({
        timeoutMs: 150,
        readdir: (dir) =>
          dir === hung
            ? new Promise<Dirent[]>(() => {})
            : Promise.resolve(readdirSync(dir, { withFileTypes: true }) as Dirent[]),
      }),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(summary(result)).toEqual([
      { path: path.join(home, "Music"), kind: "music", audioFiles: 2, complete: false },
    ]);
  });

  it("leaves out a share that doesn't answer at all, without holding up the rest", async () => {
    touch(home, "Music", "a.flac");
    touch(mnt, "nas", "a.flac");
    const dead = path.join(mnt, "nas");
    const result = await suggestLibraryFolders(
      deps({
        timeoutMs: 150,
        readdir: (dir) =>
          dir === dead
            ? new Promise<Dirent[]>(() => {})
            : Promise.resolve(readdirSync(dir, { withFileTypes: true }) as Dirent[]),
      }),
    );
    expect(summary(result)).toEqual([{ path: path.join(home, "Music"), kind: "music", audioFiles: 1, complete: true }]);
  });
});

describe("parseXdgMusicDir", () => {
  it("expands $HOME and ${HOME}", () => {
    expect(parseXdgMusicDir('XDG_MUSIC_DIR="$HOME/Musik"', "/home/alex")).toBe("/home/alex/Musik");
    expect(parseXdgMusicDir('XDG_MUSIC_DIR="${HOME}/Música"', "/home/alex")).toBe("/home/alex/Música");
  });

  it("takes an absolute path as it is", () => {
    expect(parseXdgMusicDir('XDG_MUSIC_DIR="/srv/music"', "/home/alex")).toBe("/srv/music");
  });

  it("reads a home-only entry as no music folder at all", () => {
    expect(parseXdgMusicDir('XDG_MUSIC_DIR="$HOME/"', "/home/alex")).toBeNull();
    expect(parseXdgMusicDir("# nothing here", "/home/alex")).toBeNull();
  });
});
