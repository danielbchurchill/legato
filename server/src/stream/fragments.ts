import { open, type FileHandle } from "node:fs/promises";

// #408: the layout of a fragmented MP4 rung, for the web player that feeds
// one MediaSource a fragment at a time. A scrub to 3:00 appends the init
// segment, then starts from the fragment holding 3:00, fetched with a Range
// request. Only the server can say where that fragment starts before the
// client has the bytes before it: each fragment's offset depends on the size
// of every one ahead of it. So the index is read here, from the finished
// file, and the client never has to download a track to find its way round
// it.
//
// The codec string comes from the same bytes, from the audio track's sample
// entry, so what the client hands addSourceBuffer is what the file holds:
// "fLaC" (iOS refuses "flac"), "alac", "mp4a.40.2".
export type FragmentIndex = {
  /** The RFC 6381 codec string for `audio/mp4; codecs="…"`. */
  codecs: string;
  /** The init segment (ftyp and moov) is bytes [0, initEnd). */
  initEnd: number;
  /** Each fragment's offset (its moof) and its start in seconds, from the
   * first fragment's. A fragment runs to the next one's offset. */
  fragments: { offset: number; time: number }[];
  /** Where the last fragment's media ends. What follows (ffmpeg's mfra) is
   * an index for players that seek in a file, not audio. */
  end: number;
};

type Box = { type: string; start: number; headerSize: number; size: number };

// Generous bounds for the two boxes read whole. An empty_moov init segment
// is about a kilobyte, and a one-second audio fragment's moof a few hundred
// bytes; anything near these is a file this isn't for.
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const MAX_MOOF_BYTES = 4 * 1024 * 1024;

