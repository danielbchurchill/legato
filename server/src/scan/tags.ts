import { parseFile } from "music-metadata";
import type { ICommonTagsResult, IFormat } from "music-metadata";
import { extraCreditedArtists } from "./artist-credit.js";
import { pickFrontCover } from "../cover/extract.js";
import type { EmbeddedPicture } from "../cover/extract.js";

export type NormalizedTags = {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  trackNo: number | null;
  // "N of M" — M-2's release-scoped MusicBrainz query boost needs the
  // total, not just this track's own position.
  totalTracks: number | null;
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
  // "date" specifically — a reissue/remaster pressing's own date, kept
  // distinct from releaseDate rather than collapsed into it (M-7). Picard
  // keeps these as two separate facts for the same reason: "when was this
  // pressed" and "when was this music made" routinely disagree, and
  // whichever one wins a merged field is lost for good.
  pressingDate: string | null;
  bpm: number | null;
  label: string | null;
  releaseType: string | null;
  genre: string[] | null;
  producer: string[] | null;
  engineer: string[] | null;
  // Every credited artist (music-metadata's `artists`, not the primary
  // `artist`), minus everyone the ARTIST credit already names — the
  // "featured artist" credits. No dedicated tag exists for "featured"
  // specifically; this is the standard proxy every tagger (including
  // MusicBrainz Picard) uses for it. See scan/artist-credit.ts for why the
  // subtraction is by mention rather than exact string equality.
  featuredArtists: string[] | null;
  // The same list whole, when it names more than one artist. Issue #273:
  // it's the evidence that splits an ARTIST of "Cage The Elephant, Alison
  // Mosshart" into two artists, and featuredArtists has already dropped
  // both of them for being mentioned in the credit. The key is written
  // even when null, which is how enrich/artistCredit.ts tells a file read
  // since this field existed from one that needs reading again.
  artists: string[] | null;
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
    totalTracks: common.track?.of ?? null,
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
    // originaldate first, not releasedate: "when was this music made" is
    // the fact the canvas layout and the metadata panel both actually want
    // (M-7) — a Mobile Fidelity reissue's `date` disagreeing with the
    // original 1969 pressing is exactly the case that matters, and the
    // original should win. Falls through to the bare `year` field for
    // files with no date-string tag at all (still bucket-only, e.g. a
    // TDRC/YEAR-only ID3 tag).
    releaseDate: common.originaldate ?? common.releasedate ?? common.date ?? (common.year != null ? String(common.year) : null),
    pressingDate: common.date ?? null,
    bpm: common.bpm ?? null,
    label: common.label?.[0] ?? null,
    releaseType: common.releasetype?.[0] ?? null,
    genre: common.genre && common.genre.length > 0 ? common.genre : null,
    producer: common.producer && common.producer.length > 0 ? common.producer : null,
    engineer: common.engineer && common.engineer.length > 0 ? common.engineer : null,
    featuredArtists: emptyToNull(extraCreditedArtists(common.artist, common.artists)),
    artists: common.artists && common.artists.length > 1 ? common.artists : null,
  };
}

function emptyToNull(list: string[]): string[] | null {
  return list.length > 0 ? list : null;
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
