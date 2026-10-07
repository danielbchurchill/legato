import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mocked } from "../testing.js";
import * as mbClient from "./mbClient.js";
import * as coverArchive from "./coverArchive.js";
import * as deezer from "./deezer.js";
import * as fingerprint from "../match/fingerprint.js";
import * as acoustid from "./acoustid.js";

mock.module("./mbClient.js", () => ({
  searchRecording: mock(),
  lookupReleaseGroupForRecording: mock(),
  searchArtist: mock(),
  fetchArtistMemberRelations: mock(),
}));
mock.module("./coverArchive.js", () => ({ fetchCaaFrontImage: mock() }));
mock.module("./deezer.js", () => ({ fetchArtistImage: mock() }));
// Real storeCover shells out to ffmpeg to produce resized JPEGs — not
// interesting to this suite, which only cares whether a CAA hit gets
// recorded as a cover_art row at all.
mock.module("../cover/store.js", () => ({ storeCover: mock().mockResolvedValue("fake-hash") }));
// M-9: real computeFingerprint shells out to fpcalc (not installed on the
// machine this was built on) and real lookupFingerprint hits AcoustID's
// live API (needs a client key nobody has configured here) — mocked so
// the fallback's own branching logic is what's under test, not either
// external dependency's availability.
mock.module("../match/fingerprint.js", () => ({ computeFingerprint: mock() }));
mock.module("./acoustid.js", () => ({ lookupFingerprint: mock() }));

const { runDueJobs, applyMatch, tryFingerprintMatch } = await import("./worker.js");

let db: Database;

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
  mock.clearAllMocks();
});

