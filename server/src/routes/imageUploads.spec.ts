import * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { FastifyInstance } from "fastify";

// Issue #477: the two routes that hand ffmpeg bytes a signed-in user sent,
// the manual cover upload and the account picture, against the real store
// and the real ffmpeg.
//
// The cover store writes under DATA_DIR, which config.ts reads once, when
// it's first imported. So this spec points it at a directory of its own
// before importing anything that reads it, and refuses to run if that
// didn't take, rather than leave covers in a real data dir.
const dataDir = mkdtempSync(path.join(tmpdir(), "legato-image-uploads-"));
const previousDataDir = process.env.LEGATO_DATA_DIR;
process.env.LEGATO_DATA_DIR = dataDir;
const { default: Fastify } = await import("fastify");
const { openDb } = await import("../db.js");
const { CACHE_DIR, cachePath, storeCover } = await import("../cover/store.js");
const { coverRoutes } = await import("./cover.js");
const { installPictures, Pictures } = await import("../account/pictures.js");
const { buildTestApp, createOwnerForTest } = await import("../auth/test-app.js");
const { FFMPEG_PATH } = await import("../mediaBinaries.js");
if (previousDataDir === undefined) delete process.env.LEGATO_DATA_DIR;
else process.env.LEGATO_DATA_DIR = previousDataDir;
// Without --isolate (which `npm --prefix server test` passes), another spec
// file may have imported config.ts first.
if (!CACHE_DIR.startsWith(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true });
  throw new Error(`covers would land in ${CACHE_DIR}, not in this spec's own directory: run it alone or with bun test --isolate`);
}

// An address that records whatever asks it for anything, and a file that
// isn't a picture, for the playlist to name.
const requests: string[] = [];
const listener = createServer((req, res) => {
  requests.push(req.url ?? "");
  res.end("x");
});
const secret = path.join(dataDir, "secret.ts");
let playlist = Buffer.alloc(0);

let coverApp: FastifyInstance;
let pictureApp: FastifyInstance;
let owner = "";
let pictures: InstanceType<typeof Pictures>;
let releaseId = 0;
// Audio and video in the container HEIF shares, made by ffmpeg below.
const media: { name: string; brand: string; bytes: Buffer }[] = [];
// A spy, not a stub: it counts the store's spawns and lets each one run.
const realSpawn = childProcess.spawn;
const spawned = spyOn(childProcess, "spawn");

