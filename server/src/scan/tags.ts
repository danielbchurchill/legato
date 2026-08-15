import { parseFile } from "music-metadata";
import type { ICommonTagsResult, IFormat } from "music-metadata";
import { pickFrontCover } from "../cover/extract.js";
import type { EmbeddedPicture } from "../cover/extract.js";

export type NormalizedTags = {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  mbRecordingId: string | null;
  mbReleaseId: string | null;
  mbArtistId: string | null;
  replaygainTrackGain: number | null;
  replaygainAlbumGain: number | null;
  durationMs: number | null;
  format: string | null;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  releaseDate: string | null;
  bpm: number | null;
  label: string | null;
  releaseType: string | null;
  genre: string[] | null;
};

// Split out from parseTags() so the mapping logic is unit-testable without
// needing a real audio file on disk — parseTags() is the thin I/O shell.
export function normalizeTags(common: ICommonTagsResult, format: IFormat): NormalizedTags {
  return {
    title: common.title ?? null,
    artist: common.artist ?? null,
    album: common.album ?? null,
    albumartist: common.albumartist ?? null,
    trackNo: common.track?.no ?? null,
    discNo: common.disk?.no ?? null,
    year: common.year ?? null,
    mbRecordingId: common.musicbrainz_recordingid ?? null,
    mbReleaseId: common.musicbrainz_albumid ?? null,
    mbArtistId: common.musicbrainz_artistid?.[0] ?? null,
    replaygainTrackGain: common.replaygain_track_gain?.dB ?? null,
    replaygainAlbumGain: common.replaygain_album_gain?.dB ?? null,
    durationMs: format.duration != null ? Math.round(format.duration * 1000) : null,
    format: format.container ?? null,
    bitrate: format.bitrate != null ? Math.round(format.bitrate) : null,
    sampleRate: format.sampleRate ?? null,
    channels: format.numberOfChannels ?? null,
    // releasedate/originaldate/date are three tiers of the same fact, most
    // specific first — a reissue usually only carries `date`, while a
    // MusicBrainz-tagged rip carries all three in agreement.
    releaseDate: common.releasedate ?? common.originaldate ?? common.date ?? null,
    bpm: common.bpm ?? null,
    label: common.label?.[0] ?? null,
    releaseType: common.releasetype?.[0] ?? null,
    genre: common.genre && common.genre.length > 0 ? common.genre : null,
  };
}

export type ParsedFile = {
  tags: NormalizedTags;
  /** Front cover carried inside the file, if any. Bytes, not a tag — kept out
   *  of NormalizedTags so tags_raw stays a small JSON blob. */
  picture: EmbeddedPicture | null;
};

export async function parseTags(filePath: string): Promise<ParsedFile> {
  const { common, format } = await parseFile(filePath, { duration: true });
  return {
    tags: normalizeTags(common, format),
    picture: pickFrontCover(common.picture),
  };
}
