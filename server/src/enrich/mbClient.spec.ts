import { describe, expect, it } from "bun:test";
import {
  buildRecordingQuery,
  parseArtistCredit,
  parseArtistMemberRelations,
  parseReleaseDetail,
  type RawReleaseDetail,
} from "./mbClient.js";

describe("buildRecordingQuery — M-2", () => {
  it("builds recording+artist only when nothing else is known", () => {
    expect(buildRecordingQuery({ artist: "Bob Dylan", title: "Visions of Johanna" })).toBe(
      'recording:"Visions of Johanna" AND artist:"Bob Dylan"',
    );
  });

  it("AND-requires the album when present — the real fix for the 196-candidate case", () => {
    const query = buildRecordingQuery({
      artist: "Bob Dylan",
      title: "Visions of Johanna",
      album: "Blonde On Blonde",
    });
    expect(query).toBe('recording:"Visions of Johanna" AND artist:"Bob Dylan" AND release:"Blonde On Blonde"');
  });

  it("adds track number, total tracks and year as bare (OR-boost) terms, not AND-required", () => {
    const query = buildRecordingQuery({
      artist: "Bob Dylan",
      title: "Visions of Johanna",
      album: "Blonde On Blonde",
      trackNo: 3,
      totalTracks: 14,
      date: "1966-06-20",
    });
    // Required clause first, then space-separated boosts — MusicBrainz's
    // public search index defaults space-separated terms to OR, so these
    // widen relevance without excluding a candidate whose *other* release
    // doesn't happen to carry the value (confirmed live: an AND-required
    // date dropped this exact query from 11 candidates to 1, wrongly).
    expect(query).toBe(
      'recording:"Visions of Johanna" AND artist:"Bob Dylan" AND release:"Blonde On Blonde" tnum:3 tracks:14 date:1966',
    );
  });

  it("only the leading year of a full date feeds the query", () => {
    const query = buildRecordingQuery({ artist: "x", title: "y", date: "1966-06-20" });
    expect(query).toContain("date:1966");
    expect(query).not.toContain("06-20");
  });

  it("escapes Lucene special characters in title and artist", () => {
    const query = buildRecordingQuery({ artist: "AC/DC", title: 'Rock (n\' Roll) "Ain\'t" Noise Pollution' });
    // Every Lucene special character the current escapeLucene set covers:
    // + - & | ! ( ) { } [ ] ^ " ~ * ? : \ /
    expect(query).toBe('recording:"Rock \\(n\' Roll\\) \\"Ain\'t\\" Noise Pollution" AND artist:"AC\\/DC"');
  });

  it("escapes the album field the same way", () => {
    const query = buildRecordingQuery({ artist: "x", title: "y", album: "Now & Then (Deluxe)" });
    expect(query).toContain('release:"Now \\& Then \\(Deluxe\\)"');
  });
});

// Trimmed-but-real shape: fetched live against GET /release/{mbid}?inc=
// recordings+artist-credits+labels+release-groups+recording-level-rels+
// artist-rels+isrcs for The Beatles' "Abbey Road" (GB CD, 9e53c190-...)
// while building M-8, to confirm field names/nesting rather than guess at
// them — trimmed to the fields parseReleaseDetail actually reads.
const ABBEY_ROAD: RawReleaseDetail = {
  id: "9e53c190-5621-3848-8ae4-39ad9f7d9ace",
  status: "Official",
  country: "GB",
  barcode: "077774644624",
  asin: "B000002UB3",
  disambiguation: "Apple logo on back cover",
  "text-representation": { language: "eng", script: "Latn" },
  "release-group": { id: "9162580e-5df4-32de-80cc-f45a8d8a9b1d", "first-release-date": "1969-09-26" },
  "label-info": [{ label: { name: "Parlophone" }, "catalog-number": "CDP 7 46446 2" }],
  media: [
    {
      format: "CD",
      tracks: [
        {
          position: 1,
          length: 259460,
          recording: {
            id: "485bbe7f-d0f7-4ffe-8adb-0f1093dd2dbf",
            length: 259360,
            isrcs: ["GBAYE0000944", "GBAYE0601690"],
            relations: [
              { type: "engineer", "target-type": "artist", artist: { name: "Geoff Emerick" }, attributes: [] },
              { type: "engineer", "target-type": "artist", artist: { name: "Phil McDonald" }, attributes: [] },
              {
                type: "instrument",
                "target-type": "artist",
                artist: { name: "George Harrison" },
                attributes: ["electric guitar"],
              },
              // Work relations exist in the real response too (this server
              // doesn't fetch work-rels) — target-type "work" is filtered
              // out rather than crashing on a missing artist name.
              { type: "performance", "target-type": "work", attributes: [] },
            ],
          },
        },
      ],
    },
  ],
};

