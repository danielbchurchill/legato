import { describe, expect, it } from "vitest";
import type { MbReleaseCandidateSearch, MbReleaseDetail } from "./mbClient.js";
import { assignTracks, pickBestRelease, scoreReleaseCandidate, type LocalAlbumInput, type LocalTrack } from "./releaseMatch.js";

function releaseCandidate(overrides: Partial<MbReleaseCandidateSearch> = {}): MbReleaseCandidateSearch {
  return {
    mbid: "release-1",
    score: 100,
    title: "Blonde on Blonde",
    artist: "Bob Dylan",
    releaseType: "Album",
    date: "1966",
    totalTracks: 14,
    ...overrides,
  };
}

function local(overrides: Partial<LocalAlbumInput> = {}): LocalAlbumInput {
  return {
    album: "Blonde On Blonde",
    albumartist: "Bob Dylan",
    totalTracks: 14,
    releaseType: null,
    date: null,
    ...overrides,
  };
}

// The real Blonde on Blonde tracklist — fetched live against MusicBrainz
// while building this (GET /release/{mbid}?inc=recordings+...) to confirm
// the actual response shape rather than guessing at it.
function track(
  position: number,
  recordingMbid: string,
  durationMs: number,
  overrides: Partial<Pick<MbReleaseDetail["tracks"][number], "isrc" | "credits" | "mediumPosition" | "absolutePosition">> = {},
): MbReleaseDetail["tracks"][number] {
  // Single-medium defaults: one disc, so position, medium position and
  // running position all agree. The multi-disc cases below override them.
  return {
    position,
    mediumPosition: 1,
    absolutePosition: position,
    recordingMbid,
    durationMs,
    isrc: null,
    credits: [],
    ...overrides,
  };
}

const REAL_TRACKLIST: MbReleaseDetail = {
  mbid: "acc2a08d-5c3d-3f16-a5aa-20824c957f09",
  status: null,
  country: null,
  barcode: null,
  asin: null,
  disambiguation: null,
  language: null,
  script: null,
  format: null,
  releaseGroupMbid: null,
  firstReleaseDate: null,
  labelName: null,
  catalogNumber: null,
  tracks: [
    track(1, "469c2986-08a7-4085-ad19-39491bbfb457", 277893),
    track(2, "5a27b48c-c688-42fd-b68c-73f4cdb102b9", 229506),
    track(3, "a9a1c164-f261-4072-96b4-ef4e4f1f4608", 454066),
    track(4, "40bd0f3a-180d-43a2-b912-25b0ec55ac78", 296493),
    track(5, "123e4be7-73a3-4f0e-87da-5be68c5abbf6", 188440),
    track(6, "589ec3c9-1345-40ce-b379-53288bbd1982", 425893),
    track(7, "bafb0720-3c1a-4f67-863d-9c37f03f15da", 240240),
    track(8, "80b48ecb-559a-4046-9704-ff030b979120", 294160),
    track(9, "606fb070-829c-455b-84bb-e2c445dd2e29", 209533),
    track(10, "b15b6425-519a-4ed1-be5b-9b21be35715b", 306506),
    track(11, "243e222a-d7d6-49ed-934f-b5717c4a73fa", 297360),
    track(12, "2d0038f2-59ff-4f35-9e83-0e0bf351be27", 276800),
    track(13, "798d1127-6e7c-4cca-8f59-e320c3f9c39d", 216933),
    track(14, "d2f46fbf-64b1-4b66-acb5-62eee4b10c15", 680173),
  ],
};

describe("scoreReleaseCandidate / pickBestRelease — M-6 cluster weights", () => {
  it("scores an exact match near 1 (scaled only by MB's own score)", () => {
    // Every field agrees, including date — local() alone leaves date null,
    // which is a neutral (not perfect) score by design (dateScore has no
    // opinion when either side is missing a year), so this test sets it
    // explicitly to isolate "everything really does match" from "nothing
    // to compare."
    const score = scoreReleaseCandidate(local({ date: "1966" }), releaseCandidate({ score: 100, date: "1966" }));
    expect(score).toBeCloseTo(1, 6);
  });

  it("prefers the studio album over a live/bootleg release of the same title", () => {
    const album = releaseCandidate({ mbid: "album", releaseType: "Album" });
    const live = releaseCandidate({ mbid: "live", releaseType: "Live", title: "Blonde on Blonde", totalTracks: 20 });
    const best = pickBestRelease(local(), [live, album]);
    expect(best?.mbid).toBe("album");
  });

  it("prefers the edition whose total track count matches the local album", () => {
    const fourteen = releaseCandidate({ mbid: "fourteen", totalTracks: 14 });
    const deluxe = releaseCandidate({ mbid: "deluxe", totalTracks: 28 }); // a 2-disc deluxe reissue
    const best = pickBestRelease(local({ totalTracks: 14 }), [deluxe, fourteen]);
    expect(best?.mbid).toBe("fourteen");
  });

  it("returns null when nothing clears the confidence floor", () => {
    const wrongAlbum = releaseCandidate({
      title: "Highway 61 Revisited",
      artist: "Bob Dylan",
      totalTracks: 9,
      score: 60,
    });
    const best = pickBestRelease(local({ album: "Blonde On Blonde", totalTracks: 14 }), [wrongAlbum]);
    expect(best).toBeNull();
  });

  it("returns null on an empty candidate list", () => {
    expect(pickBestRelease(local(), [])).toBeNull();
  });
});

