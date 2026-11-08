import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { USER_AGENT } from "../enrich/mbClient.js";
import { FFMPEG_PATH } from "../mediaBinaries.js";
import { pipedImageInput } from "../media/pipedImage.js";
import { runMediaTask } from "../media/queue.js";
import type { Database } from "../sqlite.js";
import { broadcast } from "../ws.js";

// Users' pictures (issue #470, migration 0046). Two kinds land here, and
// the uploaded one wins wherever they're shown (routes/auth.ts's
// publicUser):
//   * one a user uploads in the Account panel, which stays on this server
//     and is never sent to legato.fm;
//   * this server's copy of the Google or GitHub picture legato.fm sends for
//     a linked user, in its signed tokens and its answer to a link report.
//     Devices never load that address themselves. The server fetches it once
//     per address and serves its copy, the way it serves an uploaded one.
//
// Both are stored the way covers are (cover/store.ts): resized through
// ffmpeg, content-addressed by the sha1 of the bytes that came in, under
// <data dir>/avatars/<pixel bound>/<hash prefix>/<sha1>.jpg. One size is
// enough: the biggest a picture is drawn is 64 CSS px, and 256 covers that
// at 3x with room to spare. Pictures are cropped square, since every place
// draws them in a circle.

export const PICTURE_EDGE = 256;
export const PICTURES_DIR = path.join(DATA_DIR, "avatars");
export const PICTURE_HASH_PATTERN = /^[0-9a-f]{40}$/;

// A phone photo straight off the camera fits; a picture from Google or
// GitHub is a few tens of KB.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_REMOTE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

// A fetch that failed waits this long before the same address is tried
// again, so a picture host that's down isn't asked on every sign-in.
export const RETRY_AFTER_MS = 60 * 60 * 1000;

// The hosts Google and GitHub serve profile pictures from. legato.fm only
// ever sends one of theirs, and nothing else is fetched: a picture address
// is never a way to make this server request something on its own network.
const PICTURE_HOST_SUFFIXES = [".googleusercontent.com", ".githubusercontent.com"];

