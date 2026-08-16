import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import * as mbClient from "./mbClient.js";
import * as coverArchive from "./coverArchive.js";
import * as fingerprint from "../match/fingerprint.js";
import * as acoustid from "./acoustid.js";

vi.mock("./mbClient.js", () => ({
  searchRecording: vi.fn(),
  lookupReleaseGroupForRecording: vi.fn(),
}));
vi.mock("./coverArchive.js", () => ({ fetchCaaFrontImage: vi.fn() }));
// Real storeCover shells out to ffmpeg to produce resized JPEGs — not
// interesting to this suite, which only cares whether a CAA hit gets
// recorded as a cover_art row at all.
vi.mock("../cover/store.js", () => ({ storeCover: vi.fn().mockResolvedValue("fake-hash") }));
// M-9: real computeFingerprint shells out to fpcalc (not installed on the
// machine this was built on) and real lookupFingerprint hits AcoustID's
// live API (needs a client key nobody has configured here) — mocked so
// the fallback's own branching logic is what's under test, not either
// external dependency's availability.
vi.mock("../match/fingerprint.js", () => ({ computeFingerprint: vi.fn() }));
vi.mock("./acoustid.js", () => ({ lookupFingerprint: vi.fn() }));

const { runDueJobs, applyMatch, tryFingerprintMatch } = await import("./worker.js");

let db: Database.Database;

function insertNode(title: string, artist: string | null, durationMs: number | null): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(node.id, durationMs);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${node.id}`) as {
    id: number;
  };
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw, match_source)
     VALUES (?, ?, ?, datetime('now'), 0, ?, 'unmatched')`,
  ).run(node.id, root.id, `/fake/${node.id}/track.flac`, JSON.stringify({ artist }));
  return node.id;
}

function enqueue(nodeId: number): void {
  db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'recording_lookup', 'queued')").run(
    nodeId,
  );
}

beforeEach(() => {
  db = openDb(":memory:");
  vi.clearAllMocks();
});