// The real Blonde on Blonde: MusicBrainz splits it 8 + 6 across two media
// and numbers each from 1, so positions 1-6 exist twice. Structure and
// recording MBIDs taken from a live GET /release/189efa45-...?inc=recordings.
// Every local file is tagged disc 1, tracks 1-14 straight through, which is
// how the double LP actually sits on disk in one folder.
const TWO_DISC: MbReleaseDetail = {
  mbid: "189efa45-def2-3b1c-b619-ba1640774705",
  status: null,
  country: null,
  barcode: null,
  asin: null,
  disambiguation: null,
  language: null,
  script: null,
  format: null,
  releaseGroupMbid: null,
  firstReleaseDate: null,
  labelName: null,
  catalogNumber: null,
  tracks: [
    track(1, "ab1d0ca0-rainy-day-women", 275000, { mediumPosition: 1, absolutePosition: 1 }),
    track(2, "ffe699b0-pledging-my-time", 221000, { mediumPosition: 1, absolutePosition: 2 }),
    track(3, "b9c93771-visions-of-johanna", 454000, { mediumPosition: 1, absolutePosition: 3 }),
    track(4, "24ebb63c-one-of-us-must-know", 294000, { mediumPosition: 1, absolutePosition: 4 }),
    track(5, "123b0bb8-i-want-you", 187000, { mediumPosition: 1, absolutePosition: 5 }),
    track(6, "90567658-stuck-inside-of-mobile", 420000, { mediumPosition: 1, absolutePosition: 6 }),
    track(7, "e4b3fe25-leopard-skin", 205000, { mediumPosition: 1, absolutePosition: 7 }),
    track(8, "0d24a997-just-like-a-woman", 292000, { mediumPosition: 1, absolutePosition: 8 }),
    track(1, "9a366514-most-likely", 213000, { mediumPosition: 2, absolutePosition: 9 }),
    track(2, "6a837e1c-temporary-like-achilles", 305000, { mediumPosition: 2, absolutePosition: 10 }),
    track(3, "f91804ae-absolutely-sweet-marie", 281000, { mediumPosition: 2, absolutePosition: 11 }),
    track(4, "4ce35d5d-fourth-time-around", 195000, { mediumPosition: 2, absolutePosition: 12 }),
    track(5, "9545ac5c-obviously-five-believers", 215000, { mediumPosition: 2, absolutePosition: 13 }),
    track(6, "1b83e46d-sad-eyed-lady", 691000, { mediumPosition: 2, absolutePosition: 14 }),
  ],
};

