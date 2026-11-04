import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mocked } from "../testing.js";
import * as mbClient from "./mbClient.js";
import type { MbReleaseDetail } from "./mbClient.js";

// Issue #465: M-6's album lookup resolves every unmatched file of one album
// at once. "One album" is the rule match/edges.ts files albums by: every
// disc of a set, and never another artist's album of the same title.

mock.module("./mbClient.js", () => ({
  searchRecording: mock().mockResolvedValue([]),
  searchRelease: mock(),
  fetchReleaseDetail: mock(),
  lookupReleaseGroupForRecording: mock(),
  searchArtist: mock(),
  fetchArtistMemberRelations: mock(),
  fetchUrlRelations: mock(),
}));
mock.module("./coverArchive.js", () => ({ fetchCaaFrontImage: mock() }));
mock.module("./deezer.js", () => ({ fetchArtistImage: mock() }));
// Pinned to "no fingerprint" rather than a bare mock(): a mock.module stub
// outlives this file in bun test, and a later spec that scans fixtures would
// otherwise fold them all into one recording.
mock.module("../match/fingerprint.js", () => ({ computeFingerprint: async () => null }));
mock.module("./acoustid.js", () => ({ lookupFingerprint: async () => [] }));

const { runDueJobs } = await import("./worker.js");
const { deriveLocalEdges } = await import("../match/edges.js");

let db: Database;
let root: number;

beforeEach(() => {
  db = openDb(":memory:");
  mock.clearAllMocks();
  root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/m') RETURNING id").get() as { id: number }).id;
});

function addFile(filePath: string, tags: Record<string, unknown>): number {
  const recording = (
    db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(tags.title as string) as {
      id: number;
    }
  ).id;
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, 200000)").run(recording);
  const fileId = (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw, match_source)
         VALUES (?, ?, ?, datetime('now'), 0, ?, 'unmatched') RETURNING id`,
      )
      .get(recording, root, filePath, JSON.stringify(tags)) as { id: number }
  ).id;
  deriveLocalEdges(db, fileId);
  return recording;
}

function release(mbid: string, discs: string[][]): MbReleaseDetail {
  let absolutePosition = 0;
  return {
    mbid,
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
    tracks: discs.flatMap((tracks, disc) =>
      tracks.map((recordingMbid, i) => ({
        position: i + 1,
        mediumPosition: disc + 1,
        absolutePosition: ++absolutePosition,
        recordingMbid,
        durationMs: 200000,
        isrc: null,
        credits: [],
      })),
    ),
  };
}

function mbidOf(recording: number): string | null {
  return (db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(recording) as { mbid: string | null }).mbid;
}

function lookUp(recording: number): Promise<void> {
  db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'recording_lookup', 'queued')").run(
    recording,
  );
  return runDueJobs(db);
}

describe("the album lookup's siblings", () => {
  it("are every disc of a set, searched for by the title without its suffix", async () => {
    // As a scan now reads them: no disc tag, so the disc is the suffix's.
    const tracks = [
      addFile("/m/The Doors/Best Of/CD1/01.flac", {
        title: "Break On Through",
        artist: "The Doors",
        album: "The Best Of The Doors [CD1]",
        trackNo: 1,
        discNo: 1,
      }),
      addFile("/m/The Doors/Best Of/CD1/02.flac", {
        title: "Light My Fire",
        artist: "The Doors",
        album: "The Best Of The Doors [CD1]",
        trackNo: 2,
        discNo: 1,
      }),
      addFile("/m/The Doors/Best Of/CD2/01.flac", {
        title: "L.A. Woman",
        artist: "The Doors",
        album: "The Best Of The Doors [CD2]",
        trackNo: 1,
        discNo: 2,
      }),
      addFile("/m/The Doors/Best Of/CD2/02.flac", {
        title: "Riders on the Storm",
        artist: "The Doors",
        album: "The Best Of The Doors [CD2]",
        trackNo: 2,
        discNo: 2,
      }),
    ];
    // Someone else's album of the same title, in a folder of its own.
    const tribute = addFile("/m/Tribute/The Best Of The Doors/01.flac", {
      title: "Break On Through",
      artist: "Tribute Band",
      album: "The Best Of The Doors",
      trackNo: 1,
    });

    mocked(mbClient.searchRelease).mockResolvedValue([
      {
        mbid: "rel-doors",
        score: 100,
        title: "The Best Of The Doors",
        artist: "The Doors",
        releaseType: "album",
        date: null,
        totalTracks: 4,
      },
    ]);
    mocked(mbClient.fetchReleaseDetail).mockResolvedValue(
      release("rel-doors", [
        ["rec-1-1", "rec-1-2"],
        ["rec-2-1", "rec-2-2"],
      ]),
    );

    await lookUp(tracks[0]!);

    expect(mocked(mbClient.searchRelease)).toHaveBeenCalledTimes(1);
    expect(mocked(mbClient.searchRelease).mock.calls[0]![0].album).toBe("The Best Of The Doors");
    expect(tracks.map(mbidOf)).toEqual(["rec-1-1", "rec-1-2", "rec-2-1", "rec-2-2"]);
    expect(mbidOf(tribute)).toBeNull();
  });

  it("leave out another artist's album of the same title, even in the same folder", async () => {
    const queen = [
      addFile("/m/Hits/01.flac", {
        title: "Bohemian Rhapsody",
        artist: "Queen",
        albumartist: "Queen",
        album: "Greatest Hits",
        trackNo: 1,
      }),
      addFile("/m/Hits/02.flac", {
        title: "Another One Bites the Dust",
        artist: "Queen",
        albumartist: "Queen",
        album: "Greatest Hits",
        trackNo: 2,
      }),
    ];
    const abba = [
      addFile("/m/Hits/03.flac", {
        title: "SOS",
        artist: "ABBA",
        albumartist: "ABBA",
        album: "Greatest Hits",
        trackNo: 1,
      }),
      addFile("/m/Hits/04.flac", {
        title: "Mamma Mia",
        artist: "ABBA",
        albumartist: "ABBA",
        album: "Greatest Hits",
        trackNo: 2,
      }),
    ];

    mocked(mbClient.searchRelease).mockResolvedValue([
      {
        mbid: "rel-queen",
        score: 100,
        title: "Greatest Hits",
        artist: "Queen",
        releaseType: "album",
        date: null,
        totalTracks: 2,
      },
    ]);
    mocked(mbClient.fetchReleaseDetail).mockResolvedValue(release("rel-queen", [["rec-q1", "rec-q2"]]));

    await lookUp(queen[0]!);

    expect(mocked(mbClient.searchRelease).mock.calls[0]![0]).toMatchObject({
      album: "Greatest Hits",
      albumartist: "Queen",
    });
    expect(queen.map(mbidOf)).toEqual(["rec-q1", "rec-q2"]);
    expect(abba.map(mbidOf)).toEqual([null, null]);
  });
});
