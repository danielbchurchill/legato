// Issue #120: the quality ladder. `original` is the source file
// itself, never transcoded; every other rung is one ffmpeg run, cached
// on disk under its own directory so a track heard at two qualities is two
// independent cache entries rather than one overwriting the other.
//
// `original-fmp4` (#408) is the original's own audio, not re-encoded, moved
// into fragmented MP4: what the web player on an iPhone feeds a
// ManagedMediaSource, which takes MP4 and not a FLAC file. `original` stays
// the source file byte for byte, which desktop playback reads (#185).
export const STREAM_QUALITIES = [
  "original",
  "original-fmp4",
  "opus96",
  "opus160",
  "opus256",
  "aac160",
  "aac256",
] as const;
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
// exists — Safari and iOS web (#120).
function opus(kbps: number): Variant {
  return {
    extension: "opus",
    contentType: "audio/ogg; codecs=opus",
    encoderArgs: ["-c:a", "libopus", "-b:a", `${kbps}k`, "-vbr", "on", "-f", "ogg"],
  };
}

// A source's chapters would go in as a second, text track, and a
// MediaSource's audio SourceBuffer takes one audio track (#408).
const FRAGMENTED_MP4 = [
  "-map_chapters",
  "-1",
  "-movflags",
  "+empty_moov+default_base_moof",
  "-frag_duration",
  "1000000",
  "-f",
  "mp4",
];

function aac(kbps: number): Variant {
  return {
    extension: "m4a",
    contentType: "audio/mp4",
    encoderArgs: ["-c:a", "aac", "-b:a", `${kbps}k`, ...FRAGMENTED_MP4],
  };
}

// A stream copy: the original's frames as they are, in one-second
// fragments. FFmpeg 5.1 (Debian bookworm's, which a Raspberry Pi runs)
// still calls FLAC in MP4 experimental and refuses it without -strict;
// 6.0 dropped that. The tags stay in the source, as the phone-tested
// prototype had it: the player only wants the audio.
const ORIGINAL_FMP4: Variant = {
  extension: "m4a",
  contentType: "audio/mp4",
  encoderArgs: ["-c:a", "copy", "-map_metadata", "-1", "-strict", "experimental", ...FRAGMENTED_MP4],
};

export const VARIANTS: Record<TranscodedQuality, Variant> = {
  "original-fmp4": ORIGINAL_FMP4,
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

// The rungs that are fragmented MP4, which GET /files/:id/stream/index can
// map for a MediaSource (stream/fragments.ts).
export const FRAGMENTED_QUALITIES: readonly TranscodedQuality[] = ["original-fmp4", "aac160", "aac256"];

export function isFragmentedQuality(value: unknown): value is TranscodedQuality {
  return typeof value === "string" && (FRAGMENTED_QUALITIES as readonly string[]).includes(value);
}

// The sources whose audio original-fmp4 can carry as it is, by extension as
// PASSTHROUGH_TYPES below reads them: FLAC, and the ALAC or AAC an .m4a
// holds. An MP3 or an Ogg file can't go through a MediaSource on iOS this
// way, so its player asks for an AAC rung instead.
const REMUXABLE = new Set([".flac", ".m4a", ".mp4"]);

export function canRemux(extension: string): boolean {
  return REMUXABLE.has(extension.toLowerCase());
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
