import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import * as mbClient from "./mbClient.js";

vi.mock("./mbClient.js", () => ({ searchRecording: vi.fn() }));

const { runDueJobs } = await import("./worker.js");

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
      { mbid: "mb-1", score: 100, title: "Come Together", artist: "The Beatles", durationMs: 262000 },
    ]);

    await runDueJobs(db);

    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string };
    expect(node.mbid).toBe("mb-1");
    const file = db.prepare("SELECT match_source, match_confidence FROM files WHERE recording_node_id = ?").get(nodeId) as {
      match_source: string;
      match_confidence: number;
    };
    expect(file.match_source).toBe("mbid");
    expect(file.match_confidence).toBe(1);
    const provenance = db.prepare("SELECT * FROM field_provenance WHERE node_id = ?").get(nodeId) as {
      value: string;
      confidence: number;
    };
    expect(provenance.value).toBe("mb-1");
    expect(provenance.confidence).toBe(1);
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(nodeId) as { status: string };
    expect(job.status).toBe("done");
  });

  it("merges onto an already-canonical node instead of creating a duplicate mbid", async () => {
    const canonicalId = insertNode("Yellow Submarine", "The Beatles", 160000);
    db.prepare("UPDATE nodes SET mbid = 'mb-existing' WHERE id = ?").run(canonicalId);

    const duplicateId = insertNode("Yellow Submarine", "The Beatles", 160100);
    enqueue(duplicateId);
    vi.mocked(mbClient.searchRecording).mockResolvedValue([
      { mbid: "mb-existing", score: 100, title: "Yellow Submarine", artist: "The Beatles", durationMs: 160000 },
    ]);

    await runDueJobs(db);

    const file = db.prepare("SELECT recording_node_id FROM files WHERE recording_node_id != ?").all(999) as {
      recording_node_id: number;
    }[];
    expect(file.every((f) => f.recording_node_id === canonicalId)).toBe(true);
  });

  it("does not apply an ambiguous result, but records it for a future hygiene view", async () => {
    const nodeId = insertNode("Come Together", "The Beatles", null);
    enqueue(nodeId);
    vi.mocked(mbClient.searchRecording).mockResolvedValue([
      { mbid: "mb-1", score: 100, title: "Come Together", artist: "The Beatles", durationMs: null },
      { mbid: "mb-2", score: 100, title: "Come Together", artist: "The Beatles", durationMs: null },
    ]);

    await runDueJobs(db);

    const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId) as { mbid: string | null };
    expect(node.mbid).toBeNull();
    const provenance = db.prepare("SELECT note FROM field_provenance WHERE node_id = ?").get(nodeId) as {
      note: string;
    };
    expect(provenance.note).toContain("ambiguous");
    const job = db.prepare("SELECT status FROM enrich_jobs WHERE node_id = ?").get(nodeId) as { status: string };
    expect(job.status).toBe("done"); // terminal, not a retryable error
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
});
