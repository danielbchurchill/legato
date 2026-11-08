// What ffmpeg may read when a picture reaches it on stdin (issue #477).
//
// Covers and users' pictures reach ffmpeg as bytes on stdin: an upload, an
// image downloaded from the Cover Art Archive, Deezer, Google or GitHub, art
// a scan found in a music file or beside it, and a cover already cached here.
// Left to probe, ffmpeg picks a demuxer from what the bytes look like, and a
// body starting "#EXTM3U" can reach a playlist demuxer, which opens the files
// and addresses the playlist names. ffmpeg's defaults refuse that today (a
// pipe's default protocol whitelist is crypto and data, and the HLS demuxer
// won't take a pipe without an .m3u8 name), but nothing Legato says did.
//
// So every one of those spawns passes -protocol_whitelist pipe, and names its
// demuxer from the bytes' magic number, checked here before ffmpeg starts.
// Bytes that aren't a picture this knows are refused without ffmpeg ever
// seeing them. Each demuxer is the one ffmpeg's own probe picks for that
// format, so a picture that worked before comes out byte for byte the same.
//
// The magic number rather than -f image2pipe alone: image2pipe still probes,
// across whichever image formats a given ffmpeg build reads, and refusing
// first is what lets a spec show ffmpeg never ran.
//
// A scan's art is the one exception. A music file's tags can carry another
// image format, such as a BMP in an old MP3, so art from the library that
// isn't one of these goes to -f image2pipe, which still only reads images.
// Nothing uploaded or downloaded gets that.

export type PipedImageSource = "outside" | "library";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// HEIF and AVIF share the mov demuxer with every MP4, M4A and QuickTime
// file, so only the major brand of a still image lets one through:
//   heic, heix  HEVC still images (an iPhone's or a Mac's photos are heic)
//   heim, heis  multi-layer and scalable HEVC still images
//   mif1        HEIF's generic still-image brand
//   avif        AVIF still images
// Anything else gets a 400 without ffmpeg starting: isom, mp41, mp42, M4A,
// M4V, qt and every other audio or video brand, and the image *sequence*
// brands (msf1, hevc, hevx, avis), which are animations, not pictures.
//
// Reading one also takes an ffmpeg that can, from a pipe, and builds differ.
// ffmpeg 9.0.2 (checked on a Mac, 2026-11-08) only reads a HEIF from a pipe
// when the whole file fits in its read
// buffer (a few tens of KB), and never a tiled one, the layout an iPhone
// writes. That's how it was before #477 too. Those fail in ffmpeg, and the
// upload routes answer 400 and ask for a JPEG or PNG.
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "mif1", "avif"]);

const ascii = (bytes: Buffer, start: number, end: number) => (bytes.length >= end ? bytes.toString("latin1", start, end) : "");

const FORMATS: { name: string; demuxer: string; matches: (bytes: Buffer) => boolean }[] = [
  // The start-of-image marker, then the next marker's 0xFF.
  { name: "JPEG", demuxer: "jpeg_pipe", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // An animated PNG is a PNG too; ffmpeg reads its first frame either way.
  { name: "PNG", demuxer: "png_pipe", matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE) },
  { name: "WebP", demuxer: "webp_pipe", matches: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  { name: "GIF", demuxer: "gif", matches: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a" },
  { name: "HEIF", demuxer: "mov", matches: (b) => ascii(b, 4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(b, 8, 12)) },
];

export const PIPED_IMAGE_FORMATS = FORMATS.map((format) => format.name);

export class NotAPictureError extends Error {}

// What an upload route answers, with a 400, when a picture couldn't be
// stored. Bytes refused before ffmpeg started aren't a picture this knows;
// anything else is a picture this server's ffmpeg couldn't read, such as a
// HEIC to a build that can't. Never a 500: either way it's the file.
export function unreadablePictureMessage(err: unknown): string {
  return err instanceof NotAPictureError
    ? "That file isn't a picture this server can read. Try a JPEG or PNG."
    : "This server couldn't read that picture's format. Try a JPEG or PNG.";
}

// The demuxer ffmpeg reads these bytes with, or null when they aren't a
// picture this knows.
export function pipedImageDemuxer(bytes: Buffer): string | null {
  return FORMATS.find((format) => format.matches(bytes))?.demuxer ?? null;
}

// ffmpeg's input arguments for a picture on stdin, in place of `-i pipe:0`.
// Throws NotAPictureError for bytes ffmpeg shouldn't be given at all.
export function pipedImageInput(bytes: Buffer, source: PipedImageSource = "outside"): string[] {
  const demuxer = pipedImageDemuxer(bytes) ?? (source === "library" ? "image2pipe" : null);
  if (!demuxer) throw new NotAPictureError(`that isn't a ${PIPED_IMAGE_FORMATS.join(", ")} picture`);
  return ["-protocol_whitelist", "pipe", "-f", demuxer, "-i", "pipe:0"];
}