beforeAll(async () => {
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  writeFileSync(secret, "not for ffmpeg");
  playlist = Buffer.from(
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10,",
      `file://${secret}`,
      "#EXTINF:10,",
      `http://127.0.0.1:${(listener.address() as AddressInfo).port}/segment.ts`,
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"),
  );

  for (const [name, args] of [
    ["an M4A", ["-f", "lavfi", "-i", "sine=d=0.2", "-c:a", "aac", "-f", "ipod"]],
    ["an MP4", ["-f", "lavfi", "-i", "testsrc2=s=64x48:d=0.2", "-c:v", "mpeg4", "-f", "mp4"]],
    ["a QuickTime movie", ["-f", "lavfi", "-i", "testsrc2=s=64x48:d=0.2", "-c:v", "mpeg4", "-f", "mov"]],
  ] as const) {
    const file = path.join(dataDir, `media-${media.length}`);
    const made = spawnSync(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", ...args, file]);
    if (made.status !== 0) throw new Error(`ffmpeg couldn't make ${name}: ${made.stderr}`);
    const bytes = readFileSync(file);
    media.push({ name, brand: bytes.toString("latin1", 8, 12), bytes });
  }

  // The cover routes as cover.spec.ts mounts them, with index.ts's parser
  // for raw image bodies.
  const db = openDb(":memory:");
  releaseId = (db.prepare("INSERT INTO nodes (type, title) VALUES ('release', 'Rumours') RETURNING id").get() as { id: number }).id;
  coverApp = Fastify();
  coverApp.addContentTypeParser(/^image\/.*/, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  await coverApp.register(coverRoutes(db), { prefix: "/api/v1" });

  // The account routes behind the real sign-in, as account.spec.ts has them.
  const accountDb = openDb(":memory:");
  pictures = new Pictures(accountDb, { dir: path.join(dataDir, "avatars") });
  installPictures(accountDb, pictures);
  pictureApp = (await buildTestApp(accountDb)).app;
  owner = (await createOwnerForTest(pictureApp)).token;
});

afterAll(async () => {
  spawned.mockRestore();
  await coverApp.close();
  await pictureApp.close();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  spawned.mockClear();
  requests.length = 0;
});

function uploadCover(bytes: Buffer, contentType = "image/png") {
  return coverApp.inject({ method: "POST", url: `/api/v1/nodes/${releaseId}/cover`, headers: { "content-type": contentType }, payload: bytes });
}

function uploadPicture(bytes: Buffer, contentType = "image/png") {
  return pictureApp.inject({
    method: "PUT",
    url: "/api/v1/account/picture",
    headers: { authorization: `Bearer ${owner}`, "content-type": contentType },
    payload: bytes,
  });
}

describe("a playlist naming a file:// path and an http:// address", () => {
  it("is refused as a cover with 400, and ffmpeg never starts", async () => {
    const res = await uploadCover(playlist, "image/jpeg");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("That file isn't a picture this server can read. Try a JPEG or PNG.");
    expect(spawned).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("is refused as an account picture with 400, and ffmpeg never starts", async () => {
    const res = await uploadPicture(playlist, "image/jpeg");
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe("not_a_picture");
    expect(spawned).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("is no picture as a scan's art either, and ffmpeg, given it as one, opens neither", async () => {
    await expect(storeCover(playlist, { fromLibrary: true })).rejects.toThrow(/ffmpeg failed to decode cover art/);
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(spawned.mock.calls[0]![1]).toEqual(expect.arrayContaining(["-protocol_whitelist", "pipe", "-f", "image2pipe"]));
    expect(requests).toEqual([]);
  });
});

// HEIF is read through the same demuxer as these, so only a still image's
// brand gets as far as ffmpeg (media/pipedImage.ts).
describe("audio or video in HEIF's container", () => {
  it("is made with the brands it's meant to have", () => {
    expect(media.map((m) => m.brand)).toEqual(["M4A ", "isom", "qt  "]);
  });

  it("is refused by both routes with 400, and ffmpeg never starts", async () => {
    for (const { name, bytes } of media) {
      const cover = await uploadCover(bytes, "image/heic");
      const picture = await uploadPicture(bytes, "image/heic");
      expect([name, cover.statusCode, picture.statusCode]).toEqual([name, 400, 400]);
      expect(picture.json().reason).toBe("not_a_picture");
    }
    expect(spawned).not.toHaveBeenCalled();
  });
});

// Bundled ffmpeg builds differ, and one may not read a HEIF that passes the
// brand check. Here ffmpeg runs, but as a build without the decoder.
describe("a HEIC this server's ffmpeg can't read", () => {
  it("is refused by both routes with 400, asking for a JPEG or PNG, never a 500", async () => {
    spawned.mockImplementation(((command: string, args: readonly string[]) =>
      realSpawn(command, ["-c:v", "no_such_decoder", ...args])) as unknown as typeof childProcess.spawn);
    try {
      // A byte more than the HEIC below, so neither store has it already.
      const bytes = Buffer.concat([HEIC, Buffer.from([0])]);
      const cover = await uploadCover(bytes, "image/heic");
      const picture = await uploadPicture(bytes, "image/heic");
      const message = "This server couldn't read that picture's format. Try a JPEG or PNG.";
      expect([cover.statusCode, cover.json().error]).toEqual([400, message]);
      expect([picture.statusCode, picture.json().error, picture.json().reason]).toEqual([400, message, "not_a_picture"]);
      expect(spawned).toHaveBeenCalledTimes(2);
      expect(spawned.mock.calls[0]![1]).toEqual(expect.arrayContaining(["-protocol_whitelist", "pipe", "-f", "mov"]));
    } finally {
      spawned.mockImplementation(realSpawn);
    }
  });
});

// What resize() and squareJpeg() ran before #477: ffmpeg left to probe
// stdin. Each picture that worked that way must come out of the routes byte
// for byte the same, and one that didn't (a HEIC, to an ffmpeg older than
// HEIF support) must still be refused.
function before(bytes: Buffer, filter: string, quality: string): Buffer<ArrayBuffer> | null {
  const result = spawnSync(
    FFMPEG_PATH,
    ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", filter, "-frames:v", "1", "-f", "mjpeg", "-q:v", quality, "pipe:1"],
    { input: bytes, maxBuffer: 64 * 1024 * 1024 },
  );
  return result.status === 0 && result.stdout.length > 0 ? Buffer.from(result.stdout) : null;
}
const coverBefore = (bytes: Buffer, edge: number) => before(bytes, `scale=${edge}:${edge}:force_original_aspect_ratio=decrease`, "4");
const pictureBefore = (bytes: Buffer) => before(bytes, "scale=256:256:force_original_aspect_ratio=increase,crop=256:256", "3");

// One frame from ffmpeg's test sources.
function encode(source: string, output: string[]): Buffer {
  const result = spawnSync(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source, "-frames:v", "1", ...output, "pipe:1"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg couldn't make a test picture: ${result.stderr}`);
  return result.stdout;
}

// A phone camera's JPEG: stored landscape, with an EXIF Orientation of 6
// (turn 90° clockwise to show it). The APP1 segment goes right after the
// start-of-image marker, where a camera puts it.
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from(tiff)]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, body, jpeg.subarray(2)]);
}

// ffmpeg reads WebP everywhere but only writes it with libwebp, which not
// every build has, and HEIF it never writes. Both are made with ImageMagick:
// 48x32, red with a blue band.
const WEBP = Buffer.from("UklGRiYAAABXRUJQVlA4TBoAAAAvL8AHAA8Q47//8x8OxIJJ/tIz6I7of1CcAw==", "base64");
const HEIC = Buffer.from(
  "AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAWltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEA" +
    "AQAAAAABjQABAAAAAAAAAPUAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA6WlwcnAAAADKaXBjbwAAAHZodmND" +
    "AQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq5Ka5uAhoMCAA" +
    "AAMDIAAAAwAhYgABAAZEAcFzwIkAAAAUaXNwZQAAAAAAAABAAAAAQAAAAChjbGFwAAAAMAAAAAEAAAAgAAAAAf////AAAAAC////4AAAAAIAAAAQcGl4aQAA" +
    "AAADCAgIAAAAF2lwbWEAAAAAAAAAAQABBIECBIMAAAD9bWRhdAAAAPEoAa8J4CE5NB//8ju///Kwdl+8R5vX/zsG3f1Ibf/5AwjFwkVe/ynW5u09I9R9jGTu" +
    "t40jd7uLRE/VoDV4SoV3zegV8xr/+1pHf/a7q9/0wUegk0w+sr2tb/zhMHHb8RPwrnGcsitZ7JmO6fjxbJ07Xx2zSv9Nvoo5F7CvBMOjRa9BjoslynmbZhGa" +
    "sU2O06m2VebICZVLK3rkBqTe3j1XLgQuPO4x34NH3x+V0mUXJ7RpWk3ZG0d4bK3MXnLGaryYDH3w+Nz6DtHFRsrnNUAtlLMqOKo281K402gyyhhLJOKNMkoF" +
    "BDLi2KJ73x+/0Kbg",
  "base64",
);

const PICTURES: { name: string; type: string; bytes: () => Buffer; everywhere: boolean }[] = [
  { name: "a JPEG", type: "image/jpeg", bytes: () => encode("testsrc2=s=800x600", ["-f", "image2pipe", "-c:v", "mjpeg"]), everywhere: true },
  { name: "a PNG", type: "image/png", bytes: () => encode("testsrc2=s=640x480", ["-f", "image2pipe", "-c:v", "png"]), everywhere: true },
  {
    name: "a transparent PNG",
    type: "image/png",
    bytes: () => encode("color=red@0.0:s=300x200,format=rgba", ["-f", "image2pipe", "-c:v", "png"]),
    everywhere: true,
  },
  { name: "a WebP", type: "image/webp", bytes: () => WEBP, everywhere: true },
  { name: "a GIF", type: "image/gif", bytes: () => encode("testsrc2=s=400x300", ["-f", "gif"]), everywhere: true },
  {
    name: "a phone photo: a 4032x3024 JPEG turned by its EXIF",
    type: "image/jpeg",
    bytes: () => withExifOrientation(encode("testsrc2=s=4032x3024", ["-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "2"]), 6),
    everywhere: true,
  },
  { name: "a HEIC, where this ffmpeg reads one", type: "image/heic", bytes: () => HEIC, everywhere: false },
];

describe("pictures that worked before #477", () => {
  for (const picture of PICTURES) {
    it(`${picture.name} comes out the same, as a cover and as an account picture`, async () => {
      const bytes = picture.bytes();
      const full = coverBefore(bytes, 512);
      if (picture.everywhere) expect(full).not.toBeNull();

      const cover = await uploadCover(bytes, picture.type);
      const uploaded = await uploadPicture(bytes, picture.type);
      if (!full) {
        expect(cover.statusCode).toBe(400);
        expect(uploaded.statusCode).toBe(400);
        return;
      }

      expect(cover.statusCode).toBe(201);
      const { hash } = cover.json() as { hash: string };
      expect(readFileSync(cachePath(hash, "full"))).toEqual(full);
      expect(readFileSync(cachePath(hash, "thumb"))).toEqual(coverBefore(bytes, 256)!);

      expect(uploaded.statusCode).toBe(200);
      const stored = uploaded.json().user.picture as { hash: string };
      expect(readFileSync(pictures.path(stored.hash))).toEqual(pictureBefore(bytes)!);

      // Both went through ffmpeg, which is what makes the spy's silence
      // above mean something.
      expect(spawned.mock.calls.length).toBeGreaterThanOrEqual(3);
    }, 30_000);
  }
});