describe("runDueJobs", () => {
  it("applies a confident match: sets node.mbid, files.match_source, and field_provenance", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    enqueue(nodeId);
    vi.mocked(mbClient.searchRecording).mockResolvedValue([
      { mbid: "mb-1", score: 100, title: "Come Together", artist: "The Beatles", durationMs: 262000, releases: [] },
    ]);

    await runDueJobs(db);

    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string };
    expect(node.mbid).toBe("mb-1");
    const file = db.prepare("SELECT match_source, match_confidence FROM files WHERE recording_node_id = ?").get(nodeId) as {
      match_source: string;
      match_confidence: number;
    };
    expect(file.match_source).toBe("mbid");
    // No longer a bare 1 (M-3): confidence is textSearch.ts's weighted
    // score, not MB's own relevance score — title/artist/length all match
    // exactly, but there's no release data to score against, so
    // releasetype/album/totaltracks/date land at their neutral/no-data
    // defaults rather than a perfect 1.
    expect(file.match_confidence).toBeCloseTo(0.6981, 4);
    const provenance = db.prepare("SELECT * FROM field_provenance WHERE node_id = ?").get(nodeId) as {
      value: string;
      confidence: number;
    };
    expect(provenance.value).toBe("mb-1");
    expect(provenance.confidence).toBeCloseTo(0.6981, 4);
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(nodeId) as { status: string };
    expect(job.status).toBe("done");
  });

  it("merges onto an already-canonical node instead of creating a duplicate mbid", async () => {
    const canonicalId = insertNode("Yellow Submarine", "The Beatles", 160000);
    db.prepare("UPDATE nodes SET mbid = 'mb-existing' WHERE id = ?").run(canonicalId);

    const duplicateId = insertNode("Yellow Submarine", "The Beatles", 160100);
    enqueue(duplicateId);
    vi.mocked(mbClient.searchRecording).mockResolvedValue([
      { mbid: "mb-existing", score: 100, title: "Yellow Submarine", artist: "The Beatles", durationMs: 160000, releases: [] },
    ]);

    await runDueJobs(db);

    const file = db.prepare("SELECT recording_node_id FROM files WHERE recording_node_id != ?").all(999) as {
      recording_node_id: number;
    }[];
    expect(file.every((f) => f.recording_node_id === canonicalId)).toBe(true);
  });

  it("does not apply an ambiguous result, but records it in match_candidates for the maintenance view (M-5)", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", null);
    enqueue(nodeId);
    vi.mocked(mbClient.searchRecording).mockResolvedValue([
      {
        mbid: "mb-1",
        score: 100,
        title: "Come Together",
        artist: "The Beatles",
        durationMs: 258506,
        releases: [{ title: "Abbey Road", releaseType: "Album", date: "1969-09-26", trackCount: 17, trackNo: 1 }],
      },
      {
        mbid: "mb-2",
        score: 100,
        title: "Come Together",
        artist: "The Beatles",
        durationMs: 258506,
        releases: [{ title: "Abbey Road (2019 Mix)", releaseType: "Album", date: "2019", trackCount: 17, trackNo: 1 }],
      },
    ]);

    await runDueJobs(db);

    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string | null };
    expect(node.mbid).toBeNull();
    const provenance = db.prepare("SELECT note FROM field_provenance WHERE node_id = ?").get(nodeId) as {
      note: string;
    };
    expect(provenance.note).toContain("ambiguous");
    // No more UUIDs dumped in the note — that's what match_candidates is for.
    expect(provenance.note).not.toContain("mb-1");

    const candidates = db
      .prepare("SELECT mbid, release_title, release_date, score FROM match_candidates WHERE node_id = ? ORDER BY mbid")
      .all(nodeId) as { mbid: string; release_title: string; release_date: string; score: number }[];
    expect(candidates.map((c) => ({ mbid: c.mbid, release_title: c.release_title, release_date: c.release_date }))).toEqual([
      { mbid: "mb-1", release_title: "Abbey Road", release_date: "1969-09-26" },
      { mbid: "mb-2", release_title: "Abbey Road (2019 Mix)", release_date: "2019" },
    ]);
    // The weighted 0-1 confidence (textSearch.ts's scoreCandidate), not
    // MusicBrainz's raw 0-100 score both candidates share here — storing
    // the raw value would write a nonsense match_confidence if this
    // candidate is later resolved through the picker, and would order the
    // picker by exactly the flawed signal M-3 exists to fix.
    for (const c of candidates) {
      expect(c.score).toBeGreaterThan(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }

    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(nodeId) as { status: string };
    expect(job.status).toBe("done"); // terminal, not a retryable error
  });

  it("resolving via applyMatch (the M-5 picker's own write path) clears any leftover candidates", () => {
    const nodeId = insertNode("Come Together", "The Beatles", 258506);
    db.prepare(
      "INSERT INTO match_candidates (node_id, mbid, release_title, release_date, duration_ms, score) VALUES (?, 'mb-1', 'Abbey Road', '1969', 258506, 100)",
    ).run(nodeId);

    applyMatch(db, nodeId, "mb-1", 0.95);

    const remaining = db.prepare("SELECT COUNT(*) AS n FROM match_candidates WHERE node_id = ?").get(nodeId) as {
      n: number;
    };
    expect(remaining.n).toBe(0);
  });

  it("skips the search entirely for a malformed tag and never calls MusicBrainz", async () => {
    const nodeId = insertNode("Vol 1 - Past Masters", "The Beatles", null);
    enqueue(nodeId);

    await runDueJobs(db);

    expect(mbClient.searchRecording).not.toHaveBeenCalled();
    const provenance = db.prepare("SELECT note FROM field_provenance WHERE node_id = ?").get(nodeId) as {
      note: string;
    };
    expect(provenance.note).toContain("malformed");
  });

  it("backs off on a network error instead of marking the job done", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", null);
    enqueue(nodeId);
    vi.mocked(mbClient.searchRecording).mockRejectedValue(new Error("network blip"));

    await runDueJobs(db);

    const job = db.prepare("SELECT status, attempts, next_attempt_at, last_error FROM enrich_jobs WHERE node_id = ?").get(
      nodeId,
    ) as { status: string; attempts: number; next_attempt_at: string; last_error: string };
    expect(job.status).toBe("error");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toContain("network blip");
    expect(new Date(job.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("stores next_attempt_at in the same format SQLite's own datetime('now') produces", async () => {
    // Regression test: JS's toISOString() ("...T...Z") and SQLite's
    // datetime('now') ("YYYY-MM-DD HH:MM:SS") don't compare correctly as
    // TEXT — 'T' sorts after a space, so a job backed off via
    // toISOString() would never become "due" again. This caught a real
    // bug found by watching a live retry never fire, not by inspection.
    const nodeId = insertNode("Come Together", "The Beatles", null);
    enqueue(nodeId);
    vi.mocked(mbClient.searchRecording).mockRejectedValue(new Error("network blip"));

    await runDueJobs(db);

    const job = db.prepare("SELECT next_attempt_at FROM enrich_jobs WHERE node_id = ?").get(nodeId) as {
      next_attempt_at: string;
    };
    expect(job.next_attempt_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // The actual guarantee: SQLite's own comparison must eventually flip
    // true, using SQLite's own clock and format on both sides — not just
    // JS Date parsing (which is lenient enough to hide the bug).
    const willBecomeDue = db
      .prepare("SELECT next_attempt_at <= datetime('now', '+1 hour') AS due FROM enrich_jobs WHERE node_id = ?")
      .get(nodeId) as { due: number };
    expect(willBecomeDue.due).toBe(1);
  });

  it("queues and resolves a Cover Art Archive lookup for a matched recording's art-less release", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    const release = db.prepare("INSERT INTO nodes (type, title) VALUES ('release', 'Abbey Road') RETURNING id").get() as {
      id: number;
    };
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      nodeId,
      release.id,
    );
    enqueue(nodeId);
    vi.mocked(mbClient.searchRecording).mockResolvedValue([
      { mbid: "mb-1", score: 100, title: "Come Together", artist: "The Beatles", durationMs: 262000, releases: [] },
    ]);
    vi.mocked(mbClient.lookupReleaseGroupForRecording).mockResolvedValue("rg-1");
    vi.mocked(coverArchive.fetchCaaFrontImage).mockResolvedValue({
      bytes: Buffer.from("fake-jpeg"),
      mime: "image/jpeg",
    });

    await runDueJobs(db);

    const caaJob = db
      .prepare("SELECT status FROM enrich_jobs WHERE node_id = ? AND job_type = 'cover_art_lookup'")
      .get(release.id) as { status: string } | undefined;
    expect(caaJob?.status).toBe("done");
    expect(mbClient.lookupReleaseGroupForRecording).toHaveBeenCalledWith("mb-1");
    expect(coverArchive.fetchCaaFrontImage).toHaveBeenCalledWith("rg-1");

    const cover = db.prepare("SELECT source, hash FROM cover_art WHERE node_id = ?").get(release.id) as {
      source: string;
      hash: string;
    };
    expect(cover.source).toBe("caa");
    expect(cover.hash).toBe("fake-hash");
  });

  it("does not queue a Cover Art Archive lookup when the release already has art", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    const release = db.prepare("INSERT INTO nodes (type, title) VALUES ('release', 'Abbey Road') RETURNING id").get() as {
      id: number;
    };
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      nodeId,
      release.id,
    );
    db.prepare(
      "INSERT INTO cover_art (node_id, source, hash, mime) VALUES (?, 'folder', 'existing-hash', 'image/jpeg')",
    ).run(release.id);
    enqueue(nodeId);
    vi.mocked(mbClient.searchRecording).mockResolvedValue([
      { mbid: "mb-1", score: 100, title: "Come Together", artist: "The Beatles", durationMs: 262000, releases: [] },
    ]);

    await runDueJobs(db);

    const caaJob = db
      .prepare("SELECT id FROM enrich_jobs WHERE node_id = ? AND job_type = 'cover_art_lookup'")
      .get(release.id);
    expect(caaJob).toBeUndefined();
    expect(mbClient.lookupReleaseGroupForRecording).not.toHaveBeenCalled();
  });
});

