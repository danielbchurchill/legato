import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { FFMPEG_PATH } from "../mediaBinaries.js";
import { NotAPictureError, pipedImageDemuxer, pipedImageInput } from "./pipedImage.js";

// Issue #477. Only the first bytes matter here, so each picture is just its
// magic number and some padding.
const pad = (head: number[] | string) =>
  Buffer.concat([typeof head === "string" ? Buffer.from(head, "latin1") : Buffer.from(head), Buffer.alloc(32)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = pad("RIFF\x26\x00\x00\x00WEBPVP8L");
const GIF87 = pad("GIF87a");
const GIF89 = pad("GIF89a");
const HEIC = pad("\x00\x00\x00\x1cftypheic\x00\x00\x00\x00mif1heic");
const AVIF = pad("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00mif1avif");
const ftyp = (brand: string) => pad(`\x00\x00\x00\x20ftyp${brand}\x00\x00\x02\x00isomiso2mp41`);
const MP4 = ftyp("isom");
const M4A = ftyp("M4A ");
const QT = ftyp("qt  ");
const MIF1 = ftyp("mif1");
// Image sequences: animations, which share the brands' family but aren't pictures.
const SEQUENCES = ["msf1", "hevc", "hevx", "avis"].map(ftyp);
const BMP = pad("BM");
const PLAYLIST = Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:///etc/hosts\n");

describe("pipedImageDemuxer", () => {
  it("names the demuxer ffmpeg's own probe picks for each picture format", () => {
    expect(pipedImageDemuxer(JPEG)).toBe("jpeg_pipe");
    expect(pipedImageDemuxer(PNG)).toBe("png_pipe");
    expect(pipedImageDemuxer(WEBP)).toBe("webp_pipe");
    expect(pipedImageDemuxer(GIF87)).toBe("gif");
    expect(pipedImageDemuxer(GIF89)).toBe("gif");
    expect(pipedImageDemuxer(HEIC)).toBe("mov");
    expect(pipedImageDemuxer(AVIF)).toBe("mov");
    expect(pipedImageDemuxer(MIF1)).toBe("mov");
  });

  it("knows nothing else: audio, video and image sequences in the same container included", () => {
    for (const bytes of [PLAYLIST, MP4, M4A, QT, ...SEQUENCES, BMP, Buffer.alloc(0), Buffer.from([0xff, 0xd8]), Buffer.from("RIFF\0\0\0\0WAVEfmt ")]) {
      expect(pipedImageDemuxer(bytes)).toBeNull();
    }
  });
});

describe("pipedImageInput", () => {
  it("allows only the pipe protocol, and names the demuxer, before the input", () => {
    expect(pipedImageInput(PNG)).toEqual(["-protocol_whitelist", "pipe", "-f", "png_pipe", "-i", "pipe:0"]);
  });

  it("refuses an upload or a download that isn't a known picture, so ffmpeg never sees it", () => {
    for (const bytes of [PLAYLIST, MP4, M4A, QT, BMP, Buffer.alloc(0)]) {
      expect(() => pipedImageInput(bytes)).toThrow(NotAPictureError);
    }
  });

  it("gives a scan's art in another format to image2pipe, which only reads images", () => {
    expect(pipedImageInput(BMP, "library")).toEqual(["-protocol_whitelist", "pipe", "-f", "image2pipe", "-i", "pipe:0"]);
    expect(pipedImageInput(JPEG, "library")).toEqual(["-protocol_whitelist", "pipe", "-f", "jpeg_pipe", "-i", "pipe:0"]);
  });
});

// The library's way in does start ffmpeg on bytes it doesn't recognise, so
// this runs the real one on a playlist naming an address that records any
// request.
describe("a playlist in a music file's tags", () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.end("x");
  });
  let address = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/segment.ts`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("is no picture to image2pipe, and ffmpeg asks the address nothing", async () => {
    const playlist = Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n${address}\n#EXT-X-ENDLIST\n`);
    // Not spawnSync: the server above answers on this event loop.
    const ffmpeg = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", ...pipedImageInput(playlist, "library"), "-frames:v", "1", "-f", "mjpeg", "pipe:1"]);
    let output = 0;
    ffmpeg.stdout.on("data", (chunk: Buffer) => (output += chunk.length));
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.end(playlist);
    const code = await new Promise((resolve) => ffmpeg.on("close", resolve));
    expect(code).not.toBe(0);
    expect(output).toBe(0);
    expect(requests).toEqual([]);
  });
});
