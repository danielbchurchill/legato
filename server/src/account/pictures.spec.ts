import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import type { Database } from "../sqlite.js";
import { runFfmpeg } from "../test-ffmpeg.js";
import { isPictureAddress, PICTURE_EDGE, Pictures, RETRY_AFTER_MS } from "./pictures.js";
import { jpegSize, makeImage } from "./test-images.js";

// Issue #470: users' pictures, stored the way covers are, and this server's
// copy of the Google or GitHub picture legato.fm sends for a linked user.

const GOOGLE = "https://lh3.googleusercontent.com/a/owner=s96-c";
const GITHUB = "https://avatars.githubusercontent.com/u/42?v=4";

// The colour at the picture's top-left corner, decoded back through ffmpeg.
function cornerColour(jpeg: Buffer): [number, number, number] {
  const pixels = runFfmpeg(["-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: jpeg });
  return [pixels[0]!, pixels[1]!, pixels[2]!];
}

let png: Buffer;
beforeAll(() => {
  png = makeImage(400, 200);
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type FetchCall = { url: string; init?: RequestInit };

function imageResponse(bytes: Buffer, headers: Record<string, string> = {}) {
  return new Response(bytes, { headers: { "Content-Type": "image/jpeg", ...headers } });
}

function harness(answer: (url: string) => Response | Error = () => imageResponse(makeImage(96, 96))) {
  const db = openDb(":memory:");
  const dir = mkdtempSync(path.join(tmpdir(), "legato-pictures-"));
  dirs.push(dir);
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  const changes: number[] = [];
  let clock = 1_000_000;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const reply = answer(String(input));
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  const store = new Pictures(db, {
    dir,
    fetch: fetchImpl,
    log: (_level, message) => logs.push(message),
    now: () => clock,
    onChange: (userId) => changes.push(userId),
  });
  const tick = (ms: number) => {
    clock += ms;
  };
  return { db, dir, store, calls, logs, changes, tick };
}

function addUser(db: Database, options: { linked?: boolean; avatarUrl?: string | null; email?: string } = {}): number {
  const result = db
    .prepare(
      `INSERT INTO users (provider, provider_user_id, email, role, legato_account_id, avatar_url)
       VALUES ('google', ?, ?, 'legacy', ?, ?)`,
    )
    .run(crypto.randomUUID(), options.email ?? null, options.linked === false ? null : crypto.randomUUID(), options.avatarUrl ?? null);
  return Number(result.lastInsertRowid);
}

const NO_PICTURE = { avatar_url: null, avatar_upload_hash: null, avatar_remote_hash: null, avatar_remote_url: null };

function pictureColumns(db: Database, id: number) {
  return db.prepare("SELECT avatar_url, avatar_upload_hash, avatar_remote_hash, avatar_remote_url FROM users WHERE id = ?").get(id) as {
    avatar_url: string | null;
    avatar_upload_hash: string | null;
    avatar_remote_hash: string | null;
    avatar_remote_url: string | null;
  };
}

describe("isPictureAddress", () => {
  it("takes Google's and GitHub's picture hosts over https", () => {
    expect(isPictureAddress(GOOGLE)).toBe(true);
    expect(isPictureAddress(GITHUB)).toBe(true);
  });

  it("takes nothing else, so a picture address can't reach the server's own network", () => {
    for (const address of [
      "http://lh3.googleusercontent.com/a/x",
      "https://localhost/a.jpg",
      "https://127.0.0.1/a.jpg",
      "https://192.168.1.10/a.jpg",
      "https://googleusercontent.com.example.com/a.jpg",
      "https://example.com/googleusercontent.com/a.jpg",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(isPictureAddress(address)).toBe(false);
    }
  });
});

describe("store", () => {
  it("crops a picture square from its middle, at 256px, as a JPEG under the data dir", async () => {
    const h = harness();
    const hash = await h.store.store(png);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(h.store.path(hash)).toBe(path.join(h.dir, String(PICTURE_EDGE), hash.slice(0, 2), `${hash}.jpg`));
    const stored = (await h.store.read(hash))!;
    expect(jpegSize(stored)).toEqual({ width: PICTURE_EDGE, height: PICTURE_EDGE });
    // The red sides are cropped away; the blue middle fills it.
    const [r, g, b] = cornerColour(stored);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
    expect(g).toBeLessThan(60);
  });

  it("names a picture by its bytes, so the same one is stored once", async () => {
    const h = harness();
    expect(await h.store.store(png)).toBe(await h.store.store(png));
  });

  it("refuses bytes that aren't a picture, and leaves nothing behind", async () => {
    const h = harness();
    await expect(h.store.store(Buffer.from("not a picture at all"))).rejects.toThrow();
    expect(existsSync(path.join(h.dir, String(PICTURE_EDGE)))).toBe(false);
  });

  it("reads nothing for a hash that isn't one, or isn't stored", async () => {
    const h = harness();
    expect(await h.store.read("../../etc/passwd")).toBeNull();
    expect(await h.store.read("0".repeat(40))).toBeNull();
  });
});

describe("an uploaded picture", () => {
  it("replaces the last one, whose file goes unless another user shows it", async () => {
    const h = harness();
    const ada = addUser(h.db);
    const grace = addUser(h.db);
    const first = await h.store.store(png);
    const second = await h.store.store(makeImage(300, 300));
    await h.store.setUpload(ada, first);
    await h.store.setUpload(grace, first);
    await h.store.setUpload(ada, second);
    expect(pictureColumns(h.db, ada).avatar_upload_hash).toBe(second);
    expect(existsSync(h.store.path(first))).toBe(true);

    await h.store.setUpload(grace, null);
    expect(pictureColumns(h.db, grace).avatar_upload_hash).toBeNull();
    expect(existsSync(h.store.path(first))).toBe(false);
    expect(h.changes).toEqual([ada, grace, ada, grace]);
  });
});

describe("legato.fm's picture", () => {
  it("is fetched once per address and kept for the linked user", async () => {
    const h = harness();
    const id = addUser(h.db);
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    const row = pictureColumns(h.db, id);
    expect(row.avatar_url).toBe(GOOGLE);
    expect(row.avatar_remote_url).toBe(GOOGLE);
    expect(row.avatar_remote_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(h.store.path(row.avatar_remote_hash!))).toBe(true);
    expect(h.calls.map((c) => c.url)).toEqual([GOOGLE]);
    expect(h.changes).toEqual([id]);

    // The same address again, as every later token carries it: no fetch.
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    expect(h.calls).toHaveLength(1);
    expect(h.changes).toEqual([id]);
  });

  it("asks with Legato's User-Agent, and only for an image", async () => {
    const h = harness();
    const id = addUser(h.db, { avatarUrl: GITHUB });
    await h.store.sync(id);
    const headers = new Headers(h.calls[0]!.init?.headers);
    expect(headers.get("user-agent")).toContain("Legato/");
    expect(headers.get("accept")).toBe("image/*");
  });

  it("follows a new address, and drops the copy of the old one", async () => {
    let size = 96;
    const h = harness(() => imageResponse(makeImage(size, size)));
    const id = addUser(h.db);
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    const old = pictureColumns(h.db, id).avatar_remote_hash!;

    size = 120;
    h.store.note(id, GITHUB);
    await h.store.sync(id);
    const row = pictureColumns(h.db, id);
    expect(row.avatar_remote_url).toBe(GITHUB);
    expect(row.avatar_remote_hash).not.toBe(old);
    expect(existsSync(h.store.path(old))).toBe(false);
  });

  it("goes when legato.fm says the account has none", async () => {
    const h = harness();
    const id = addUser(h.db);
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    const hash = pictureColumns(h.db, id).avatar_remote_hash!;

    h.store.note(id, null);
    await h.store.sync(id);
    expect(pictureColumns(h.db, id)).toEqual({ ...NO_PICTURE });
    expect(existsSync(h.store.path(hash))).toBe(false);
  });

  it("changes nothing when legato.fm doesn't say, as one from before the claim doesn't", async () => {
    const h = harness();
    const id = addUser(h.db);
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    const before = pictureColumns(h.db, id);
    h.store.note(id, undefined);
    await h.store.sync(id);
    expect(pictureColumns(h.db, id)).toEqual(before);
    expect(h.calls).toHaveLength(1);
  });

  it("goes on unlinking, and an uploaded picture stays", async () => {
    const h = harness();
    const id = addUser(h.db);
    const upload = await h.store.store(png);
    await h.store.setUpload(id, upload);
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    const remote = pictureColumns(h.db, id).avatar_remote_hash!;

    await h.store.forgetRemote(id);
    expect(pictureColumns(h.db, id)).toEqual({ ...NO_PICTURE, avatar_upload_hash: upload });
    expect(existsSync(h.store.path(remote))).toBe(false);
    expect(existsSync(h.store.path(upload))).toBe(true);
  });

  it("isn't fetched for a user who isn't linked", async () => {
    const h = harness();
    const id = addUser(h.db, { linked: false, avatarUrl: GOOGLE });
    await h.store.sync(id);
    await h.store.syncPending();
    expect(h.calls).toHaveLength(0);
    expect(pictureColumns(h.db, id).avatar_remote_hash).toBeNull();
  });

  it("is never asked of a host that isn't Google's or GitHub's, even by a redirect", async () => {
    const h = harness((url) =>
      url === GOOGLE ? new Response(null, { status: 302, headers: { Location: "https://192.168.1.10/admin" } }) : imageResponse(png),
    );
    const id = addUser(h.db);
    h.store.note(id, "https://192.168.1.10/a.jpg");
    await h.store.sync(id);
    expect(h.calls).toHaveLength(0);

    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    expect(h.calls.map((c) => c.url)).toEqual([GOOGLE]);
    expect(pictureColumns(h.db, id).avatar_remote_hash).toBeNull();
    expect(h.logs.join("\n")).toContain("isn't a Google or GitHub picture address");
  });

  it("follows a redirect between picture hosts", async () => {
    const h = harness((url) =>
      url === GOOGLE ? new Response(null, { status: 301, headers: { Location: GITHUB } }) : imageResponse(makeImage(96, 96)),
    );
    const id = addUser(h.db);
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    expect(h.calls.map((c) => c.url)).toEqual([GOOGLE, GITHUB]);
    // Kept under the address legato.fm sent, so it isn't fetched again.
    expect(pictureColumns(h.db, id).avatar_remote_url).toBe(GOOGLE);
  });

  it("refuses an answer that isn't an image, or is too big", async () => {
    let reply: () => Response = () => new Response("<html>", { headers: { "Content-Type": "text/html" } });
    const h = harness(() => reply());
    const id = addUser(h.db);
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    expect(h.logs.at(-1)).toContain("it isn't an image (text/html)");

    reply = () => imageResponse(Buffer.alloc(16), { "Content-Length": String(50 * 1024 * 1024) });
    h.store.note(id, GITHUB);
    await h.store.sync(id);
    expect(h.logs.at(-1)).toContain("over the");
    expect(pictureColumns(h.db, id).avatar_remote_hash).toBeNull();
  });

  it("logs a failure once, and tries that address again an hour later", async () => {
    let up = false;
    const h = harness(() => (up ? imageResponse(makeImage(96, 96)) : new Error("getaddrinfo ENOTFOUND")));
    const id = addUser(h.db);
    h.store.note(id, GOOGLE);
    await h.store.sync(id);
    await h.store.sync(id);
    expect(h.calls).toHaveLength(1);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain(`couldn't fetch user ${id}'s legato.fm picture (getaddrinfo ENOTFOUND)`);

    up = true;
    h.tick(RETRY_AFTER_MS);
    await h.store.syncPending();
    expect(h.calls).toHaveLength(2);
    expect(h.logs).toHaveLength(1);
    expect(pictureColumns(h.db, id).avatar_remote_url).toBe(GOOGLE);
  });

  it("ends on the newest address when it changes while a fetch is out", async () => {
    const h = harness();
    const id = addUser(h.db);
    h.store.note(id, GOOGLE);
    h.store.note(id, GITHUB);
    await h.store.sync(id);
    expect(pictureColumns(h.db, id).avatar_remote_url).toBe(GITHUB);
  });
});
