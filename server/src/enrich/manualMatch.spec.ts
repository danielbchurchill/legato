import { describe, expect, it } from "bun:test";
import { parseMusicBrainzReference } from "./manualMatch.js";

const MBID = "b1a9c0e9-d987-4042-ae91-78d6a3267d69";

describe("parseMusicBrainzReference", () => {
  it("reads a bare MBID as a recording, whatever its case and surrounding space", () => {
    expect(parseMusicBrainzReference(` ${MBID.toUpperCase()}\n`)).toEqual({ entity: "recording", mbid: MBID });
  });

  it("reads a recording link as copied from the address bar", () => {
    expect(parseMusicBrainzReference(`https://musicbrainz.org/recording/${MBID}`)).toEqual({ entity: "recording", mbid: MBID });
  });

  it("ignores the scheme, a subdomain, and anything after the MBID", () => {
    for (const link of [
      `musicbrainz.org/recording/${MBID}`,
      `http://www.musicbrainz.org/recording/${MBID}#tracklist`,
      `https://beta.musicbrainz.org/recording/${MBID}/fingerprints?utm_source=x`,
    ]) {
      expect(parseMusicBrainzReference(link)).toEqual({ entity: "recording", mbid: MBID });
    }
  });

  it("names the entity of any other MusicBrainz link, so the caller can say what it got", () => {
    expect(parseMusicBrainzReference(`https://musicbrainz.org/release/${MBID}`)).toEqual({ entity: "release", mbid: MBID });
    expect(parseMusicBrainzReference(`https://musicbrainz.org/release-group/${MBID}`)).toEqual({
      entity: "release-group",
      mbid: MBID,
    });
  });

  it("rejects anything else", () => {
    for (const text of [
      "",
      "Come Together",
      `${MBID}x`,
      `https://example.com/recording/${MBID}`,
      `https://musicbrainz.org.example.com/recording/${MBID}`,
      `https://musicbrainz.org/recording/not-an-mbid`,
    ]) {
      expect(parseMusicBrainzReference(text)).toBeNull();
    }
  });
});
