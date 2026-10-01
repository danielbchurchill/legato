// Issue #120 / D13: the quality ladder (docs/plans/03-connection-and-
// streaming.md, "Quality ladder (G12)"). `original` is the source file
// itself, never transcoded; every other rung is one ffmpeg encode, cached
// on disk under its own directory so a track heard at two qualities is two
// independent cache entries rather than one overwriting the other.
export const STREAM_QUALITIES = ["original", "opus96", "opus160", "opus256", "aac160", "aac256"] as const;
export type StreamQuality = (typeof STREAM_QUALITIES)[number];
export type TranscodedQuality = Exclude<StreamQuality, "original">;

export type Variant = {
  // Extension of the cached file, which is also what the sweep reads back
  // to tell a finished variant from a `.tmp` an interrupted encode left.
  extension: string;
  contentType: string;
  // Everything between `-i <source>` and the output target.
  encoderArgs: string[];
};

// Both containers are chosen because they can be read while ffmpeg is
// still writing them — the response starts before the encode finishes
// (TTFA, see stream/transcode.ts). Ogg is a stream format by design. Plain
// MP4 is not: ffmpeg writes its index (the moov atom) last, so nothing can
// play until the whole file exists. Fragmented MP4 (`empty_moov` up front,
// then self-describing one-second fragments) is the form Safari's media
// engine accepts progressively, and AAC is the whole reason this rung
// exists — Safari and iOS web, per the plan's table.
function opus(kbps: number): Variant {
  return {
    extension: "opus",
    contentType: "audio/ogg; codecs=opus",
    encoderArgs: ["-c:a", "libopus", "-b:a", `${kbps}k`, "-vbr", "on", "-f", "ogg"],
  };
}

function aac(kbps: number): Variant {
  return {
    extension: "m4a",
    contentType: "audio/mp4",
    encoderArgs: [
      "-c:a",
      "aac",
      "-b:a",
      `${kbps}k`,
      "-movflags",
      "+empty_moov+default_base_moof",
      "-frag_duration",
      "1000000",
      "-f",
      "mp4",
    ],
  };
}

export const VARIANTS: Record<TranscodedQuality, Variant> = {
  opus96: opus(96),
  opus160: opus(160),
  opus256: opus(256),
  aac160: aac(160),
  aac256: aac(256),
};

export function isStreamQuality(value: unknown): value is StreamQuality {
  return typeof value === "string" && (STREAM_QUALITIES as readonly string[]).includes(value);
}

export function isTranscodedQuality(value: string): value is TranscodedQuality {
  return Object.hasOwn(VARIANTS, value);
}

// Content-Type for `original` passthrough, keyed on the source's own
// extension. The real library is all FLAC; the rest are what the scanner
// also accepts, so a mixed library still gets a type the browser can act on
// instead of a blanket octet-stream it will refuse to decode.
const PASSTHROUGH_TYPES: Record<string, string> = {
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
};

export function passthroughContentType(extension: string): string {
  return PASSTHROUGH_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
}
