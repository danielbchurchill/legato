// Test-only: pictures for the picture specs, made by the same ffmpeg the
// server resizes with. Not a *.spec.ts, so `bun test` never runs it as a
// suite of its own.
import { runFfmpeg } from "../test-ffmpeg.js";

// A PNG ffmpeg makes: a red frame `width` by `height` with a blue square
// filling its middle, so a centre crop of a wide one is all blue. Always
// PNG, which every ffmpeg encodes from this source; a fake picture host can
// serve it as image/jpeg, since the server only checks the content type and
// ffmpeg reads the bytes for what they are.
export function makeImage(width: number, height: number): Buffer {
  const side = Math.min(width, height);
  return runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=red:s=${width}x${height}`,
    "-vf",
    `drawbox=x=${(width - side) / 2}:y=${(height - side) / 2}:w=${side}:h=${side}:color=blue:t=fill,format=rgb24`,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "pipe:1",
  ]);
}

export function jpegSize(bytes: Buffer): { width: number; height: number } {
  let at = 2;
  while (at < bytes.length) {
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error("no frame header in that JPEG");
}
