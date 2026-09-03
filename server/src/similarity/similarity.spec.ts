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

function appearsOn(db: Database.Database, recording: number, release: number): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
    recording,
    release,
  );
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

  // P-2: the app opens on the albums graph, where selecting a release used
  // to always return []. A release's vector is the centroid of its own
  // recordings' — this exercises that a release anchor ranks *other
  // releases*, never the recordings that fed the average.
  it("gives releases a similarity vector by averaging their recordings, and ranks other releases", () => {
    const db = openDb(":memory:");
    const beatles = makeNode(db, "artist", "The Beatles");
    const dylan = makeNode(db, "artist", "Bob Dylan");

    const abbeyRoad = makeNode(db, "release", "Abbey Road");
    const track1 = makeRecording(db, "Come Together", { artist: beatles, year: 1969, genre: ["rock"] });
    const track2 = makeRecording(db, "Something", { artist: beatles, year: 1969, genre: ["rock"] });
    appearsOn(db, track1, abbeyRoad);
    appearsOn(db, track2, abbeyRoad);

    const letItBe = makeNode(db, "release", "Let It Be");
    const track3 = makeRecording(db, "Get Back", { artist: beatles, year: 1970, genre: ["rock"] });
    appearsOn(db, track3, letItBe);

    const blonde = makeNode(db, "release", "Blonde on Blonde");
    const track4 = makeRecording(db, "Visions of Johanna", { artist: dylan, year: 1966, genre: ["folk"] });
    appearsOn(db, track4, blonde);

    recomputeSimilarityFeatures(db);

    const similar = findMostSimilar(db, abbeyRoad, 5);
    expect(similar.map((r) => r.nodeId)).not.toContain(track1);
    expect(similar.map((r) => r.nodeId)).not.toContain(track2);
    expect(similar[0].nodeId).toBe(letItBe); // same artist, closer decade
    expect(similar.map((r) => r.nodeId)).toContain(blonde);
  });

  // P-3: three tracks off one record used to be nearly indistinguishable
  // (genre/artist/label/type/decade identical), so "more like this" on a
  // track could only ever answer "the rest of this album". Same-release
  // candidates are excluded outright now.
  it("excludes a track's own release from its 'more like this' candidates", () => {
    const db = openDb(":memory:");
    const beatles = makeNode(db, "artist", "The Beatles");

    const abbeyRoad = makeNode(db, "release", "Abbey Road");
    const anchor = makeRecording(db, "Taxman", { artist: beatles, year: 1969, genre: ["rock"] });
    const sameRelease = makeRecording(db, "Here Comes the Sun", { artist: beatles, year: 1969, genre: ["rock"] });
    appearsOn(db, anchor, abbeyRoad);
    appearsOn(db, sameRelease, abbeyRoad);

    const letItBe = makeNode(db, "release", "Let It Be");
    const otherRelease = makeRecording(db, "Get Back", { artist: beatles, year: 1970, genre: ["rock"] });
    appearsOn(db, otherRelease, letItBe);

    recomputeSimilarityFeatures(db);

    const similar = findMostSimilar(db, anchor, 5);
    expect(similar.map((r) => r.nodeId)).not.toContain(sameRelease);
    expect(similar.map((r) => r.nodeId)).toContain(otherRelease);
  });

  // Reproduces the #22 grey-screen bug: a recording whose file row
  // disappears (a rescan, a hygiene resolution) drops out of
  // recomputeSimilarityFeatures' `recordingRows` query, so its old
  // node_similarity_features row was never touched again. Once a later
  // recompute widens the library's vocabulary (a new artist/genre), that
  // orphaned vector is a different length than every fresh one, and any
  // candidate pool that included it threw out of cosineSimilarity's length
  // check — a 500 the client had no boundary to catch, taking the whole
  // app down over one optional similarity strip.
  it("prunes a recording's vector once its file is gone, so a later vocabulary change can't leave a stale-length vector behind", () => {
    const db = openDb(":memory:");
    const beatles = makeNode(db, "artist", "The Beatles");
    const orphan = makeRecording(db, "Ghost Track", { artist: beatles, year: 1969, genre: ["rock"] });
    recomputeSimilarityFeatures(db);

    // The file backing this recording disappears without the node itself
    // being deleted — matches how the real orphaned rows were found (files
    // with recording_node_id pointing at recordings with zero rows left).
    db.prepare("DELETE FROM files WHERE recording_node_id = ?").run(orphan);

    // A new artist and genre widen buildFeatureSpace's one-hot vocabulary,
    // so a vector built in this pass is a different length than the
    // orphan's, which was built before either existed.
    const dylan = makeNode(db, "artist", "Bob Dylan");
    const anchor = makeRecording(db, "Come Together", { artist: beatles, year: 1969, genre: ["rock"] });
    const other = makeRecording(db, "Like a Rolling Stone", { artist: dylan, year: 1965, genre: ["folk"] });
    recomputeSimilarityFeatures(db);

    const orphanRow = db.prepare("SELECT 1 FROM node_similarity_features WHERE node_id = ?").get(orphan);
    expect(orphanRow).toBeUndefined();

    expect(() => findMostSimilar(db, anchor, 5)).not.toThrow();
    expect(() => findMostDissimilar(db, anchor, 5)).not.toThrow();
    expect(findMostSimilar(db, anchor, 5).map((r) => r.nodeId)).toContain(other);
  });
});
