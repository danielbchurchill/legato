import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { generateFacts } from "./facts.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
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

describe("generateFacts", () => {
  it("returns [] for a node that doesn't exist", () => {
    expect(generateFacts(db, 999)).toEqual([]);
  });

  it("generates performed_by/released_in/appears_on facts with clickable targets", () => {
    const recording = makeNode("recording", "Come Together");
    const artist = makeNode("artist", "The Beatles");
    const year = makeNode("year", "1969");
    const release = makeNode("release", "Abbey Road");
    addEdge(recording, artist, "performed_by");
    addEdge(recording, year, "released_in");
    addEdge(recording, release, "appears_on");

    const facts = generateFacts(db, recording);

    expect(facts).toContainEqual({ text: "Performed by The Beatles", targetNodeId: artist });
    expect(facts).toContainEqual({ text: "Released in 1969", targetNodeId: year });
    expect(facts).toContainEqual({ text: "Appears on Abbey Road", targetNodeId: release });
  });

  it("ignores manual edges when generating facts (local edges only)", () => {
    const recording = makeNode("recording", "Yesterday");
    const noteNode = makeNode("recording", "Blackbird");
    addEdge(recording, noteNode, "sounds_like", "manual");

    expect(generateFacts(db, recording)).toEqual([]);
  });

  it("flags multi-instance recordings, matching the real Yellow Submarine collapse case", () => {
    const recording = makeNode("recording", "Yellow Submarine");
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    const root = db.prepare("INSERT INTO library_roots (path) VALUES ('/fake') RETURNING id").get() as {
      id: number;
    };
    for (const path of ["/fake/revolver.flac", "/fake/yellow-submarine.flac"]) {
      db.prepare(
        "INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size) VALUES (?, ?, ?, datetime('now'), 0)",
      ).run(recording, root.id, path);
    }

    const facts = generateFacts(db, recording);
    expect(facts).toContainEqual({ text: "You have this recording across 2 different releases you own" });
  });

  it("gives a non-recording node a count of connected recordings", () => {
    const artist = makeNode("artist", "The Beatles");
    const recA = makeNode("recording", "A");
    const recB = makeNode("recording", "B");
    addEdge(recA, artist, "performed_by");
    addEdge(recB, artist, "performed_by");

    const facts = generateFacts(db, artist);
    expect(facts).toContainEqual({ text: "2 recordings in your collection" });
  });
});
