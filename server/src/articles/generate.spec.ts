import { describe, expect, it } from "bun:test";
import {
  generateArtistArticle,
  generateCreditArticle,
  generateLabelArticle,
  generateRecordingArticle,
  generateReleaseArticle,
} from "./generate.js";

describe("generateRecordingArticle", () => {
  it("weaves performer/release/label/credits into linked prose", () => {
    const article = generateRecordingArticle({
      artist: { id: 1, title: "The Beatles" },
      release: { id: 2, title: "Abbey Road" },
      year: 1969,
      label: { id: 3, title: "Apple Records" },
      producers: [{ id: 4, title: "George Martin" }],
      engineers: [{ id: 5, title: "Geoff Emerick" }],
      featuredArtists: [],
      siblingCount: 16,
    });

    expect(article).toContain("Performed by [The Beatles](node:1).");
    expect(article).toContain("Appears on [Abbey Road](node:2), released in 1969 on [Apple Records](node:3).");
    expect(article).toContain("Produced by [George Martin](node:4).");
    expect(article).toContain("Engineered by [Geoff Emerick](node:5).");
    expect(article).toContain("16 other tracks from this release are in your collection.");
  });

  it("uses singular phrasing for exactly one sibling", () => {
    const article = generateRecordingArticle({
      artist: null,
      release: null,
      year: null,
      label: null,
      producers: [],
      engineers: [],
      featuredArtists: [],
      siblingCount: 1,
    });
    expect(article).toBe("1 other track from this release is in your collection.");
  });

  it("returns null when there is nothing at all to say", () => {
    expect(
      generateRecordingArticle({
        artist: null,
        release: null,
        year: null,
        label: null,
        producers: [],
        engineers: [],
        featuredArtists: [],
        siblingCount: 0,
      }),
    ).toBeNull();
  });

  it("falls back to just the year when there's no release to attach it to", () => {
    const article = generateRecordingArticle({
      artist: null,
      release: null,
      year: 1971,
      label: null,
      producers: [],
      engineers: [],
      featuredArtists: [],
      siblingCount: 0,
    });
    expect(article).toBe("Released in 1971.");
  });
});

describe("generateArtistArticle", () => {
  it("realizes the vision doc's own example: collaborators surfaced as links", () => {
    const article = generateArtistArticle({
      trackCount: 213,
      albumCount: 15,
      collaborators: [
        { id: 1, title: "Billy Preston" },
        { id: 2, title: "George Martin" },
      ],
    });
    expect(article).toContain("213 tracks across 15 albums in your collection.");
    expect(article).toContain("Has collaborated with [Billy Preston](node:1) and [George Martin](node:2).");
  });

  it("returns null for an artist with nothing known", () => {
    expect(generateArtistArticle({ trackCount: 0, albumCount: 0, collaborators: [] })).toBeNull();
  });
});

describe("generateReleaseArticle", () => {
  it("describes a single-year album with duration and relations", () => {
    const article = generateReleaseArticle({
      primaryArtist: { id: 1, title: "The Beatles" },
      trackCount: 17,
      totalDurationMs: 47 * 60000 + 30000,
      yearMin: 1969,
      yearMax: 1969,
      sameArtistAlbums: [{ id: 2, title: "Let It Be" }],
      sameLabelAlbums: [],
    });
    expect(article).toContain("By [The Beatles](node:1), 1969.");
    expect(article).toContain("17 tracks, 48m total."); // 47m30s rounds up
    expect(article).toContain("Same artist as [Let It Be](node:2).");
  });

  it("shows a year span when tracks were collected across multiple years", () => {
    const article = generateReleaseArticle({
      primaryArtist: null,
      trackCount: 0,
      totalDurationMs: 0,
      yearMin: 1965,
      yearMax: 1968,
      sameArtistAlbums: [],
      sameLabelAlbums: [],
    });
    expect(article).toContain("An album in your collection, 1965–1968.");
  });
});

describe("generateLabelArticle", () => {
  it("lists recordings up to the cap and counts the remainder", () => {
    const recordings = Array.from({ length: 10 }, (_, i) => ({ id: i, title: `Track ${i}` }));
    const article = generateLabelArticle({ recordings, artistCount: 3 });
    expect(article).toBe(
      "Released 10 recordings you own across 3 artists: [Track 0](node:0), [Track 1](node:1), [Track 2](node:2), " +
        "[Track 3](node:3), [Track 4](node:4), [Track 5](node:5), [Track 6](node:6), [Track 7](node:7), and 2 more.",
    );
  });

  it("returns null for a label with no recordings", () => {
    expect(generateLabelArticle({ recordings: [], artistCount: 0 })).toBeNull();
  });
});

describe("generateCreditArticle", () => {
  it("realizes the vision doc's own example: an engineer's other records surfaced", () => {
    const article = generateCreditArticle({
      producedRecordings: [],
      engineeredRecordings: [
        { id: 1, title: "Come Together" },
        { id: 2, title: "Something" },
        { id: 3, title: "Oh! Darling" },
      ],
    });
    expect(article).toBe(
      "Engineered 3 recordings you own: [Come Together](node:1), [Something](node:2), and [Oh! Darling](node:3).",
    );
  });

  it("returns null for a credit with no known work", () => {
    expect(generateCreditArticle({ producedRecordings: [], engineeredRecordings: [] })).toBeNull();
  });
});
