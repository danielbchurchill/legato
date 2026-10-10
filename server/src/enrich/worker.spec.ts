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
  fetchUrlRelations: mock(),
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
const { deriveLocalEdges } = await import("../match/edges.js");
const { recompute } = await import("../recompute.js");
const { libraryRevision } = await import("../libraryRevision.js");

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

  // #302: a match that folds a recording into one that already has the mbid
  // changes how many tracks GET /stats counts; one that only records the
  // mbid changes nothing the Library header or the Artists tab reads.
  it("bumps the library revision once for the folds a drain made, when it ends, and not for a match that folds nothing", async () => {
    const canonical = insertNode("Come Together", "The Beatles", 258506);
    db.prepare("UPDATE nodes SET mbid = 'mb-1' WHERE id = ?").run(canonical);
    const duplicates = [insertNode("Come Together", "The Beatles", 258506), insertNode("Come Together", "The Beatles", 258506)];
    const other = insertNode("Something", "The Beatles", 182000);

    const before = libraryRevision();
    applyMatch(db, other, "mb-2", 0.95);
    await runDueJobs(db);
    expect(libraryRevision()).toBe(before);

    for (const duplicate of duplicates) applyMatch(db, duplicate, "mb-1", 0.95);
    expect(libraryRevision()).toBe(before);
    await runDueJobs(db);
    expect(libraryRevision()).toBe(before + 1);
    await runDueJobs(db);
    expect(libraryRevision()).toBe(before + 1);
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

  // Issue #273: the credit a search match comes with is kept, and splits the
  // line straight away rather than at the next start.
  it("keeps a match's artist credit and splits the joined line it explains", async () => {
    const nodeId = insertNode("It's Just Forever", "Cage The Elephant, Alison Mosshart", 200000);
    const { id: fileId } = db.prepare("SELECT id FROM files WHERE recording_node_id = ?").get(nodeId) as { id: number };
    deriveLocalEdges(db, fileId);
    enqueue(nodeId);
    mocked(mbClient.searchRecording).mockResolvedValue([
      {
        mbid: "mb-forever",
        score: 100,
        title: "It's Just Forever",
        artist: "Cage the Elephant",
        artistCredit: [
          { name: "Cage the Elephant", artist: "Cage the Elephant", joinphrase: " feat. " },
          { name: "Alison Mosshart", artist: "Alison Mosshart", joinphrase: "" },
        ],
        durationMs: 200000,
        releases: [],
      },
    ]);

    await runDueJobs(db);

    const performers = db
      .prepare(
        `SELECT n.title FROM edges e JOIN nodes n ON n.id = e.to_node
          WHERE e.from_node = ? AND e.type = 'performed_by' ORDER BY e.id`,
      )
      .all(nodeId) as { title: string }[];
    expect(performers.map((p) => p.title)).toEqual(["Cage The Elephant", "Alison Mosshart"]);
    expect(
      db.prepare("SELECT value FROM field_provenance WHERE node_id = ? AND field = 'artist_credit'").get(nodeId),
    ).toBeDefined();
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

  // Issue #269: a member lookup only runs for an artist a recording names as
  // its performer, or for one of their members and groups.
  function insertLibraryArtist(title: string): number {
    const artist = insertArtistNode(title);
    const recording = db
      .prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id")
      .get(`${title} track`) as { id: number };
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording.id,
      artist,
    );
    return artist;
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
    const beatles = insertLibraryArtist("The Beatles");
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
    const beatles = insertLibraryArtist("The Beatles");
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
    const node = insertLibraryArtist("Totally Obscure Artist");
    enqueueMemberLookup(node);
    mocked(mbClient.searchArtist).mockResolvedValue([]);

    await runDueJobs(db);

    expect(mbClient.fetchArtistMemberRelations).not.toHaveBeenCalled();
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(node) as { status: string };
    expect(job.status).toBe("done");
  });

  it("skips a credit-line title naming more than one artist, without calling MusicBrainz at all", async () => {
    const node = insertLibraryArtist("JPEGMAFIA; Danny Brown");
    enqueueMemberLookup(node);

    await runDueJobs(db);

    expect(mbClient.searchArtist).not.toHaveBeenCalled();
    expect(mbClient.fetchArtistMemberRelations).not.toHaveBeenCalled();
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(node) as { status: string };
    expect(job.status).toBe("done");
  });

  // Issue #269.
  it("drops the job of an artist outside the bound without asking MusicBrainz, so it can be queued again", async () => {
    const node = insertArtistNode("Rory Storm and the Hurricanes");
    enqueueMemberLookup(node);

    await runDueJobs(db);

    expect(mbClient.searchArtist).not.toHaveBeenCalled();
    expect(mbClient.fetchArtistMemberRelations).not.toHaveBeenCalled();
    expect(db.prepare("SELECT id FROM enrich_jobs WHERE node_id = ?").all(node)).toEqual([]);
  });
});