// A box's header, read from `bytes` at index `i`, for a box that starts at
// `start` in its file and has to end by `limit`. Inside a box read whole the
// two positions are the same; at the top level only the header is read.
function header(bytes: Buffer, i: number, start: number, limit: number): Box {
  if (start + 8 > limit || i + 8 > bytes.length) throw new Error(`truncated box header at ${start}`);
  let size = bytes.readUInt32BE(i);
  const type = bytes.toString("latin1", i + 4, i + 8);
  let headerSize = 8;
  if (size === 1) {
    if (i + 16 > bytes.length) throw new Error(`truncated ${type} header at ${start}`);
    size = Number(bytes.readBigUInt64BE(i + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit - start;
  }
  if (size < headerSize || start + size > limit) throw new Error(`malformed ${type} box at ${start}`);
  return { type, start, headerSize, size };
}

function boxAt(bytes: Buffer, at: number, limit: number): Box {
  return header(bytes, at, at, limit);
}

function* children(bytes: Buffer, parent: Box, skip = 0): Generator<Box> {
  const limit = parent.start + parent.size;
  for (let at = parent.start + parent.headerSize + skip; at + 8 <= limit;) {
    const box = boxAt(bytes, at, limit);
    yield box;
    at += box.size;
  }
}

function child(bytes: Buffer, parent: Box, type: string, skip = 0): Box | null {
  for (const box of children(bytes, parent, skip)) if (box.type === type) return box;
  return null;
}

function descend(bytes: Buffer, parent: Box, ...types: string[]): Box | null {
  let box: Box | null = parent;
  for (const type of types) {
    if (!box) return null;
    box = child(bytes, box, type);
  }
  return box;
}

function body(box: Box): number {
  return box.start + box.headerSize;
}

// An MPEG-4 descriptor's tag and length (ISO 14496-1 8.3.3): the length is
// up to four bytes of seven bits each.
function descriptor(bytes: Buffer, at: number): { tag: number; start: number; size: number } {
  const tag = bytes[at];
  let size = 0;
  let i = at + 1;
  for (let n = 0; n < 4; n++, i++) {
    size = (size << 7) | (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      i++;
      break;
    }
  }
  return { tag, start: i, size };
}

// mp4a's codec string from its esds: "mp4a.40.<audio object type>" for
// MPEG-4 audio (2 is AAC-LC), or "mp4a.<object type>" for anything else
// carried in an mp4a entry (6B is MP3).
function mp4aCodecs(bytes: Buffer, esds: Box): string {
  // A full box: version and flags, then the ES descriptor.
  const es = descriptor(bytes, body(esds) + 4);
  if (es.tag !== 0x03) throw new Error("esds without an ES descriptor");
  const flags = bytes[es.start + 2];
  let at = es.start + 3;
  if (flags & 0x80) at += 2; // streamDependenceFlag: dependsOn_ES_ID
  if (flags & 0x40) at += 1 + bytes[at]; // URL_Flag: URLlength, URLstring
  if (flags & 0x20) at += 2; // OCRstreamFlag: OCR_ES_Id
  const config = descriptor(bytes, at);
  if (config.tag !== 0x04) throw new Error("esds without a decoder config descriptor");
  const objectType = bytes[config.start];
  if (objectType !== 0x40) return `mp4a.${objectType.toString(16).toUpperCase()}`;
  // objectTypeIndication, streamType, bufferSizeDB, maxBitrate, avgBitrate.
  const specific = descriptor(bytes, config.start + 13);
  if (specific.tag !== 0x05) throw new Error("esds without an AudioSpecificConfig");
  let audioObjectType = bytes[specific.start] >> 3;
  if (audioObjectType === 31)
    audioObjectType = 32 + (((bytes[specific.start] & 0x07) << 3) | (bytes[specific.start + 1] >> 5));
  return `mp4a.40.${audioObjectType}`;
}

// The sample entry's own four-character code is the codec string for every
// codec here but mp4a. FLAC's is "fLaC", case and all.
function sampleEntryCodecs(bytes: Buffer, entry: Box): string {
  switch (entry.type) {
    case "mp4a": {
      // An AudioSampleEntry's fixed fields take 28 bytes. QuickTime's sound
      // description versions 1 and 2 add 16 and 36; the version is the
      // first field after the data reference index.
      const version = bytes.readUInt16BE(body(entry) + 8);
      const fixed = 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
      const wave = child(bytes, entry, "wave", fixed);
      const esds = child(bytes, entry, "esds", fixed) ?? (wave && child(bytes, wave, "esds"));
      if (!esds) throw new Error("mp4a sample entry without an esds");
      return mp4aCodecs(bytes, esds);
    }
    case "Opus":
      return "opus";
    default:
      return entry.type;
  }
}

type AudioTrack = { id: number; timescale: number; codecs: string };

function audioTrack(moov: Buffer): AudioTrack {
  const root = boxAt(moov, 0, moov.length);
  for (const trak of children(moov, root)) {
    if (trak.type !== "trak") continue;
    const mdia = child(moov, trak, "mdia");
    const hdlr = mdia && child(moov, mdia, "hdlr");
    // version and flags, pre_defined, then handler_type.
    if (!mdia || !hdlr || moov.toString("latin1", body(hdlr) + 8, body(hdlr) + 12) !== "soun") continue;

    const tkhd = child(moov, trak, "tkhd");
    const mdhd = child(moov, mdia, "mdhd");
    const stsd = descend(moov, mdia, "minf", "stbl", "stsd");
    if (!tkhd || !mdhd || !stsd) throw new Error("audio track without tkhd, mdhd or stsd");
    // Both are full boxes whose version 1 widens the times before the field
    // read here to 64 bits.
    const tkhdVersion = moov[body(tkhd)];
    const id = moov.readUInt32BE(body(tkhd) + 4 + (tkhdVersion === 1 ? 16 : 8));
    const mdhdVersion = moov[body(mdhd)];
    const timescale = moov.readUInt32BE(body(mdhd) + 4 + (mdhdVersion === 1 ? 16 : 8));
    // version and flags, entry_count, then the first sample entry.
    const entry = boxAt(moov, body(stsd) + 8, stsd.start + stsd.size);
    return { id, timescale, codecs: sampleEntryCodecs(moov, entry) };
  }
  throw new Error("no audio track");
}

// The decode time of the audio track's fragment in this moof.
function fragmentDecodeTime(moof: Buffer, trackId: number): number {
  const root = boxAt(moof, 0, moof.length);
  for (const traf of children(moof, root)) {
    if (traf.type !== "traf") continue;
    const tfhd = child(moof, traf, "tfhd");
    // version and flags, then track_ID.
    if (!tfhd || moof.readUInt32BE(body(tfhd) + 4) !== trackId) continue;
    const tfdt = child(moof, traf, "tfdt");
    if (!tfdt) throw new Error("fragment without a tfdt");
    return moof[body(tfdt)] === 1 ? Number(moof.readBigUInt64BE(body(tfdt) + 4)) : moof.readUInt32BE(body(tfdt) + 4);
  }
  throw new Error(`fragment without track ${trackId}`);
}

// The whole of a box, read back so its own start is index 0.
async function readBox(handle: FileHandle, box: Box, limit: number): Promise<Buffer> {
  if (box.size > limit) throw new Error(`${box.type} box of ${box.size} bytes is too big`);
  const bytes = Buffer.alloc(box.size);
  const { bytesRead } = await handle.read(bytes, 0, box.size, box.start);
  if (bytesRead !== box.size) throw new Error(`short read of ${box.type} at ${box.start}`);
  return bytes;
}

/** The codec string of a fragmented MP4, from the bytes at its start: the
 * moov, which empty_moov puts straight after the ftyp, so it's there as
 * soon as the encode has written anything. `chunks` is the file from its
 * first byte, a finished one or an encode still being written
 * (cache.ts's readGrowing); reading stops at the end of the moov. */
export async function readCodecs(chunks: AsyncIterable<Buffer>): Promise<string> {
  let bytes = Buffer.alloc(0);
  for await (const chunk of chunks) {
    bytes = Buffer.concat([bytes, chunk]);
    for (let at = 0; at + 16 <= bytes.length;) {
      // The box's own size, not checked against what's arrived so far.
      const box = header(bytes, at, at, Number.MAX_SAFE_INTEGER);
      if (box.type === "moof" || box.type === "mdat") throw new Error("fragment before the moov");
      if (box.type === "moov") {
        if (box.size > MAX_MOOV_BYTES) throw new Error(`moov box of ${box.size} bytes is too big`);
        if (at + box.size > bytes.length) break;
        return audioTrack(bytes.subarray(at, at + box.size)).codecs;
      }
      at += box.size;
    }
  }
  throw new Error("no moov");
}

/** The fragment index of a finished fragmented MP4 file. Throws on a file
 * that isn't one: no moov before the first fragment, no audio track, or a
 * fragment without a decode time. */
export async function readFragmentIndex(filePath: string): Promise<FragmentIndex> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const bytes = Buffer.alloc(16);
    let track: AudioTrack | null = null;
    let initEnd = 0;
    let end = 0;
    let firstDecodeTime: number | null = null;
    const fragments: FragmentIndex["fragments"] = [];

    for (let at = 0; at + 8 <= size;) {
      const { bytesRead } = await handle.read(bytes, 0, 16, at);
      const box = header(bytes.subarray(0, bytesRead), 0, at, size);
      if (box.type === "moov") {
        track = audioTrack(await readBox(handle, box, MAX_MOOV_BYTES));
        initEnd = at + box.size;
      } else if (box.type === "moof") {
        if (!track) throw new Error("fragment before the moov");
        const decodeTime = fragmentDecodeTime(await readBox(handle, box, MAX_MOOF_BYTES), track.id);
        firstDecodeTime ??= decodeTime;
        fragments.push({ offset: at, time: (decodeTime - firstDecodeTime) / track.timescale });
      } else if (box.type === "mdat" && fragments.length > 0) {
        end = at + box.size;
      }
      at += box.size;
    }

    if (!track) throw new Error("no moov");
    if (fragments.length === 0) throw new Error("no fragments");
    return { codecs: track.codecs, initEnd, fragments, end };
  } finally {
    await handle.close();
  }
}