describe("assignTracks — multi-disc releases", () => {
  it("matches flat 1..14 numbering straight through both discs", () => {
    const localFiles: LocalTrack[] = Array.from({ length: 14 }, (_, i) => ({
      fileId: i + 1,
      trackNo: i + 1,
      discNo: 1, // what the files actually claim: everything is "disc 1"
      durationMs: null,
    }));

    const assignments = assignTracks(localFiles, TWO_DISC);
    expect(assignments).toHaveLength(14);

    const byFile = new Map(assignments.map((a) => [a.fileId, a.recordingMbid]));
    // File 1 is Rainy Day Women. Keying on bare position let disc 2 overwrite
    // disc 1 and handed this file "Most Likely You Go Your Way" instead.
    expect(byFile.get(1)).toBe("ab1d0ca0-rainy-day-women");
    expect(byFile.get(6)).toBe("90567658-stuck-inside-of-mobile");
    // Track 9 has no disc-1 counterpart; it is disc 2's first track.
    expect(byFile.get(9)).toBe("9a366514-most-likely");
    expect(byFile.get(14)).toBe("1b83e46d-sad-eyed-lady");
  });

  it("gives every file a distinct recording", () => {
    const localFiles: LocalTrack[] = Array.from({ length: 14 }, (_, i) => ({
      fileId: i + 1,
      trackNo: i + 1,
      discNo: 1,
      durationMs: null,
    }));
    const mbids = assignTracks(localFiles, TWO_DISC).map((a) => a.recordingMbid);
    expect(new Set(mbids).size).toBe(14);
  });

it("will not re-hand a recording an earlier pass already assigned", () => {
    // The leftover shape: 13 of 14 files resolved on a previous run, so only
    // this one is still a sibling and its own track number is missing. The
    // duration fallback would otherwise hand it Sad-Eyed Lady, which another
    // file already holds — and applyMatch would merge two unrelated songs.
    const localFiles: LocalTrack[] = [{ fileId: 99, trackNo: null, discNo: null, durationMs: 691000 }];
    const used = new Set(["1b83e46d-sad-eyed-lady"]);

    const assignments = assignTracks(localFiles, TWO_DISC, used);

    expect(assignments.map((a) => a.recordingMbid)).not.toContain("1b83e46d-sad-eyed-lady");
  });

  it("honours a real disc number when the files carry one", () => {
    const localFiles: LocalTrack[] = [
      { fileId: 1, trackNo: 1, discNo: 2, durationMs: null },
      { fileId: 2, trackNo: 1, discNo: 1, durationMs: null },
    ];
    const assignments = assignTracks(localFiles, TWO_DISC);
    const byFile = new Map(assignments.map((a) => [a.fileId, a.recordingMbid]));
    expect(byFile.get(1)).toBe("9a366514-most-likely");
    expect(byFile.get(2)).toBe("ab1d0ca0-rainy-day-women");
  });

  it("does not let one disc's track claim block the other disc's same-numbered track", () => {
    const localFiles: LocalTrack[] = [
      { fileId: 1, trackNo: 1, discNo: 1, durationMs: null },
      { fileId: 2, trackNo: 1, discNo: 2, durationMs: null },
    ];
    expect(assignTracks(localFiles, TWO_DISC)).toHaveLength(2);
  });
});

describe("assignTracks — M-6 track assignment", () => {
  it("assigns every local file to its recording by track position, the real 14-track case", () => {
    const localFiles: LocalTrack[] = REAL_TRACKLIST.tracks.map((t, i) => ({
      fileId: i + 1,
      trackNo: t.position,
      discNo: null,
      durationMs: null,
    }));

    const assignments = assignTracks(localFiles, REAL_TRACKLIST);

    expect(assignments).toHaveLength(14);
    // Visions of Johanna is file 3 (position 3) — same recording MBID
    // confirmed live against the real MusicBrainz release.
    expect(assignments.find((a) => a.fileId === 3)?.recordingMbid).toBe(
      "a9a1c164-f261-4072-96b4-ef4e4f1f4608",
    );
  });

  it("falls back to closest duration when a file has no track number", () => {
    const localFiles: LocalTrack[] = [{ fileId: 1, trackNo: null, discNo: null, durationMs: 454000 }]; // ~Visions of Johanna
    const assignments = assignTracks(localFiles, REAL_TRACKLIST);
    expect(assignments).toEqual([{ fileId: 1, recordingMbid: "a9a1c164-f261-4072-96b4-ef4e4f1f4608" }]);
  });

  it("falls back to duration when the track number doesn't exist on this release (a bonus-track edition)", () => {
    const localFiles: LocalTrack[] = [{ fileId: 1, trackNo: 99, discNo: null, durationMs: 229500 }]; // ~Pledging My Time
    const assignments = assignTracks(localFiles, REAL_TRACKLIST);
    expect(assignments).toEqual([{ fileId: 1, recordingMbid: "5a27b48c-c688-42fd-b68c-73f4cdb102b9" }]);
  });

  it("never assigns the same release track to two different local files", () => {
    const localFiles: LocalTrack[] = [
      { fileId: 1, trackNo: null, discNo: null, durationMs: 454000 }, // both want "Visions of Johanna" by duration
      { fileId: 2, trackNo: null, discNo: null, durationMs: 454100 },
    ];
    const assignments = assignTracks(localFiles, REAL_TRACKLIST);
    const mbids = assignments.map((a) => a.recordingMbid);
    expect(new Set(mbids).size).toBe(mbids.length); // no duplicates
  });

  it("leaves a file unassigned when nothing on the release plausibly matches", () => {
    const localFiles: LocalTrack[] = [{ fileId: 1, trackNo: null, discNo: null, durationMs: null }];
    expect(assignTracks(localFiles, REAL_TRACKLIST)).toEqual([]);
  });
});
