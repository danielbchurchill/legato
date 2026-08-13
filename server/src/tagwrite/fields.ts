import type { Tag } from "node-taglib-sharp";

// The write-back API's field vocabulary — title/artist/album/year/trackNo
// — mapped onto TagLib#'s tag-agnostic model. "artist" is a single string
// here (matching music-metadata's parsing and Legato's own tags_raw shape)
// even though TagLib# models it as performers: string[]; a single-artist
// write is the only case the write-back UI needs for v1.
export type TagFields = {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  trackNo?: number;
};

export function readFields(tag: Tag): Required<TagFields> {
  return {
    title: tag.title ?? "",
    artist: tag.performers?.[0] ?? "",
    album: tag.album ?? "",
    year: tag.year ?? 0,
    trackNo: tag.track ?? 0,
  };
}

export function writeFields(tag: Tag, changes: TagFields): void {
  if (changes.title !== undefined) tag.title = changes.title;
  if (changes.artist !== undefined) tag.performers = [changes.artist];
  if (changes.album !== undefined) tag.album = changes.album;
  if (changes.year !== undefined) tag.year = changes.year;
  if (changes.trackNo !== undefined) tag.track = changes.trackNo;
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