describe("tryFingerprintMatch — M-9's text-search fallback", () => {
  it("returns false when the node has no file at all", async () => {
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
      id: number;
    };
    expect(await tryFingerprintMatch(db, node.id)).toBe(false);
    expect(fingerprint.computeFingerprint).not.toHaveBeenCalled();
  });

  it("returns false when fpcalc can't produce a fingerprint (missing binary, undecodable file)", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    vi.mocked(fingerprint.computeFingerprint).mockResolvedValue(null);

    expect(await tryFingerprintMatch(db, nodeId)).toBe(false);
    expect(acoustid.lookupFingerprint).not.toHaveBeenCalled();
  });

  it("returns false without calling AcoustID when the recording has no known duration", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", null);
    vi.mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");

    expect(await tryFingerprintMatch(db, nodeId)).toBe(false);
    expect(acoustid.lookupFingerprint).not.toHaveBeenCalled();
  });

  it("returns false when AcoustID has nothing, or nothing confident enough", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    vi.mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");
    vi.mocked(acoustid.lookupFingerprint).mockResolvedValue([{ recordingMbid: "mb-weak", score: 0.2 }]);

    expect(await tryFingerprintMatch(db, nodeId)).toBe(false);
    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string | null };
    expect(node.mbid).toBeNull();
  });

  it("applies the top AcoustID match (trusting lookupFingerprint's own best-first order), the same way a text match does", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    vi.mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");
    // Deliberately best-first, matching acoustid.ts's own parseLookupResponse
    // contract — tryFingerprintMatch trusts matches[0] rather than
    // re-sorting or scanning for the max itself.
    vi.mocked(acoustid.lookupFingerprint).mockResolvedValue([
      { recordingMbid: "mb-strong", score: 0.91 },
      { recordingMbid: "mb-weak", score: 0.4 },
    ]);

    expect(await tryFingerprintMatch(db, nodeId)).toBe(true);
    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string };
    expect(node.mbid).toBe("mb-strong");
  });

  it("falls back to fingerprinting when there's no local artist tag to search with at all", async () => {
    const nodeId = insertNode("Come Together", null, 262000);
    enqueue(nodeId);
    vi.mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");
    vi.mocked(acoustid.lookupFingerprint).mockResolvedValue([{ recordingMbid: "mb-1", score: 0.9 }]);

    await runDueJobs(db);

    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string };
    expect(node.mbid).toBe("mb-1");
    const provenance = db
      .prepare("SELECT note FROM field_provenance WHERE node_id = ? ORDER BY id DESC LIMIT 1")
      .get(nodeId) as { note: string | null };
    expect(provenance.note).not.toBe("no local artist tag to search with");
  });

  it("falls back to fingerprinting when a real text search comes back with no match", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    enqueue(nodeId);
    vi.mocked(mbClient.searchRecording).mockResolvedValue([]);
    vi.mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");
    vi.mocked(acoustid.lookupFingerprint).mockResolvedValue([{ recordingMbid: "mb-1", score: 0.9 }]);

    await runDueJobs(db);

    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string };
    expect(node.mbid).toBe("mb-1");
  });
});
