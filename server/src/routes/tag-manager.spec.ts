import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { getMissingField } from "./tag-manager.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeNode(title: string, mbid: string | null = null): number {
  const row = db
    .prepare("INSERT INTO nodes (type, title, mbid) VALUES ('recording', ?, ?) RETURNING id")
    .get(title, mbid) as { id: number };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(row.id);
  return row.id;
}

function makeFile(nodeId: number, path: string, overrides: Record<string, unknown> = {}): number {
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${nodeId}`) as {
    id: number;
  };
  const fields = { bpm: null, label: null, release_date: null, release_type: null, ...overrides };
  const row = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size,
                           bpm, label, release_date, release_type)
       VALUES (?, ?, ?, datetime('now'), 0, ?, ?, ?, ?) RETURNING id`,
    )
    .get(nodeId, root.id, path, fields.bpm, fields.label, fields.release_date, fields.release_type) as {
    id: number;
  };
  return row.id;
}

function makeArtistEdge(recordingNodeId: number, artistTitle: string): void {
  const artist = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(artistTitle) as {
    id: number;
  };
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
    recordingNodeId,
    artist.id,
  );
}

describe("getMissingField", () => {
  it("returns only files missing bpm", () => {
    const withBpm = makeNode("Has BPM");
    makeFile(withBpm, "/fake/a.flac", { bpm: 120 });
    const withoutBpm = makeNode("No BPM");
    makeFile(withoutBpm, "/fake/b.flac");

    const rows = getMissingField(db, "bpm");
    expect(rows).toEqual([{ id: withoutBpm, title: "No BPM", artist: null }]);
  });

  it("returns only files missing label", () => {
    const withLabel = makeNode("Has Label");
    makeFile(withLabel, "/fake/a.flac", { label: "Sub Pop" });
    const withoutLabel = makeNode("No Label");
    makeFile(withoutLabel, "/fake/b.flac");

    const rows = getMissingField(db, "label");
    expect(rows).toEqual([{ id: withoutLabel, title: "No Label", artist: null }]);
  });

  it("returns only files missing release_date", () => {
    const withDate = makeNode("Has Date");
    makeFile(withDate, "/fake/a.flac", { release_date: "1999-01-01" });
    const withoutDate = makeNode("No Date");
    makeFile(withoutDate, "/fake/b.flac");

    const rows = getMissingField(db, "release_date");
    expect(rows).toEqual([{ id: withoutDate, title: "No Date", artist: null }]);
  });

  it("returns only files missing release_type", () => {
    const withType = makeNode("Has Type");
    makeFile(withType, "/fake/a.flac", { release_type: "album" });
    const withoutType = makeNode("No Type");
    makeFile(withoutType, "/fake/b.flac");

    const rows = getMissingField(db, "release_type");
    expect(rows).toEqual([{ id: withoutType, title: "No Type", artist: null }]);
  });

  it("includes the artist name via the performed_by edge when present", () => {
    const nodeId = makeNode("No BPM With Artist");
    makeFile(nodeId, "/fake/a.flac");
    makeArtistEdge(nodeId, "The Beatles");

    const rows = getMissingField(db, "bpm");
    expect(rows).toEqual([{ id: nodeId, title: "No BPM With Artist", artist: "The Beatles" }]);
  });

  it("returns an empty list when every file has the field set", () => {
    const nodeId = makeNode("Complete");
    makeFile(nodeId, "/fake/a.flac", { bpm: 90 });

    expect(getMissingField(db, "bpm")).toEqual([]);
  });

  it("returns recordings with no mbid for 'unmatched'", () => {
    const matched = makeNode("Matched", "mb-123");
    makeFile(matched, "/fake/a.flac");
    const unmatched = makeNode("Unmatched", null);
    makeFile(unmatched, "/fake/b.flac");

    const rows = getMissingField(db, "unmatched");
    expect(rows).toEqual([{ id: unmatched, title: "Unmatched", artist: null }]);
  });

  it("excludes non-recording node types from 'unmatched'", () => {
    db.prepare("INSERT INTO nodes (type, title, mbid) VALUES ('artist', 'Some Artist', NULL)").run();

    expect(getMissingField(db, "unmatched")).toEqual([]);
  });
});
