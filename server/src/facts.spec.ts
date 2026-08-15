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

  it("phrases session 4's widened edge types (label/credit/collaboration), not their raw type strings", () => {
    const recording = makeNode("recording", "Come Together");
    const label = makeNode("label", "Apple Records");
    const producer = makeNode("credit", "George Martin");
    const engineer = makeNode("credit", "Geoff Emerick");
    const featured = makeNode("artist", "Billy Preston");
    addEdge(recording, label, "released_on");
    addEdge(recording, producer, "produced_by");
    addEdge(recording, engineer, "engineered_by");
    addEdge(recording, featured, "featured_artist");

    const artistA = makeNode("artist", "The Beatles");
    const artistB = makeNode("artist", "Billy Preston");
    addEdge(artistA, artistB, "collaborated_with");

    const albumA = makeNode("release", "Abbey Road");
    const albumB = makeNode("release", "Let It Be");
    addEdge(albumA, albumB, "same_artist");
    addEdge(albumA, albumB, "same_label");

    const recordingFacts = generateFacts(db, recording);
    expect(recordingFacts).toContainEqual({ text: "Released on Apple Records", targetNodeId: label });
    expect(recordingFacts).toContainEqual({ text: "Produced by George Martin", targetNodeId: producer });
    expect(recordingFacts).toContainEqual({ text: "Engineered by Geoff Emerick", targetNodeId: engineer });
    expect(recordingFacts).toContainEqual({ text: "Featuring Billy Preston", targetNodeId: featured });

    const artistFacts = generateFacts(db, artistA);
    expect(artistFacts).toContainEqual({ text: "Collaborated with Billy Preston", targetNodeId: artistB });

    const albumFacts = generateFacts(db, albumA);
    expect(albumFacts).toContainEqual({ text: "Same artist as Let It Be", targetNodeId: albumB });
    expect(albumFacts).toContainEqual({ text: "Same label as Let It Be", targetNodeId: albumB });
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
