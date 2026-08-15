import type { FlacTag, Tag } from "node-taglib-sharp";

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
};

// discNo/genre go through TagLib#'s named Tag properties (tag.disc,
// tag.genres) since those already read/write the same Vorbis fields
// (DISCNUMBER, GENRE) that scan/tags.ts's normalizeTags reads via
// music-metadata — a write through either path round-trips through the
// other cleanly.
//
// bpm/label/releaseType do NOT go through TagLib#'s equivalent named
// properties (tag.beatsPerMinute, tag.publisher, tag.musicBrainzReleaseType)
// — each of those defaults to a *different* Vorbis field than the one
// music-metadata actually reads (TEMPO vs BPM, ORGANIZATION vs LABEL,
// MUSICBRAINZ_ALBUMTYPE vs RELEASETYPE). Writing through the named property
// would produce a value this app's own next scan could never read back, so
// these three go straight at the Vorbis comment field music-metadata
// expects instead.
function xiphComment(tag: Tag): FlacTag["xiphComment"] {
  return (tag as unknown as FlacTag).xiphComment;
}

export function readFields(tag: Tag): Required<TagFields> {
  const bpmText = xiphComment(tag).getFieldFirstValue("BPM");
  const bpm = bpmText ? Number.parseInt(bpmText, 10) : 0;

  return {
    title: tag.title ?? "",
    artist: tag.performers?.[0] ?? "",
    album: tag.album ?? "",
    year: tag.year ?? 0,
    trackNo: tag.track ?? 0,
    discNo: tag.disc ?? 0,
    genre: tag.genres ?? [],
    bpm: Number.isNaN(bpm) ? 0 : bpm,
    label: xiphComment(tag).getFieldFirstValue("LABEL") || "",
    releaseType: xiphComment(tag).getFieldFirstValue("RELEASETYPE") || "",
  };
}

export function writeFields(tag: Tag, changes: TagFields): void {
  if (changes.title !== undefined) tag.title = changes.title;
  if (changes.artist !== undefined) tag.performers = [changes.artist];
  if (changes.album !== undefined) tag.album = changes.album;
  if (changes.year !== undefined) tag.year = changes.year;
  if (changes.trackNo !== undefined) tag.track = changes.trackNo;
  if (changes.discNo !== undefined) tag.disc = changes.discNo;
  if (changes.genre !== undefined) tag.genres = changes.genre;
  if (changes.bpm !== undefined) xiphComment(tag).setFieldAsUint("BPM", changes.bpm);
  if (changes.label !== undefined) xiphComment(tag).setFieldAsStrings("LABEL", changes.label);
  if (changes.releaseType !== undefined) xiphComment(tag).setFieldAsStrings("RELEASETYPE", changes.releaseType);
}

// FLAC-only for v1 — the format the real library actually consists of.
// node-taglib-sharp supports MP3/MP4/OGG too, but each has a different
// custom-field mechanism (or none at all — ID3v2 has no equivalent of a
// free-form Vorbis comment key) for the write-marker, unexercised by any
// real data yet. Extending this is a narrow, format-specific follow-up,
// not a blocker for the write-back mechanism itself.
export function assertFlac(filePath: string): void {
  if (!filePath.toLowerCase().endsWith(".flac")) {
    throw new Error(`tag write-back only supports FLAC for now, got: ${filePath}`);
  }
}
