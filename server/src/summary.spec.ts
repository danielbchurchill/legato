import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { nodeSummary } from "./summary.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  rootId = 0;
  nextFile = 0;
});

function makeNode(type: string, title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

function addEdge(from: number, to: number, type: string, source = "local"): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, ?)").run(from, to, type, source);
}

let rootId = 0;
let nextFile = 0;

function libraryRoot(): number {
  if (rootId === 0) {
    rootId = (
      db.prepare("INSERT INTO library_roots (path) VALUES ('/music') RETURNING id").get() as { id: number }
    ).id;
  }
  return rootId;
}

function addFile(recordingNodeId: number, fields: { trackNo?: number; releaseDate?: string; path?: string }): number {
  const row = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, track_no, release_date)
       VALUES (?, ?, ?, datetime('now'), 0, ?, ?) RETURNING id`,
    )
    .get(
      recordingNodeId,
      libraryRoot(),
      fields.path ?? `/music/${recordingNodeId}-${nextFile++}.flac`,
      fields.trackNo ?? null,
      fields.releaseDate ?? null,
    ) as { id: number };
  return row.id;
}

function addPlay(recordingNodeId: number, fileId: number): void {
  db.prepare(
    "INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, datetime('now'), 200000)",
  ).run(recordingNodeId, fileId);
}

describe("nodeSummary", () => {
  it("returns null for a node that doesn't exist, so the route can 404", () => {
    expect(nodeSummary(db, 999)).toBeNull();
  });

  it("reads an artist's rows straight off the aggregate table", () => {
    const artist = makeNode("artist", "Pussy Riot");
    db.prepare("INSERT INTO artists (node_id, track_count, album_count) VALUES (?, ?, ?)").run(artist, 148, 12);

    expect(nodeSummary(db, artist)).toEqual({ kind: "artist", releases: 12, tracks: 148, topAlbum: null });
  });

  it("counts an artist with no aggregate row yet as zero rather than failing", () => {
    const artist = makeNode("artist", "Not Yet Aggregated");

    expect(nodeSummary(db, artist)).toEqual({ kind: "artist", releases: 0, tracks: 0, topAlbum: null });
  });

  it("leaves topAlbum null until there is play history", () => {
    const artist = makeNode("artist", "Pussy Riot");
    const release = makeNode("release", "MATRIARCHY NOW");
    const recording = makeNode("recording", "POOF BITCH");
    addEdge(recording, artist, "performed_by");
    addEdge(recording, release, "appears_on");
    addFile(recording, {});

    expect((nodeSummary(db, artist) as { topAlbum: unknown }).topAlbum).toBeNull();
  });

  it("picks the artist's most-played release as topAlbum", () => {
    const artist = makeNode("artist", "Pussy Riot");
    const quiet = makeNode("release", "Quiet One");
    const loud = makeNode("release", "MATRIARCHY NOW");

    const quietTrack = makeNode("recording", "b-side");
    addEdge(quietTrack, artist, "performed_by");
    addEdge(quietTrack, quiet, "appears_on");
    addPlay(quietTrack, addFile(quietTrack, {}));

    const loudTrack = makeNode("recording", "POOF BITCH");
    addEdge(loudTrack, artist, "performed_by");
    addEdge(loudTrack, loud, "appears_on");
    const loudFile = addFile(loudTrack, {});
    addPlay(loudTrack, loudFile);
    addPlay(loudTrack, loudFile);

    expect((nodeSummary(db, artist) as { topAlbum: unknown }).topAlbum).toEqual({ id: loud, title: "MATRIARCHY NOW" });
  });

  // 8a3426c gave every artist in a credit its own node, so a collaboration
  // holds two performed_by edges out of one recording. Joining rather than
  // EXISTS would count that recording's play once per credited artist and
  // hand the wrong release the top spot.
  it("counts a collaboration's play once, not once per credited artist", () => {
    const artist = makeNode("artist", "Pussy Riot");
    const feature = makeNode("artist", "Big Freedia");
    const solo = makeNode("release", "Solo Record");
    const collab = makeNode("release", "Collab Record");

    const soloTrack = makeNode("recording", "solo track");
    addEdge(soloTrack, artist, "performed_by");
    addEdge(soloTrack, solo, "appears_on");
    const soloFile = addFile(soloTrack, {});
    addPlay(soloTrack, soloFile);
    addPlay(soloTrack, soloFile);

    const collabTrack = makeNode("recording", "collab track");
    addEdge(collabTrack, artist, "performed_by");
    addEdge(collabTrack, feature, "performed_by");
    addEdge(collabTrack, collab, "appears_on");
    addPlay(collabTrack, addFile(collabTrack, {}));

    expect((nodeSummary(db, artist) as { topAlbum: { title: string } | null }).topAlbum?.title).toBe("Solo Record");
  });

  it("reads a release's rows off the aggregate table, dating it by year", () => {
    const release = makeNode("release", "MATRIARCHY NOW");
    db.prepare(
      "INSERT INTO albums (node_id, track_count, total_duration_ms, year_min, year_max) VALUES (?, ?, ?, ?, ?)",
    ).run(release, 7, 2_700_000, 2023, 2023);

    expect(nodeSummary(db, release)).toEqual({
      kind: "release",
      tracks: 7,
      totalDurationMs: 2_700_000,
      releaseDate: "2023",
    });
  });

  it("leaves a release with no year null rather than stringifying nothing", () => {
    const release = makeNode("release", "Undated");
    db.prepare("INSERT INTO albums (node_id, track_count, total_duration_ms) VALUES (?, ?, ?)").run(release, 3, 600_000);

    expect((nodeSummary(db, release) as { releaseDate: unknown }).releaseDate).toBeNull();
  });

  it("reads a recording from its own row and its lowest-id file", () => {
    const recording = makeNode("recording", "POOF BITCH");
    db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(recording, 195_000);
    addFile(recording, { trackNo: 7, releaseDate: "2022-08-05", path: "/music/a.flac" });
    addFile(recording, { trackNo: 2, releaseDate: "1999-01-01", path: "/music/b.flac" });

    expect(nodeSummary(db, recording)).toEqual({
      kind: "recording",
      trackNo: 7,
      durationMs: 195_000,
      releaseDate: "2022-08-05",
    });
  });

  it("reports a recording with no file at all as nulls, not an error", () => {
    const recording = makeNode("recording", "Orphan");

    expect(nodeSummary(db, recording)).toEqual({
      kind: "recording",
      trackNo: null,
      durationMs: null,
      releaseDate: null,
    });
  });

  it("gives label/year/work/credit nodes no metadata list", () => {
    expect(nodeSummary(db, makeNode("label", "Neon Gold Records"))).toEqual({ kind: "other" });
    expect(nodeSummary(db, makeNode("year", "2023"))).toEqual({ kind: "other" });
  });
});
