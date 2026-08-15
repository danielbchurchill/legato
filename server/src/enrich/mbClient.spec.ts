import { describe, expect, it } from "vitest";
import { buildRecordingQuery } from "./mbClient.js";

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
