import { describe, expect, it } from "vitest";
import type { ICommonTagsResult, IFormat } from "music-metadata";
import { normalizeTags } from "./tags.js";

function common(overrides: Partial<ICommonTagsResult> = {}): ICommonTagsResult {
  return {
    track: { no: null, of: null },
    disk: { no: null, of: null },
    ...overrides,
  } as ICommonTagsResult;
}

function format(overrides: Partial<IFormat> = {}): IFormat {
  return { trackInfo: [], tagTypes: [], ...overrides } as IFormat;
}

describe("normalizeTags", () => {
  it("maps a fully-tagged file", () => {
    const result = normalizeTags(
      common({
        title: "Come Together",
        artist: "The Beatles",
        album: "Abbey Road",
        albumartist: "The Beatles",
        track: { no: 1, of: 17 },
        disk: { no: 1, of: 1 },
        year: 1969,
        musicbrainz_recordingid: "rec-123",
        musicbrainz_albumid: "rel-456",
        musicbrainz_artistid: ["artist-789"],
        replaygain_track_gain: { dB: -6.5, ratio: 0.5 },
        replaygain_album_gain: { dB: -5.2, ratio: 0.6 },
        releasedate: "1969-09-26",
        bpm: 82,
        label: ["Apple Records"],
        releasetype: ["album"],
        genre: ["Rock", "Psychedelic Rock"],
        producer: ["George Martin"],
        engineer: ["Geoff Emerick"],
        artists: ["The Beatles", "Billy Preston"],
      }),
      format({ duration: 259.5, container: "FLAC", bitrate: 1000000, sampleRate: 44100, numberOfChannels: 2 }),
    );

    expect(result).toEqual({
      title: "Come Together",
      artist: "The Beatles",
      album: "Abbey Road",
      albumartist: "The Beatles",
      trackNo: 1,
      discNo: 1,
      year: 1969,
      mbRecordingId: "rec-123",
      mbReleaseId: "rel-456",
      mbArtistId: "artist-789",
      replaygainTrackGain: -6.5,
      replaygainAlbumGain: -5.2,
      durationMs: 259500,
      format: "FLAC",
      bitrate: 1000000,
      sampleRate: 44100,
      channels: 2,
      releaseDate: "1969-09-26",
      pressingDate: null,
      bpm: 82,
      label: "Apple Records",
      releaseType: "album",
      genre: ["Rock", "Psychedelic Rock"],
      producer: ["George Martin"],
      engineer: ["Geoff Emerick"],
      featuredArtists: ["Billy Preston"],
    });
  });

  it("falls back to null for every field on an untagged file", () => {
    const result = normalizeTags(common(), format());

    expect(result.title).toBeNull();
    expect(result.artist).toBeNull();
    expect(result.mbRecordingId).toBeNull();
    expect(result.replaygainTrackGain).toBeNull();
    expect(result.durationMs).toBeNull();
    expect(result.releaseDate).toBeNull();
    expect(result.pressingDate).toBeNull();
    expect(result.bpm).toBeNull();
    expect(result.label).toBeNull();
    expect(result.releaseType).toBeNull();
    expect(result.genre).toBeNull();
    expect(result.producer).toBeNull();
    expect(result.engineer).toBeNull();
    expect(result.featuredArtists).toBeNull();
  });

  it("derives featuredArtists as every credited artist except the primary", () => {
    const withFeature = normalizeTags(
      common({ artist: "The Beatles", artists: ["The Beatles", "Billy Preston"] }),
      format(),
    );
    expect(withFeature.featuredArtists).toEqual(["Billy Preston"]);

    const soloOnly = normalizeTags(common({ artist: "The Beatles", artists: ["The Beatles"] }), format());
    expect(soloOnly.featuredArtists).toBeNull();

    const noArtistsField = normalizeTags(common({ artist: "The Beatles" }), format());
    expect(noArtistsField.featuredArtists).toBeNull();
  });

  it("falls back through originaldate -> releasedate -> date -> year (M-7: original release wins)", () => {
    expect(normalizeTags(common({ releasedate: "1969-09-26" }), format()).releaseDate).toBe("1969-09-26");
    expect(normalizeTags(common({ date: "1969" }), format()).releaseDate).toBe("1969");
    expect(normalizeTags(common({ year: 1969 }), format()).releaseDate).toBe("1969");
    // The case M-7 exists for: a reissue's `date` disagreeing with the
    // original pressing. originaldate wins regardless of what else is set.
    expect(
      normalizeTags(common({ releasedate: "1983-01-01", originaldate: "1969-09-26", date: "1983" }), format())
        .releaseDate,
    ).toBe("1969-09-26");
  });

  it("keeps the pressing date as its own fact rather than collapsing it into releaseDate", () => {
    const result = normalizeTags(
      common({ originaldate: "1969-09-26", date: "1983", releasedate: "1983-01-01" }),
      format(),
    );
    expect(result.releaseDate).toBe("1969-09-26");
    expect(result.pressingDate).toBe("1983");
  });

  it("rounds duration to milliseconds and bitrate to whole numbers", () => {
    const result = normalizeTags(common(), format({ duration: 1.2345, bitrate: 320123.7 }));
    expect(result.durationMs).toBe(1235);
    expect(result.bitrate).toBe(320124);
  });
});