describe("runDueJobs", () => {
  it("applies a confident match: sets node.mbid, files.match_source, and field_provenance", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    enqueue(nodeId);
    mocked(mbClient.searchRecording).mockResolvedValue([
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
    mocked(mbClient.searchRecording).mockResolvedValue([
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
    mocked(mbClient.searchRecording).mockResolvedValue([
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
    mocked(mbClient.searchRecording).mockRejectedValue(new Error("network blip"));

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
    mocked(mbClient.searchRecording).mockRejectedValue(new Error("network blip"));

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
    mocked(mbClient.searchRecording).mockResolvedValue([
      { mbid: "mb-1", score: 100, title: "Come Together", artist: "The Beatles", durationMs: 262000, releases: [] },
    ]);
    mocked(mbClient.lookupReleaseGroupForRecording).mockResolvedValue("rg-1");
    mocked(coverArchive.fetchCaaFrontImage).mockResolvedValue({
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
    mocked(mbClient.searchRecording).mockResolvedValue([
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
    mocked(fingerprint.computeFingerprint).mockResolvedValue(null);

    expect(await tryFingerprintMatch(db, nodeId)).toBe(false);
    expect(acoustid.lookupFingerprint).not.toHaveBeenCalled();
  });

  it("returns false without calling AcoustID when the recording has no known duration", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", null);
    mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");

    expect(await tryFingerprintMatch(db, nodeId)).toBe(false);
    expect(acoustid.lookupFingerprint).not.toHaveBeenCalled();
  });

  it("returns false when AcoustID has nothing, or nothing confident enough", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");
    mocked(acoustid.lookupFingerprint).mockResolvedValue([{ recordingMbid: "mb-weak", score: 0.2 }]);

    expect(await tryFingerprintMatch(db, nodeId)).toBe(false);
    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string | null };
    expect(node.mbid).toBeNull();
  });

  it("applies the top AcoustID match (trusting lookupFingerprint's own best-first order), the same way a text match does", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", 262000);
    mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");
    // Deliberately best-first, matching acoustid.ts's own parseLookupResponse
    // contract — tryFingerprintMatch trusts matches[0] rather than
    // re-sorting or scanning for the max itself.
    mocked(acoustid.lookupFingerprint).mockResolvedValue([
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
    mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");
    mocked(acoustid.lookupFingerprint).mockResolvedValue([{ recordingMbid: "mb-1", score: 0.9 }]);

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
    mocked(mbClient.searchRecording).mockResolvedValue([]);
    mocked(fingerprint.computeFingerprint).mockResolvedValue("fake-fingerprint");
    mocked(acoustid.lookupFingerprint).mockResolvedValue([{ recordingMbid: "mb-1", score: 0.9 }]);

    await runDueJobs(db);

    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string };
    expect(node.mbid).toBe("mb-1");
  });
});

// Issue #61.
describe("processArtistMemberLookup — issue #61", () => {
  function insertArtistNode(title: string): number {
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as {
      id: number;
    };
    return node.id;
  }

  function enqueueMemberLookup(nodeId: number): void {
    db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'artist_member_lookup', 'queued')").run(
      nodeId,
    );
  }

  function memberOfEdges() {
    return db
      .prepare(
        `SELECT fn.title AS member, tn.title AS group_title
         FROM edges e JOIN nodes fn ON fn.id = e.from_node JOIN nodes tn ON tn.id = e.to_node
         WHERE e.type = 'member_of' ORDER BY fn.title, tn.title`,
      )
      .all() as { member: string; group_title: string }[];
  }

  it("resolves the artist's mbid, fetches member relations, and writes the resulting edges", async () => {
    const beatles = insertArtistNode("The Beatles");
    enqueueMemberLookup(beatles);
    mocked(mbClient.searchArtist).mockResolvedValue([
      { mbid: "beatles-mbid", name: "The Beatles", score: 100, disambiguation: null },
    ]);
    mocked(mbClient.fetchArtistMemberRelations).mockResolvedValue([
      { direction: "backward", name: "George Harrison" },
    ]);

    await runDueJobs(db);

    expect(mbClient.fetchArtistMemberRelations).toHaveBeenCalledWith("beatles-mbid");
    expect(memberOfEdges()).toEqual([{ member: "George Harrison", group_title: "The Beatles" }]);
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(beatles) as { status: string };
    expect(job.status).toBe("done");
  });

  it("cascades: a member node created by this job gets its own member-lookup enqueued", async () => {
    const beatles = insertArtistNode("The Beatles");
    enqueueMemberLookup(beatles);
    mocked(mbClient.searchArtist).mockResolvedValue([
      { mbid: "beatles-mbid", name: "The Beatles", score: 100, disambiguation: null },
    ]);
    mocked(mbClient.fetchArtistMemberRelations).mockResolvedValue([
      { direction: "backward", name: "George Harrison" },
    ]);

    await runDueJobs(db);

    const george = db.prepare("SELECT id FROM nodes WHERE type = 'artist' AND title = ?").get("George Harrison") as {
      id: number;
    };
    const cascadedJobs = db
      .prepare("SELECT job_type FROM enrich_jobs WHERE node_id = ? ORDER BY job_type")
      .all(george.id) as { job_type: string }[];
    expect(cascadedJobs.map((j) => j.job_type)).toEqual([
      "artist_image_lookup",
      "artist_member_lookup",
      "description_lookup",
    ]);
  });

  it("marks the job done without fetching relations when the artist mbid can't be resolved", async () => {
    const node = insertArtistNode("Totally Obscure Artist");
    enqueueMemberLookup(node);
    mocked(mbClient.searchArtist).mockResolvedValue([]);

    await runDueJobs(db);

    expect(mbClient.fetchArtistMemberRelations).not.toHaveBeenCalled();
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(node) as { status: string };
    expect(job.status).toBe("done");
  });

  it("skips a credit-line title naming more than one artist, without calling MusicBrainz at all", async () => {
    const node = insertArtistNode("JPEGMAFIA; Danny Brown");
    enqueueMemberLookup(node);

    await runDueJobs(db);

    expect(mbClient.searchArtist).not.toHaveBeenCalled();
    expect(mbClient.fetchArtistMemberRelations).not.toHaveBeenCalled();
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(node) as { status: string };
    expect(job.status).toBe("done");
  });
});

// Issue #272.
describe("processArtistImageLookup", () => {
  it("skips a credit-line title without writing an mbid row the hygiene worklist would list", async () => {
    const node = (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get("Pussy Riot; Slayyyter") as {
      id: number;
    }).id;
    db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'artist_image_lookup', 'queued')").run(node);

    await runDueJobs(db);

    expect(deezer.fetchArtistImage).not.toHaveBeenCalled();
    expect(db.prepare("SELECT field FROM field_provenance WHERE node_id = ?").all(node)).toEqual([]);
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(node) as { status: string };
    expect(job.status).toBe("done");
  });
});
