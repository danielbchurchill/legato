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
    });
  });

  it("falls back to null for every field on an untagged file", () => {
    const result = normalizeTags(common(), format());

    expect(result.title).toBeNull();
    expect(result.artist).toBeNull();
    expect(result.mbRecordingId).toBeNull();
    expect(result.replaygainTrackGain).toBeNull();
    expect(result.durationMs).toBeNull();
  });

  it("rounds duration to milliseconds and bitrate to whole numbers", () => {
    const result = normalizeTags(common(), format({ duration: 1.2345, bitrate: 320123.7 }));
    expect(result.durationMs).toBe(1235);
    expect(result.bitrate).toBe(320124);
  });
});
