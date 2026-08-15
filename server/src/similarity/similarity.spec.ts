import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { findMostDissimilar, findMostSimilar, recomputeSimilarityFeatures } from "./similarity.js";

function makeNode(db: Database.Database, type: string, title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
    id: number;
  };
  return row.id;
}

function makeRecording(
  db: Database.Database,
  title: string,
  opts: { artist?: number; label?: number; year?: number; genre?: string[]; releaseType?: string; durationMs?: number },
): number {
  const recording = makeNode(db, "recording", title);
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(
    recording,
    opts.durationMs ?? null,
  );
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${recording}`) as {
    id: number;
  };
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, genre, release_type, duration_ms)
     VALUES (?, ?, ?, datetime('now'), 0, ?, ?, ?)`,
  ).run(
    recording,
    root.id,
    `/fake/${recording}.flac`,
    opts.genre ? JSON.stringify(opts.genre) : null,
    opts.releaseType ?? null,
    opts.durationMs ?? null,
  );

  if (opts.artist != null) {
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      opts.artist,
    );
  }
  if (opts.label != null) {
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      recording,
      opts.label,
    );
  }
  if (opts.year != null) {
    const year = makeNode(db, "year", String(opts.year));
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_in', 'local')").run(
      recording,
      year,
    );
  }

  return recording;
}

describe("recomputeSimilarityFeatures + findMostSimilar/findMostDissimilar", () => {
  it("ranks a same-artist track above an unrelated one for 'more like this'", () => {
    const db = openDb(":memory:");
    const beatles = makeNode(db, "artist", "The Beatles");
    const dylan = makeNode(db, "artist", "Bob Dylan");

    const anchor = makeRecording(db, "Come Together", { artist: beatles, year: 1969, genre: ["rock"] });
    const sameArtist = makeRecording(db, "Something", { artist: beatles, year: 1969, genre: ["rock"] });
    const otherArtist = makeRecording(db, "Like a Rolling Stone", { artist: dylan, year: 1965, genre: ["folk"] });

    recomputeSimilarityFeatures(db);

    const similar = findMostSimilar(db, anchor, 2);
    expect(similar[0].nodeId).toBe(sameArtist);
    expect(similar.map((r) => r.nodeId)).toContain(otherArtist);
  });

  it("returns an empty result for a node with no cached vector (not a recording)", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "The Beatles");
    makeRecording(db, "Come Together", { artist });
    recomputeSimilarityFeatures(db);

    expect(findMostSimilar(db, artist, 3)).toEqual([]);
    expect(findMostDissimilar(db, artist, 3)).toEqual([]);
  });

  it("is idempotent and reflects fresh data after a second recompute", () => {
    const db = openDb(":memory:");
    const beatles = makeNode(db, "artist", "The Beatles");
    const dylan = makeNode(db, "artist", "Bob Dylan");
    const anchor = makeRecording(db, "Come Together", { artist: beatles, year: 1969 });
    makeRecording(db, "Something", { artist: beatles, year: 1969 });

    recomputeSimilarityFeatures(db);
    const before = findMostSimilar(db, anchor, 5);

    // A new, unrelated recording appears — recompute should pick it up.
    const newTrack = makeRecording(db, "Like a Rolling Stone", { artist: dylan, year: 1965 });
    recomputeSimilarityFeatures(db);
    const after = findMostSimilar(db, anchor, 5);

    expect(before.map((r) => r.nodeId)).not.toContain(newTrack);
    expect(after.map((r) => r.nodeId)).toContain(newTrack);
  });

  it("finds a real dissimilar track for 'completely different'", () => {
    const db = openDb(":memory:");
    const beatles = makeNode(db, "artist", "The Beatles");
    const anchor = makeRecording(db, "Come Together", { artist: beatles, year: 1969, genre: ["rock"], durationMs: 259000 });
    // A handful of similar Beatles tracks (so the anchor's own neighborhood
    // isn't the *only* populated region).
    for (let i = 0; i < 3; i++) {
      makeRecording(db, `Track ${i}`, { artist: beatles, year: 1969, genre: ["rock"], durationMs: 260000 });
    }
    // A genuinely different, well-populated pocket: a different artist,
    // decade, and duration profile, several tracks deep.
    const bowie = makeNode(db, "artist", "David Bowie");
    const dissimilarTracks = Array.from({ length: 4 }, (_, i) =>
      makeRecording(db, `Ambient ${i}`, { artist: bowie, year: 2020, genre: ["ambient"], durationMs: 40000 }),
    );

    recomputeSimilarityFeatures(db);

    const dissimilar = findMostDissimilar(db, anchor, 2);
    expect(dissimilar).toHaveLength(2);
    for (const r of dissimilar) expect(dissimilarTracks).toContain(r.nodeId);
  });
});
