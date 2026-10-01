import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { installAuthGate } from "../auth/gate.js";
import { createOwnerForTest } from "../auth/test-app.js";
import { createSession } from "../auth/sessions.js";
import type { BrowseDeps } from "../fs/browse.js";
import { authRoutes } from "./auth.js";
import { fsBrowseRoutes } from "./fs-browse.js";

// A home directory and one "mounted drive", both real temp folders, so
// the counts below are real readdirs rather than a fake's say-so.
//
//   home/
//     Music/            3 audio files, 1 cover, 1 folder (Live)
//       Live/           1 audio file
//         Encore/       1 audio file (two levels down from Music)
//     Documents/        empty
//     .cache/           hidden
//     notes.flac        an audio file directly in home
//     link-to-drive ->  drive/   (symlinked folder)
//   drive/
//     Albums/           2 audio files
//   outside/            not a root, not under one
let base: string;
let home: string;
let drive: string;
let outside: string;
let db: Database;
let app: FastifyInstance;
let token: string;

function linuxDeps(extra: Partial<BrowseDeps> = {}): BrowseDeps {
  return {
    home,
    platform: "linux",
    docker: false,
    dataDir: path.join(base, "data"),
    readFile: async () =>
      [
        "proc /proc proc rw 0 0",
        "sysfs /sys sysfs rw 0 0",
        "/dev/sda1 / ext4 rw 0 0",
        "tmpfs /run/user/1000 tmpfs rw 0 0",
        `/dev/sdb1 ${drive} ext4 rw 0 0`,
        `/dev/sdc1 ${path.join(base, "data")} ext4 rw 0 0`,
      ].join("\n"),
    inFlight: new Map(),
    ...extra,
  };
}

async function buildApp(deps: BrowseDeps): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  installAuthGate(instance, db);
  await instance.register(authRoutes(db), { prefix: "/api/v1" });
  await instance.register(fsBrowseRoutes(deps), { prefix: "/api/v1" });
  await instance.ready();
  return instance;
}

function get(url: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) {
  return app.inject({ method: "GET", url, headers });
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "legato-browse-"));
  home = path.join(base, "home");
  drive = path.join(base, "drive");
  outside = path.join(base, "outside");
  for (const dir of [
    path.join(home, "Music", "Live", "Encore"),
    path.join(home, "Documents"),
    path.join(home, ".cache"),
    path.join(drive, "Albums"),
    outside,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of ["01.flac", "02.FLAC", "03.mp3", "cover.jpg"]) writeFileSync(path.join(home, "Music", file), "");
  writeFileSync(path.join(home, "Music", "Live", "01.flac"), "");
  writeFileSync(path.join(home, "Music", "Live", "Encore", "01.flac"), "");
  writeFileSync(path.join(home, "notes.flac"), "");
  writeFileSync(path.join(drive, "Albums", "a.flac"), "");
  writeFileSync(path.join(drive, "Albums", "b.m4a"), "");
  symlinkSync(drive, path.join(home, "link-to-drive"));

  db = openDb(":memory:");
  app = await buildApp(linuxDeps());
  token = (await createOwnerForTest(app)).token;
});

afterEach(async () => {
  await app.close();
  rmSync(base, { recursive: true, force: true });
});

