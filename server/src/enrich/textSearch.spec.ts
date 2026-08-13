import { describe, expect, it } from "vitest";
import type { MbRecordingCandidate } from "./mbClient.js";
import { pickBestMatch } from "./textSearch.js";

function candidate(overrides: Partial<MbRecordingCandidate> = {}): MbRecordingCandidate {
  return { mbid: "mb-1", score: 100, title: "Come Together", artist: "The Beatles", durationMs: null, ...overrides };
}

describe("pickBestMatch", () => {
  it("returns no_match when nothing scores high enough", () => {
    const result = pickBestMatch([candidate({ score: 40 })], null);
    expect(result.outcome).toBe("no_match");
  });

  it("returns no_match on an empty candidate list", () => {
    expect(pickBestMatch([], null).outcome).toBe("no_match");
  });

  it("matches a single clear winner", () => {
    const result = pickBestMatch([candidate({ mbid: "mb-1", score: 100 }), candidate({ mbid: "mb-2", score: 70 })], null);
    expect(result).toEqual({ outcome: "matched", mbid: "mb-1", confidence: 1 });
  });

  it("flags a wide tie as ambiguous — the real 'Come Together' case (5 distinct MBIDs, all scored 100, no duration data)", () => {
    const candidates = ["mb-1", "mb-2", "mb-3", "mb-4", "mb-5"].map((mbid) =>
      candidate({ mbid, score: 100, durationMs: null }),
    );
    const result = pickBestMatch(candidates, null);
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome === "ambiguous") {
      expect(result.candidates).toHaveLength(5);
    }
  });

  it("disambiguates a tie using local duration when available", () => {
    const candidates = [
      candidate({ mbid: "mb-1", score: 100, durationMs: 258506 }),
      candidate({ mbid: "mb-2", score: 100, durationMs: 300000 }), // way off
      candidate({ mbid: "mb-3", score: 100, durationMs: null }), // no duration data
    ];
    const result = pickBestMatch(candidates, 258000); // local file is ~258s
    expect(result).toEqual({ outcome: "matched", mbid: "mb-1", confidence: 1 });
  });

  it("stays ambiguous when duration doesn't uniquely narrow the tie", () => {
    const candidates = [
      candidate({ mbid: "mb-1", score: 100, durationMs: 258000 }),
      candidate({ mbid: "mb-2", score: 100, durationMs: 258200 }), // both plausibly the same file
    ];
    const result = pickBestMatch(candidates, 258100);
    expect(result.outcome).toBe("ambiguous");
  });

  it("de-dupes the same mbid appearing twice in a search response", () => {
    const result = pickBestMatch([candidate({ mbid: "mb-1", score: 100 }), candidate({ mbid: "mb-1", score: 99 })], null);
    expect(result).toEqual({ outcome: "matched", mbid: "mb-1", confidence: 1 });
  });
});
