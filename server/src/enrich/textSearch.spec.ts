import { describe, expect, it } from "bun:test";
import type { MbRecordingCandidate } from "./mbClient.js";
import { lengthScore, pickBestMatch, scoreCandidate, similarity2, type LocalMatchInput } from "./textSearch.js";

function candidate(overrides: Partial<MbRecordingCandidate> = {}): MbRecordingCandidate {
  return {
    mbid: "mb-1",
    score: 100,
    title: "Visions of Johanna",
    artist: "Bob Dylan",
    durationMs: null,
    releases: [],
    ...overrides,
  };
}

function local(overrides: Partial<LocalMatchInput> = {}): LocalMatchInput {
  return {
    title: "Visions of Johanna",
    artist: "Bob Dylan",
    album: null,
    trackNo: null,
    totalTracks: null,
    date: null,
    durationMs: null,
    ...overrides,
  };
}

describe("similarity2 — Picard's word-wise comparison", () => {
  it("scores an identical bag of words as 1, regardless of case", () => {
    expect(similarity2("Blonde On Blonde", "Blonde on Blonde")).toBe(1);
  });

  it("scores no word overlap as 0", () => {
    expect(similarity2("Blonde On Blonde", "Highway 61 Revisited")).toBe(0);
  });

  it("gives partial credit for a subset match rather than an all-or-nothing exact check", () => {
    const score = similarity2("Blonde On Blonde", "Blonde on Blonde Outtakes");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it("treats null/empty input as no match", () => {
    expect(similarity2(null, "Blonde on Blonde")).toBe(0);
    expect(similarity2("Blonde on Blonde", null)).toBe(0);
  });
});

describe("lengthScore — M-4's duration gradient", () => {
  it("is 1 for an exact match", () => {
    expect(lengthScore(454012, 454012)).toBe(1);
  });

  it("matches Picard's formula: 1 - min(|a-b|, 30000) / 30000 — the exact real-library numbers", () => {
    // Local file: 454012ms. Three real MusicBrainz candidates for this
    // exact case (Visions of Johanna / Bob Dylan / Blonde on Blonde).
    expect(lengthScore(454012, 454066)).toBeCloseTo(0.9982, 4);
    expect(lengthScore(454012, 454005)).toBeCloseTo(0.9998, 4);
    expect(lengthScore(454012, 453440)).toBeCloseTo(0.9809, 4);
  });

  it("clamps at 0 past the 30-second range rather than going negative", () => {
    expect(lengthScore(0, 60000)).toBe(0);
  });

  it("is neutral (0.5), not a penalty, when either side has no duration", () => {
    expect(lengthScore(null, 454012)).toBe(0.5);
    expect(lengthScore(454012, null)).toBe(0.5);
  });
});

describe("pickBestMatch — M-3 weighted scoring + M-4 duration gradient", () => {
  it("returns no_match on an empty candidate list", () => {
    expect(pickBestMatch([], local()).outcome).toBe("no_match");
  });

  it("returns no_match when nothing clears the relevance floor", () => {
    expect(pickBestMatch([candidate({ score: 10 })], local()).outcome).toBe("no_match");
  });

  it("the real case this was built for: Visions of Johanna resolves to the 7ms-off candidate, not ambiguous", () => {
    // Every field taken directly from a live MusicBrainz search for
    // "Visions of Johanna"/"Bob Dylan"/release:"Blonde On Blonde" —
    // confirmed while building this against the real API. The old
    // MB-score-only ranking left this a 15-way tie (M-2's own finding);
    // M-2's widened query narrows the candidate pool to these 11, and
    // M-3/M-4's weighted scoring is what actually breaks the remaining
    // near-tie among the top three "Blonde on Blonde"/Album candidates.
    const candidates: MbRecordingCandidate[] = [
      candidate({
        mbid: "7bdc384b",
        score: 100,
        durationMs: 454066,
        releases: [{ title: "Blonde on Blonde", releaseType: "Album", date: "1992", trackCount: 14, trackNo: 3 }],
      }),
      candidate({
        mbid: "2279e1c3", // the correct answer — 7ms off the local file
        score: 100,
        durationMs: 454005,
        releases: [{ title: "Blonde on Blonde", releaseType: "Album", date: null, trackCount: 14, trackNo: 3 }],
      }),
      candidate({
        mbid: "d682e963",
        score: 100,
        durationMs: 453440,
        releases: [
          { title: "Blonde on Blonde", releaseType: "Album", date: "1987-03-30", trackCount: 14, trackNo: 3 },
        ],
      }),
      candidate({
        mbid: "69d31c45",
        score: 96,
        durationMs: 454000,
        title: "Visions of Johanna",
        releases: [
          { title: "Blonde on Blonde Outtakes", releaseType: "Other", date: null, trackCount: 13, trackNo: 1 },
        ],
      }),
      candidate({
        mbid: "cc3cc93a",
        score: 92,
        durationMs: 453000,
        releases: [
          { title: "Blonde on Blonde", releaseType: "Album", date: "2003-10-22", trackCount: 8, trackNo: 3 },
        ],
      }),
      candidate({
        mbid: "427030ec",
        score: 80,
        durationMs: 448000,
        releases: [
          {
            title: "The Blonde on Blonde Studio Sessions",
            releaseType: "Album",
            date: null,
            trackCount: 16,
            trackNo: 12,
          },
        ],
      }),
    ];

    const result = pickBestMatch(candidates, local({ album: "Blonde On Blonde", durationMs: 454012 }));

    expect(result).toEqual({ outcome: "matched", mbid: "2279e1c3", confidence: expect.any(Number) });
    if (result.outcome === "matched") {
      expect(result.confidence).toBeGreaterThan(0.9); // a confident match, not a bare pass
    }
  });

  it("a live bootleg / compilation with the identical title, artist and a close duration still loses to a studio album — the releasetype weight's whole job", () => {
    const album = candidate({
      mbid: "album",
      score: 100,
      durationMs: 454000,
      releases: [{ title: "Blonde on Blonde", releaseType: "Album", date: null, trackCount: 14, trackNo: 3 }],
    });
    const bootleg = candidate({
      mbid: "bootleg",
      score: 100,
      durationMs: 454000, // identical duration — only releasetype differs
      title: "Visions of Johanna",
      releases: [
        { title: "2006-09-01: Some Venue", releaseType: "Live", date: null, trackCount: 20, trackNo: 5 },
      ],
    });

    const result = pickBestMatch([bootleg, album], local({ durationMs: 454000 }));
    expect(result).toEqual({ outcome: "matched", mbid: "album", confidence: expect.any(Number) });
  });

  it("flags a wide tie as ambiguous when nothing distinguishes the candidates — the real 'Come Together' case (5 distinct MBIDs, all scored 100, no other data)", () => {
    const candidates = ["mb-1", "mb-2", "mb-3", "mb-4", "mb-5"].map((mbid) => candidate({ mbid }));
    const result = pickBestMatch(candidates, local());
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome === "ambiguous") {
      expect(result.candidates).toHaveLength(5);
    }
  });

  it("stays ambiguous when duration is exactly symmetric around the local file — genuinely uninformative, not just close", () => {
    const candidates = [
      candidate({ mbid: "mb-1", durationMs: 258000 }),
      candidate({ mbid: "mb-2", durationMs: 258200 }),
    ];
    const result = pickBestMatch(candidates, local({ durationMs: 258100 })); // exactly 100ms off both ways
    expect(result.outcome).toBe("ambiguous");
  });

  it("de-dupes the same mbid appearing twice in a search response, keeping the higher score", () => {
    const result = pickBestMatch(
      [candidate({ mbid: "mb-1", score: 100 }), candidate({ mbid: "mb-1", score: 60 })],
      local(),
    );
    expect(result.outcome).toBe("matched");
    if (result.outcome === "matched") expect(result.mbid).toBe("mb-1");
  });
});

describe("scoreCandidate", () => {
  it("scores a perfect match at (title+artist+length weight fraction), scaled by MB's own score", () => {
    // No album/releasetype/totaltracks/date signal on either side — those
    // fields land at their neutral defaults, not zero, so a thin-data
    // candidate isn't punished for information nobody has yet.
    const score = scoreCandidate(local({ durationMs: 100000 }), candidate({ score: 50, durationMs: 100000 }));
    // title(13) + artist(4) + length(10) all at 1.0, releasetype(14) at its
    // no-data floor (0.3), album/totaltracks/date(5+4+4) neutral at 0.5,
    // all divided by the 54 total weight, then scaled by score/100=0.5.
    const expected = ((13 + 4 + 10 + 14 * 0.3 + 5 * 0.5 + 4 * 0.5 + 4 * 0.5) / 54) * 0.5;
    expect(score).toBeCloseTo(expected, 6);
  });
});