// Issue #269: #61's crawl, bounded. Three library bands whose members have
// other groups, as MusicBrainz lists them. Each group's own page lists its
// members, and each member's page lists their groups, so a lookup run on
// any artist here finds the next level out.
describe("membership bound — issue #269", () => {
  const MEMBERS: Record<string, string[]> = {
    // Level 0: the library.
    "The Beatles": ["John Lennon", "Paul McCartney", "George Harrison", "Ringo Starr", "Pete Best", "Stuart Sutcliffe"],
    Radiohead: ["Thom Yorke", "Jonny Greenwood", "Colin Greenwood", "Ed O'Brien", "Philip Selway"],
    "Talking Heads": ["David Byrne", "Tina Weymouth", "Chris Frantz", "Jerry Harrison"],
    // Level 2: the members' other groups, and their members, the third level.
    "The Quarrymen": ["John Lennon", "Paul McCartney", "George Harrison", "Pete Shotton"],
    "Plastic Ono Band": ["John Lennon", "Yoko Ono", "Klaus Voormann"],
    Wings: ["Paul McCartney", "Linda McCartney", "Denny Laine"],
    "Traveling Wilburys": ["George Harrison", "Bob Dylan", "Tom Petty", "Roy Orbison", "Jeff Lynne"],
    "Rory Storm and the Hurricanes": ["Ringo Starr", "Rory Storm"],
    "The Pete Best Band": ["Pete Best"],
    "Atoms for Peace": ["Thom Yorke", "Flea", "Nigel Godrich"],
    "The Smile": ["Thom Yorke", "Jonny Greenwood", "Tom Skinner"],
    "Tom Tom Club": ["Tina Weymouth", "Chris Frantz"],
    "The Modern Lovers": ["Jerry Harrison", "Jonathan Richman"],
    // Level 4, which only a lookup on the third level would find.
    "Tom Petty and the Heartbreakers": ["Tom Petty", "Mike Campbell"],
    "Electric Light Orchestra": ["Jeff Lynne", "Bev Bevan"],
    "Red Hot Chili Peppers": ["Flea", "Anthony Kiedis"],
  };
  const LIBRARY = ["The Beatles", "Radiohead", "Talking Heads"];
  const THIRD_LEVEL = [
    "Pete Shotton",
    "Yoko Ono",
    "Klaus Voormann",
    "Linda McCartney",
    "Denny Laine",
    "Bob Dylan",
    "Tom Petty",
    "Roy Orbison",
    "Jeff Lynne",
    "Rory Storm",
    "Flea",
    "Nigel Godrich",
    "Tom Skinner",
    "Jonathan Richman",
  ];

  function relationsFor(name: string) {
    const members = (MEMBERS[name] ?? []).map((member) => ({ direction: "backward" as const, name: member }));
    const groups = Object.entries(MEMBERS)
      .filter(([, people]) => people.includes(name))
      .map(([group]) => ({ direction: "forward" as const, name: group }));
    return [...members, ...groups];
  }

  function artistTitles(): string[] {
    return (
      db.prepare("SELECT title FROM nodes WHERE type = 'artist' ORDER BY title").all() as { title: string }[]
    ).map((r) => r.title);
  }

  function jobsFor(title: string): string[] {
    return (
      db
        .prepare(
          `SELECT ej.job_type FROM enrich_jobs ej JOIN nodes n ON n.id = ej.node_id
            WHERE n.type = 'artist' AND n.title = ? ORDER BY ej.job_type`,
        )
        .all(title) as { job_type: string }[]
    ).map((r) => r.job_type);
  }

  beforeEach(() => {
    mocked(mbClient.searchArtist).mockImplementation(async (name: string) => [
      { mbid: `mbid:${name}`, name, score: 100, disambiguation: null },
    ]);
    mocked(mbClient.fetchArtistMemberRelations).mockImplementation(async (mbid: string) =>
      relationsFor(mbid.slice("mbid:".length)),
    );
    mocked(mbClient.fetchUrlRelations).mockResolvedValue([]);
    mocked(deezer.fetchArtistImage).mockResolvedValue(null);

    for (const band of LIBRARY) {
      const recording = db
        .prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id")
        .get(`${band} track`) as { id: number };
      const artist = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(band) as {
        id: number;
      };
      db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
        recording.id,
        artist.id,
      );
    }
  });

  it("resolves #61's two hops and creates or queues nothing on the third level, across scans", async () => {
    // Two scans with a full drain after each: a recompute that queued a
    // lookup for every artist would push the bound out one level per scan.
    for (let scan = 0; scan < 2; scan++) {
      recompute(db);
      await runDueJobs(db);
    }

    const artists = artistTitles();
    // #61's example: The Beatles -> George Harrison -> Traveling Wilburys.
    expect(artists).toContain("George Harrison");
    expect(artists).toContain("Traveling Wilburys");
    const georgesGroups = db
      .prepare(
        `SELECT g.title FROM edges e JOIN nodes m ON m.id = e.from_node JOIN nodes g ON g.id = e.to_node
          WHERE e.type = 'member_of' AND m.title = 'George Harrison' ORDER BY g.title`,
      )
      .all() as { title: string }[];
    expect(georgesGroups.map((g) => g.title)).toEqual(["The Beatles", "The Quarrymen", "Traveling Wilburys"]);

    // The third level is neither created nor queued, and nothing past it.
    for (const name of THIRD_LEVEL) expect(artists).not.toContain(name);
    expect(artists).not.toContain("Tom Petty and the Heartbreakers");
    expect(mbClient.fetchArtistMemberRelations).not.toHaveBeenCalledWith("mbid:Traveling Wilburys");

    // Members and groups of the library get every lookup. The second level
    // gets a photo and a description, but no member lookup of its own.
    expect(jobsFor("George Harrison")).toEqual(["artist_image_lookup", "artist_member_lookup", "description_lookup"]);
    expect(jobsFor("Traveling Wilburys")).toEqual(["artist_image_lookup", "description_lookup"]);

    // How far this reaches for a real library, three bands: the 3 bands,
    // their 15 members, and the members' 10 other groups. Member lookups
    // ran for the first 18.
    expect(artists).toHaveLength(28);
    expect(mbClient.fetchArtistMemberRelations).toHaveBeenCalledTimes(18);
    const queued = db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs WHERE status != 'done'").get() as { n: number };
    expect(queued.n).toBe(0);
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
