import { describe, expect, it } from "vitest";
import { parseLookupResponse } from "./acoustid.js";

describe("parseLookupResponse — M-9's fingerprint fallback", () => {
  it("flattens each result's recordings, inheriting the result's own score", () => {
    const matches = parseLookupResponse({
      status: "ok",
      results: [
        { id: "acoustid-1", score: 0.92, recordings: [{ id: "mbid-a" }, { id: "mbid-b" }] },
        { id: "acoustid-2", score: 0.5, recordings: [{ id: "mbid-c" }] },
      ],
    });

    expect(matches).toEqual([
      { recordingMbid: "mbid-a", score: 0.92 },
      { recordingMbid: "mbid-b", score: 0.92 },
      { recordingMbid: "mbid-c", score: 0.5 },
    ]);
  });

  it("sorts by score, best first, even when the response doesn't", () => {
    const matches = parseLookupResponse({
      status: "ok",
      results: [
        { id: "low", score: 0.3, recordings: [{ id: "mbid-low" }] },
        { id: "high", score: 0.95, recordings: [{ id: "mbid-high" }] },
      ],
    });

    expect(matches.map((m) => m.recordingMbid)).toEqual(["mbid-high", "mbid-low"]);
  });

  it("returns [] for a result with no recordings (an acoustic match AcoustID hasn't linked to MusicBrainz)", () => {
    const matches = parseLookupResponse({ status: "ok", results: [{ id: "x", score: 0.9 }] });
    expect(matches).toEqual([]);
  });

  it("returns [] when there are no results at all", () => {
    expect(parseLookupResponse({ status: "ok" })).toEqual([]);
  });
});