describe("parseReleaseDetail — M-8's wider field harvest", () => {
  it("pulls release-level identifiers and facts", () => {
    const detail = parseReleaseDetail(ABBEY_ROAD);
    expect(detail.status).toBe("Official");
    expect(detail.country).toBe("GB");
    expect(detail.barcode).toBe("077774644624");
    expect(detail.asin).toBe("B000002UB3");
    expect(detail.disambiguation).toBe("Apple logo on back cover");
    expect(detail.language).toBe("eng");
    expect(detail.script).toBe("Latn");
    expect(detail.format).toBe("CD");
    expect(detail.releaseGroupMbid).toBe("9162580e-5df4-32de-80cc-f45a8d8a9b1d");
    expect(detail.firstReleaseDate).toBe("1969-09-26");
    expect(detail.labelName).toBe("Parlophone");
    expect(detail.catalogNumber).toBe("CDP 7 46446 2");
  });

  it("pulls a track's ISRC (first, when several) and its recording-level credits", () => {
    const detail = parseReleaseDetail(ABBEY_ROAD);
    const track = detail.tracks[0];
    expect(track.isrc).toBe("GBAYE0000944");
    expect(track.credits).toContainEqual({ type: "engineer", artistName: "Geoff Emerick", attributes: [] });
    expect(track.credits).toContainEqual({ type: "engineer", artistName: "Phil McDonald", attributes: [] });
    expect(track.credits).toContainEqual({
      type: "instrument",
      artistName: "George Harrison",
      attributes: ["electric guitar"],
    });
  });

  it("drops work relations rather than crashing on a missing artist name", () => {
    const detail = parseReleaseDetail(ABBEY_ROAD);
    expect(detail.tracks[0].credits.every((c) => c.type !== "performance")).toBe(true);
    expect(detail.tracks[0].credits).toHaveLength(3);
  });

  it("prefers the track's own length over the recording's canonical length", () => {
    const detail = parseReleaseDetail(ABBEY_ROAD);
    expect(detail.tracks[0].durationMs).toBe(259460);
  });

  it("handles a release with no media at all", () => {
    const detail = parseReleaseDetail({ id: "empty" });
    expect(detail.tracks).toEqual([]);
    expect(detail.format).toBeNull();
    expect(detail.labelName).toBeNull();
  });
});

// Issue #61: real shape confirmed against MusicBrainz's live API for The
// Beatles (a "backward" member-of-band relation per member, no direction
// key on a group's own relations to bands *it* was in) and cross-checked
// against George Harrison's own artist page (the same relationship comes
// back "forward", with no direction key at all).
// Issue #273: the shape a recording's or a track's "artist-credit" comes in.
describe("parseArtistCredit", () => {
  it("keeps each artist, its credited name, and the joiner after it", () => {
    expect(
      parseArtistCredit([
        { name: "Beyonce", joinphrase: " & ", artist: { name: "Beyoncé" } },
        { name: "JAY-Z", artist: { name: "JAY-Z" } },
      ]),
    ).toEqual([
      { name: "Beyonce", artist: "Beyoncé", joinphrase: " & " },
      { name: "JAY-Z", artist: "JAY-Z", joinphrase: "" },
    ]);
  });

  it("is null when there's no credit to keep", () => {
    expect(parseArtistCredit(undefined)).toBeNull();
    expect(parseArtistCredit([])).toBeNull();
    expect(parseArtistCredit([{ joinphrase: ", " }])).toBeNull();
  });

  it("takes a release track's own credit, falling back to its recording's", () => {
    const detail = parseReleaseDetail({
      id: "rel",
      media: [
        {
          tracks: [
            {
              position: 1,
              "artist-credit": [{ name: "Cage the Elephant", joinphrase: ", ", artist: { name: "Cage the Elephant" } }, { name: "Alison Mosshart", artist: { name: "Alison Mosshart" } }],
              recording: { id: "rec-1", "artist-credit": [{ name: "Cage the Elephant", artist: { name: "Cage the Elephant" } }] },
            },
            { position: 2, recording: { id: "rec-2", "artist-credit": [{ name: "Cage the Elephant", artist: { name: "Cage the Elephant" } }] } },
          ],
        },
      ],
    });
    expect(detail.tracks.map((t) => t.artistCredit?.map((c) => c.name))).toEqual([
      ["Cage the Elephant", "Alison Mosshart"],
      ["Cage the Elephant"],
    ]);
  });
});

describe("parseArtistMemberRelations — issue #61", () => {
  it("reads a group's own page: member relations come back 'backward', naming the member", () => {
    const relations = parseArtistMemberRelations([
      {
        type: "member of band",
        "target-type": "artist",
        direction: "backward",
        artist: { name: "George Harrison" },
      },
      {
        type: "member of band",
        "target-type": "artist",
        direction: "backward",
        artist: { name: "Paul McCartney" },
      },
    ]);
    expect(relations).toEqual([
      { direction: "backward", name: "George Harrison" },
      { direction: "backward", name: "Paul McCartney" },
    ]);
  });

  it("reads a member's own page: relations with no direction key are 'forward', naming the group", () => {
    const relations = parseArtistMemberRelations([
      { type: "member of band", "target-type": "artist", artist: { name: "The Beatles" } },
      { type: "member of band", "target-type": "artist", artist: { name: "The Traveling Wilburys" } },
    ]);
    expect(relations).toEqual([
      { direction: "forward", name: "The Beatles" },
      { direction: "forward", name: "The Traveling Wilburys" },
    ]);
  });

  it("drops relations of a different type or target-type, and ones missing an artist name", () => {
    const relations = parseArtistMemberRelations([
      { type: "founder of", "target-type": "artist", artist: { name: "Some Label" } },
      { type: "member of band", "target-type": "release-group", artist: { name: "Not Actually An Artist" } },
      { type: "member of band", "target-type": "artist" },
    ]);
    expect(relations).toEqual([]);
  });
});
