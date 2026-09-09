import {
  Id3v2FrameClassType,
  Id3v2FrameIdentifiers,
  Id3v2UserTextInformationFrame,
  TagTypes,
} from "node-taglib-sharp";
import type { CombinedTag, FlacTag, Id3v2Tag, Mpeg4AppleTag, Tag } from "node-taglib-sharp";

// The write-back API's field vocabulary, mapped onto TagLib#'s tag-agnostic
// model. "artist" is a single string here (matching music-metadata's
// parsing and Legato's own tags_raw shape) even though TagLib# models it as
// performers: string[]; a single-artist write is the only case the
// write-back UI needs for v1. "genre" is an array to match tags_raw's own
// convention (scan/tags.ts) rather than the single-string fields around it.
export type TagFields = {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  trackNo?: number;
  discNo?: number;
  genre?: string[];
  bpm?: number;
  label?: string;
  releaseType?: string;
  // "when was this music made," matching scan/tags.ts's own priority
  // (originaldate ?? releasedate ?? date) — writes and reads the
  // originaldate-equivalent field per format so a write here is picked up
  // as release_date by the very next scan, not shadowed by a DATE/TDRC
  // tag the file already carries.
  releaseDate?: string;
};

export type AudioFormat = "flac" | "mp3" | "mp4";

// Matches scan/walk.ts's AUDIO_EXTENSIONS for the extensions this actually
// recognizes as MP3/MP4 containers (.m4a is the real-world extension for
// the MP4/AAC files this library has; .mp4 is accepted too since
// node-taglib-sharp opens both identically as an Mpeg4File).
export function detectFormat(filePath: string): AudioFormat {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".flac")) return "flac";
  if (lower.endsWith(".mp3")) return "mp3";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "mp4";
  throw new Error(`tag write-back only supports FLAC, MP3, and MP4/M4A files, got: ${filePath}`);
}

const WRITE_MARKER_FIELD = "LEGATO_WRITE_ID";
const ITUNES_MEAN = "com.apple.iTunes";

function xiphComment(tag: Tag): FlacTag["xiphComment"] {
  return (tag as unknown as FlacTag).xiphComment;
}

// Id3v2 lives inside a SandwichTag (a CombinedTag also covering Id3v1/APEv2,
// whichever of those the file happens to carry) — an MP3 with no ID3v2
// block yet has no Id3v2Tag until one is created. getTag() only looks;
// createTag() is the (also public) TagLib# entry point that actually adds
// one. Read paths must never create a block just by looking at a file, so
// the two are kept separate rather than always-create.
function existingId3v2Tag(tag: Tag): Id3v2Tag | undefined {
  return (tag as unknown as CombinedTag).getTag<Id3v2Tag>(TagTypes.Id3v2);
}

function getOrCreateId3v2Tag(tag: Tag): Id3v2Tag {
  const combined = tag as unknown as CombinedTag;
  return combined.getTag<Id3v2Tag>(TagTypes.Id3v2) ?? (combined.createTag(TagTypes.Id3v2, false) as Id3v2Tag);
}

function appleTag(tag: Tag): Mpeg4AppleTag {
  return tag as unknown as Mpeg4AppleTag;
}

function findUserTextFrame(id3: Id3v2Tag, description: string): Id3v2UserTextInformationFrame | undefined {
  const frames = id3.getFramesByClassType<Id3v2UserTextInformationFrame>(
    Id3v2FrameClassType.UserTextInformationFrame,
  );
  return Id3v2UserTextInformationFrame.findUserTextInformationFrame(frames, description, true);
}

// bpm/label/releaseType are handled per format below rather than through a
// single shared code path — verified against what music-metadata (this
// app's own tag reader) actually reads back for each container, not
// assumed from TagLib#'s API surface. FLAC's case is the one that already
// bit this project once (see git history / writer.spec.ts): TagLib#'s named
// properties (beatsPerMinute/publisher/musicBrainzReleaseType) default to
// different Vorbis fields than the ones music-metadata reads (TEMPO vs BPM,
// ORGANIZATION vs LABEL, MUSICBRAINZ_ALBUMTYPE vs RELEASETYPE), so FLAC
// writes the raw Vorbis comment fields directly instead.
//
// ID3v2 (MP3) turned out fine: TagLib#'s beatsPerMinute -> TBPM,
// publisher -> TPUB, musicBrainzReleaseType -> TXXX:"MusicBrainz Album
// Type" are exactly the frames music-metadata's ID3v24TagMapper maps to
// bpm/label/releasetype. Confirmed by writing via these named properties
// and reading the result back through music-metadata (writer.mp3.spec.ts).
//
// MP4/M4A repeats the FLAC-style bug for exactly one field: TagLib#'s
// `publisher` writes a `----:com.apple.iTunes:publisher` freeform atom, but
// music-metadata's MP4TagMapper only recognizes
// `----:com.apple.iTunes:LABEL` as 'label' — a value written through the
// named property would silently vanish on the app's own next scan. Written
// directly via setItunesStrings(..., "LABEL", ...) instead.
// beatsPerMinute (tmpo atom) and musicBrainzReleaseType
// (`----:com.apple.iTunes:MusicBrainz Album Type`) both matched
// music-metadata's expectations and go through the named properties.
//
// releaseDate follows the same per-format verification: FLAC's raw Vorbis
// "ORIGINALDATE" field, ID3v2's TDOR ("original release time") text frame,
// and MP4's `----:com.apple.iTunes:ORIGINALDATE` freeform atom are exactly
// what music-metadata's VorbisTagMapper/ID3v24TagMapper/MP4TagMapper each
// map to 'originaldate' — the field scan/tags.ts checks first when it
// derives release_date.
export function readFields(tag: Tag, format: AudioFormat): Required<TagFields> {
  const base = {
    title: tag.title ?? "",
    artist: tag.performers?.[0] ?? "",
    album: tag.album ?? "",
    year: tag.year ?? 0,
    trackNo: tag.track ?? 0,
    discNo: tag.disc ?? 0,
    genre: tag.genres ?? [],
  };

  if (format === "flac") {
    const bpmText = xiphComment(tag).getFieldFirstValue("BPM");
    const bpm = bpmText ? Number.parseInt(bpmText, 10) : 0;
    return {
      ...base,
      bpm: Number.isNaN(bpm) ? 0 : bpm,
      label: xiphComment(tag).getFieldFirstValue("LABEL") || "",
      releaseType: xiphComment(tag).getFieldFirstValue("RELEASETYPE") || "",
      releaseDate: xiphComment(tag).getFieldFirstValue("ORIGINALDATE") || "",
    };
  }

  if (format === "mp3") {
    const id3 = existingId3v2Tag(tag);
    return {
      ...base,
      bpm: id3?.beatsPerMinute || 0,
      label: id3?.publisher || "",
      releaseType: id3?.musicBrainzReleaseType || "",
      releaseDate: (id3 && id3.getTextAsString(Id3v2FrameIdentifiers.TDOR)) || "",
    };
  }

  const apple = appleTag(tag);
  return {
    ...base,
    bpm: apple.beatsPerMinute || 0,
    label: apple.getFirstItunesString(ITUNES_MEAN, "LABEL") || "",
    releaseType: apple.musicBrainzReleaseType || "",
    releaseDate: apple.getFirstItunesString(ITUNES_MEAN, "ORIGINALDATE") || "",
  };
}