describe("GET /fs/browse — who may ask", () => {
  it("is behind the sign-in gate", async () => {
    const res = await get("/api/v1/fs/browse", {});
    expect(res.statusCode).toBe(401);
  });

  it("refuses a signed-in user who isn't the owner", async () => {
    const legacy = db
      .prepare(
        `INSERT INTO users (provider, provider_user_id, role) VALUES ('github', '42', 'legacy') RETURNING id`,
      )
      .get() as { id: number };
    const session = createSession(db, legacy.id);
    const res = await get("/api/v1/fs/browse", { authorization: `Bearer ${session.token}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("owner_only");
  });

  // A media ticket is the owner's too, but it lives in <img> URLs; it was
  // never meant to list the server's disks.
  it("refuses the owner's media ticket", async () => {
    const session = createSession(db, 1);
    const res = await get(`/api/v1/fs/browse?t=${session.mediaTicket}`, {});
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /fs/browse — roots", () => {
  it("offers home and real mount points, never /proc, /sys, /run or the data dir", async () => {
    const res = await get("/api/v1/fs/browse");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBeNull();
    expect(body.parent).toBeNull();
    expect(body.docker).toBe(false);
    expect(body.entries.map((e: { path: string }) => e.path)).toEqual([home, drive]);
  });

  it("counts each root's contents, its first level of subfolders included", async () => {
    const body = (await get("/api/v1/fs/browse")).json();
    // drive/ has no audio of its own; Albums' two files are one level down.
    expect(body.entries[1]).toEqual({ name: drive, path: drive, audioFiles: 2, folders: 1 });
  });

  it("in Docker, offers /music and the container's mounts but not home", async () => {
    await app.close();
    app = await buildApp(
      linuxDeps({
        docker: true,
        isDirectory: async (p) => p === "/music",
        readFile: async () =>
          [
            "overlay / overlay rw 0 0",
            "/dev/sda1 /music ext4 ro 0 0",
            `/dev/sda1 ${drive} ext4 ro 0 0`,
            "/dev/sda1 /data ext4 rw 0 0",
            "/dev/sda1 /etc/hosts ext4 rw 0 0",
          ].join("\n"),
        dataDir: "/data",
      }),
    );
    const body = (await get("/api/v1/fs/browse")).json();
    expect(body.docker).toBe(true);
    expect(body.entries.map((e: { path: string }) => e.path)).toEqual(["/music", drive]);
  });
});

describe("GET /fs/browse — listing a folder", () => {
  it("lists directories only, counting audio two levels deep", async () => {
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(home)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe(home);
    expect(body.parent).toBeNull(); // home is a root
    // notes.flac (counted, not listed) plus Music's own three. Live's file
    // is two levels below home, so it isn't in home's count.
    expect(body.audioFiles).toBe(4);
    expect(body.entries).toEqual([
      { name: "Documents", path: path.join(home, "Documents"), audioFiles: 0, folders: 0 },
      { name: "link-to-drive", path: path.join(home, "link-to-drive"), audioFiles: 2, folders: 1 },
      // 01.flac, 02.FLAC, 03.mp3 and Live/01.flac; cover.jpg isn't audio,
      // and Live/Encore's file is a level too deep.
      { name: "Music", path: path.join(home, "Music"), audioFiles: 4, folders: 1 },
    ]);
  });

  it("gives a parent below a root, and none at one", async () => {
    const music = path.join(home, "Music");
    const body = (await get(`/api/v1/fs/browse?path=${encodeURIComponent(path.join(music, "Live"))}`)).json();
    expect(body.parent).toBe(music);
    expect(body.audioFiles).toBe(2); // its own file and Encore's
  });

  it("follows a symlinked folder inside a root", async () => {
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(path.join(home, "link-to-drive"))}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0]).toMatchObject({ name: "Albums", audioFiles: 2 });
  });

  it("404s a folder that doesn't exist", async () => {
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(path.join(home, "nope"))}`);
    expect(res.statusCode).toBe(404);
  });

  it("400s a file", async () => {
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(path.join(home, "notes.flac"))}`);
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /fs/browse — staying inside the roots", () => {
  it("refuses a folder outside every root", async () => {
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(outside)}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("outside_roots");
  });

  it("judges .. after resolving it, so it can't climb out of home", async () => {
    const climb = `${home}/Music/../../outside`;
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(climb)}`);
    expect(res.statusCode).toBe(403);
  });

  it("refuses /proc and /etc as well, by the same rule", async () => {
    for (const p of ["/proc", "/etc", `${home}/../../../../../../etc`]) {
      const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(p)}`);
      expect(res.statusCode).toBe(403);
    }
  });

  it("refuses a sibling whose name only starts with a root's", async () => {
    mkdirSync(`${home}-evil`);
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(`${home}-evil`)}`);
    expect(res.statusCode).toBe(403);
  });

  it("400s a relative path and a NUL byte", async () => {
    expect((await get("/api/v1/fs/browse?path=Music")).statusCode).toBe(400);
    expect((await get(`/api/v1/fs/browse?path=${encodeURIComponent(`${home}\0`)}`)).statusCode).toBe(400);
  });
});