export function isPictureAddress(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && PICTURE_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

// Square and bounded: scaled until the shorter edge fills PICTURE_EDGE, then
// the middle cropped out. A portrait photo keeps the face, which is usually
// in the middle; a transparent PNG's background comes out black, as a
// cover's does.
// `inputArgs` come from pipedImageInput (media/pipedImage.ts), which has
// already checked the bytes are a picture ffmpeg may read (#477).
function squareJpeg(input: Buffer, inputArgs: string[], edge: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputArgs,
      "-vf",
      `scale=${edge}:${edge}:force_original_aspect_ratio=increase,crop=${edge}:${edge}`,
      "-frames:v",
      "1",
      "-f",
      "mjpeg",
      "-q:v",
      "3",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        reject(new Error(`ffmpeg couldn't read the picture (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    // Bytes that aren't an image make ffmpeg exit before reading them all;
    // the close handler above says why.
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.end(input);
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// The response's body, refused past `limit` bytes without reading the rest.
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`it's ${declared} bytes, over the ${limit} allowed`);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`it's over the ${limit} bytes allowed`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type PicturesOptions = {
  dir?: string;
  fetch?: typeof fetch;
  log?: (level: "info" | "warn", message: string) => void;
  now?: () => number;
  // Told whenever a user's picture changes. Clients showing the Account
  // panel listen for it, since a fetched picture lands after the request
  // that caused it has been answered.
  onChange?: (userId: number) => void;
};

type RemoteRow = {
  avatar_url: string | null;
  avatar_remote_hash: string | null;
  avatar_remote_url: string | null;
  legato_account_id: string | null;
};

export class Pictures {
  readonly dir: string;
  private readonly db: Database;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (level: "info" | "warn", message: string) => void;
  private readonly now: () => number;
  private readonly changed: (userId: number) => void;
  // One sync at a time per user, each after the last, so a picture that
  // changes twice in quick succession ends on the second.
  private readonly queue = new Map<number, Promise<void>>();
  private readonly failedAt = new Map<string, number>();

  constructor(db: Database, options: PicturesOptions = {}) {
    this.db = db;
    this.dir = options.dir ?? PICTURES_DIR;
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.changed = options.onChange ?? ((userId) => broadcast("account:changed", { userId }));
  }

  path(hash: string): string {
    return path.join(this.dir, String(PICTURE_EDGE), hash.slice(0, 2), `${hash}.jpg`);
  }

  // Stores a picture and returns its hash. Throws when it isn't a picture:
  // before ffmpeg starts, for bytes that aren't a format it may read, or
  // when ffmpeg can't read them. Lands through a temp file and a rename, as
  // covers do, so a reader never sees half a file.
  async store(bytes: Buffer): Promise<string> {
    const inputArgs = pipedImageInput(bytes);
    const hash = createHash("sha1").update(bytes).digest("hex");
    const target = this.path(hash);
    if (await exists(target)) return hash;
    const resized = await runMediaTask("background", () => squareJpeg(bytes, inputArgs, PICTURE_EDGE));
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, resized);
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    return hash;
  }

  async read(hash: string): Promise<Buffer | null> {
    if (!PICTURE_HASH_PATTERN.test(hash)) return null;
    try {
      return await readFile(this.path(hash));
    } catch {
      return null;
    }
  }

  // A picture nobody shows any more goes. Two users can share one (the same
  // upload, or the same Google picture), so it's only gone once neither
  // column names it.
  async dropIfUnused(hash: string | null): Promise<void> {
    if (!hash || !PICTURE_HASH_PATTERN.test(hash)) return;
    const used = this.db.prepare("SELECT 1 FROM users WHERE avatar_upload_hash = ? OR avatar_remote_hash = ? LIMIT 1").get(hash, hash);
    if (!used) await unlink(this.path(hash)).catch(() => {});
  }

  // The uploaded picture: a new hash, or null to remove it.
  async setUpload(userId: number, hash: string | null): Promise<void> {
    const previous = this.db.prepare("SELECT avatar_upload_hash FROM users WHERE id = ?").get(userId) as
      | { avatar_upload_hash: string | null }
      | undefined;
    if (!previous) return;
    this.db.prepare("UPDATE users SET avatar_upload_hash = ? WHERE id = ?").run(hash, userId);
    if (previous.avatar_upload_hash !== hash) await this.dropIfUnused(previous.avatar_upload_hash);
    this.changed(userId);
  }

  // What legato.fm said this user's picture is, from a verified token or a
  // link report. Undefined is a legato.fm too old to say, and changes
  // nothing. Writes only when the address changed, since a gated request
  // can land here and most of them have nothing new to say.
  // `current` is the address stored now, when the caller already has it.
  note(userId: number, picture: string | null | undefined, current?: string | null): void {
    if (picture === undefined) return;
    const stored =
      current !== undefined
        ? current
        : ((this.db.prepare("SELECT avatar_url FROM users WHERE id = ?").get(userId) as { avatar_url: string | null } | undefined)
            ?.avatar_url ?? null);
    if (picture !== stored) this.db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(picture, userId);
    void this.sync(userId);
  }

  // Unlinking takes legato.fm's picture with it: it was that account's.
  async forgetRemote(userId: number): Promise<void> {
    const row = this.db.prepare("SELECT avatar_url, avatar_remote_hash FROM users WHERE id = ?").get(userId) as
      | { avatar_url: string | null; avatar_remote_hash: string | null }
      | undefined;
    if (!row || (row.avatar_url === null && row.avatar_remote_hash === null)) return;
    this.db.prepare("UPDATE users SET avatar_url = NULL, avatar_remote_hash = NULL, avatar_remote_url = NULL WHERE id = ?").run(userId);
    await this.dropIfUnused(row.avatar_remote_hash);
    this.changed(userId);
  }

  // Brings this server's copy of a user's legato.fm picture up to date:
  // fetched when the address is new, dropped when there's none. Never
  // throws; a failure is logged once per address and tried again an hour
  // later at the earliest.
  sync(userId: number): Promise<void> {
    const run = (this.queue.get(userId) ?? Promise.resolve()).then(() => this.syncNow(userId)).catch(() => {});
    this.queue.set(userId, run);
    void run.finally(() => {
      if (this.queue.get(userId) === run) this.queue.delete(userId);
    });
    return run;
  }

  // Every linked user whose copy is missing or stale, once at startup: a
  // fetch the server was restarted in the middle of, or one that failed.
  async syncPending(): Promise<void> {
    const ids = this.db
      .prepare(
        `SELECT id FROM users
         WHERE legato_account_id IS NOT NULL AND avatar_url IS NOT NULL AND avatar_url IS NOT avatar_remote_url`,
      )
      .all() as { id: number }[];
    for (const { id } of ids) await this.sync(id);
  }

  private async syncNow(userId: number): Promise<void> {
    const row = this.db
      .prepare("SELECT avatar_url, avatar_remote_hash, avatar_remote_url, legato_account_id FROM users WHERE id = ?")
      .get(userId) as RemoteRow | undefined;
    if (!row) return;

    const address = row.legato_account_id === null ? null : row.avatar_url;
    if (address === null) {
      if (row.avatar_remote_hash === null) return;
      this.db.prepare("UPDATE users SET avatar_remote_hash = NULL, avatar_remote_url = NULL WHERE id = ?").run(userId);
      await this.dropIfUnused(row.avatar_remote_hash);
      this.changed(userId);
      return;
    }
    if (address === row.avatar_remote_url) return;
    const failed = this.failedAt.get(address);
    if (failed !== undefined && this.now() - failed < RETRY_AFTER_MS) return;

    let hash: string;
    try {
      hash = await this.store(await this.download(address));
    } catch (err) {
      if (failed === undefined) {
        const why = err instanceof Error ? err.message : String(err);
        this.log("warn", `pictures: couldn't fetch user ${userId}'s legato.fm picture (${why})`);
      }
      this.failedAt.set(address, this.now());
      return;
    }
    this.failedAt.delete(address);

    // Only if the address is still the one fetched: a newer one is the
    // next sync's to fetch, and this copy isn't anyone's.
    const stored = this.db
      .prepare("UPDATE users SET avatar_remote_hash = ?, avatar_remote_url = ? WHERE id = ? AND avatar_url = ?")
      .run(hash, address, userId, address);
    if (stored.changes === 0) return this.dropIfUnused(hash);
    if (row.avatar_remote_hash !== hash) await this.dropIfUnused(row.avatar_remote_hash);
    this.changed(userId);
  }

  // Redirects are followed by hand, so every hop is checked against the
  // picture hosts before anything is asked of it.
  private async download(address: string): Promise<Buffer> {
    let current = address;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isPictureAddress(current)) throw new Error(`${current} isn't a Google or GitHub picture address`);
      const res = await this.fetchImpl(current, {
        headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`HTTP ${res.status} with nowhere to go`);
        current = new URL(location, current).href;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("image/")) throw new Error(`it isn't an image (${type || "no content type"})`);
      return await readCapped(res, MAX_REMOTE_BYTES);
    }
    throw new Error("too many redirects");
  }
}

// One per database, as legato.fm's identity is (auth/legatoIdentity.ts):
// index.ts installs the real one at startup, and a spec installs its own
// with a fetch that never leaves the machine and a directory of its own.
const installed = new WeakMap<Database, Pictures>();

export function installPictures(db: Database, pictures: Pictures): void {
  installed.set(db, pictures);
}

export function hasPictures(db: Database): boolean {
  return installed.has(db);
}

export function pictures(db: Database): Pictures {
  let found = installed.get(db);
  if (!found) {
    found = new Pictures(db);
    installed.set(db, found);
  }
  return found;
}