export function writeFields(tag: Tag, changes: TagFields, format: AudioFormat): void {
  if (changes.title !== undefined) tag.title = changes.title;
  if (changes.artist !== undefined) tag.performers = [changes.artist];
  if (changes.album !== undefined) tag.album = changes.album;
  if (changes.year !== undefined) tag.year = changes.year;
  if (changes.trackNo !== undefined) tag.track = changes.trackNo;
  if (changes.discNo !== undefined) tag.disc = changes.discNo;
  if (changes.genre !== undefined) tag.genres = changes.genre;

  if (format === "flac") {
    if (changes.bpm !== undefined) xiphComment(tag).setFieldAsUint("BPM", changes.bpm);
    if (changes.label !== undefined) xiphComment(tag).setFieldAsStrings("LABEL", changes.label);
    if (changes.releaseType !== undefined) xiphComment(tag).setFieldAsStrings("RELEASETYPE", changes.releaseType);
    if (changes.releaseDate !== undefined) xiphComment(tag).setFieldAsStrings("ORIGINALDATE", changes.releaseDate);
    return;
  }

  if (format === "mp3") {
    const id3 = getOrCreateId3v2Tag(tag);
    if (changes.bpm !== undefined) id3.beatsPerMinute = changes.bpm;
    if (changes.label !== undefined) id3.publisher = changes.label;
    if (changes.releaseType !== undefined) id3.musicBrainzReleaseType = changes.releaseType;
    if (changes.releaseDate !== undefined) id3.setTextFrame(Id3v2FrameIdentifiers.TDOR, changes.releaseDate);
    return;
  }

  const apple = appleTag(tag);
  if (changes.bpm !== undefined) apple.beatsPerMinute = changes.bpm;
  if (changes.label !== undefined) apple.setItunesStrings(ITUNES_MEAN, "LABEL", changes.label);
  if (changes.releaseType !== undefined) apple.musicBrainzReleaseType = changes.releaseType;
  if (changes.releaseDate !== undefined) apple.setItunesStrings(ITUNES_MEAN, "ORIGINALDATE", changes.releaseDate);
}

// The written_by_app guard marker (see guard.ts) needs a real mechanism per
// format: FLAC has a free-form Vorbis comment key, MP4/atom has free-form
// "----" atoms namespaced under a mean/name pair (same mechanism LABEL
// uses above), and ID3v2 has no free-form text frame of its own — TXXX is
// the standard mechanism for exactly this, a text frame keyed by a
// caller-chosen description rather than a fixed 4-character ID.
export function getWriteMarker(tag: Tag, format: AudioFormat): string | null {
  if (format === "flac") {
    return xiphComment(tag).getFieldFirstValue(WRITE_MARKER_FIELD) || null;
  }

  if (format === "mp3") {
    const id3 = existingId3v2Tag(tag);
    if (!id3) return null;
    const frame = findUserTextFrame(id3, WRITE_MARKER_FIELD);
    return frame?.text[0] || null;
  }

  return appleTag(tag).getFirstItunesString(ITUNES_MEAN, WRITE_MARKER_FIELD) || null;
}

export function setWriteMarker(tag: Tag, format: AudioFormat, writeId: string): void {
  if (format === "flac") {
    xiphComment(tag).setFieldAsStrings(WRITE_MARKER_FIELD, writeId);
    return;
  }

  if (format === "mp3") {
    const id3 = getOrCreateId3v2Tag(tag);
    let frame = findUserTextFrame(id3, WRITE_MARKER_FIELD);
    if (!frame) {
      frame = Id3v2UserTextInformationFrame.fromDescription(WRITE_MARKER_FIELD);
      id3.addFrame(frame);
    }
    frame.text = [writeId];
    return;
  }

  appleTag(tag).setItunesStrings(ITUNES_MEAN, WRITE_MARKER_FIELD, writeId);
}