describe("GET /fs/browse — a mount that stopped answering", () => {
  const never = () => new Promise<never>(() => {});

  it("answers 504 rather than hanging when the folder itself won't list", async () => {
    await app.close();
    app = await buildApp(
      linuxDeps({
        timeoutMs: 100,
        readdir: async (dir) => {
          if (dir === drive) return never();
          const { readdir } = await import("node:fs/promises");
          return readdir(dir, { withFileTypes: true });
        },
      }),
    );
    const started = Date.now();
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(drive)}`);
    expect(res.statusCode).toBe(504);
    expect(res.json().reason).toBe("timeout");
    expect(res.json().error).toContain(drive);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still lists the parent when one child won't answer, with that child's counts unknown", async () => {
    await app.close();
    const hung = path.join(home, "Music");
    app = await buildApp(
      linuxDeps({
        timeoutMs: 100,
        readdir: async (dir) => {
          if (dir === hung) return never();
          const { readdir } = await import("node:fs/promises");
          return readdir(dir, { withFileTypes: true });
        },
      }),
    );
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(home)}`);
    expect(res.statusCode).toBe(200);
    const music = res.json().entries.find((e: { name: string }) => e.name === "Music");
    expect(music).toEqual({ name: "Music", path: hung, audioFiles: null, folders: null });
  });

  // The second level of a count is a read too, and can hang just the same.
  it("leaves a count unknown when a subfolder one level down won't answer", async () => {
    await app.close();
    const hung = path.join(home, "Music", "Live");
    app = await buildApp(
      linuxDeps({
        timeoutMs: 100,
        readdir: async (dir) => {
          if (dir === hung) return never();
          const { readdir } = await import("node:fs/promises");
          return readdir(dir, { withFileTypes: true });
        },
      }),
    );
    const res = await get(`/api/v1/fs/browse?path=${encodeURIComponent(home)}`);
    expect(res.statusCode).toBe(200);
    const music = res.json().entries.find((e: { name: string }) => e.name === "Music");
    expect(music).toMatchObject({ audioFiles: null, folders: null });
  });

  it("still counts a folder when one of its subfolders is unreadable", async () => {
    await app.close();
    const locked = path.join(home, "Music", "Live");
    app = await buildApp(
      linuxDeps({
        readdir: async (dir) => {
          if (dir === locked) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          const { readdir } = await import("node:fs/promises");
          return readdir(dir, { withFileTypes: true });
        },
      }),
    );
    const music = (await get(`/api/v1/fs/browse?path=${encodeURIComponent(home)}`))
      .json()
      .entries.find((e: { name: string }) => e.name === "Music");
    expect(music).toMatchObject({ audioFiles: 3, folders: 1 });
  });

  // Each hung read keeps a filesystem thread blocked until the mount comes
  // back. Retrying the same dead folder must not block another one.
  it("shares one read of a hung folder across repeated requests", async () => {
    await app.close();
    let reads = 0;
    app = await buildApp(
      linuxDeps({
        timeoutMs: 50,
        readdir: async (dir) => {
          if (dir === drive) {
            reads++;
            return never();
          }
          const { readdir } = await import("node:fs/promises");
          return readdir(dir, { withFileTypes: true });
        },
      }),
    );
    for (let i = 0; i < 3; i++) {
      expect((await get(`/api/v1/fs/browse?path=${encodeURIComponent(drive)}`)).statusCode).toBe(504);
    }
    expect(reads).toBe(1);
  });
});
