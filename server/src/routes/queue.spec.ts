import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { resolveQueueTracks } from "./queue.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

// Mirrors seedRoot's shape in library-roots.spec.ts, trimmed to what
// resolveQueueTracks actually reads (bitrate matters here — it's the
// tie-breaker resolveQueueTracks' own SQL uses to pick a file when a
// collapsed recording has more than one).
function seedFile(title: string, opts: { bitrate?: number; missing?: boolean } = {}): { nodeId: number; fileId: number } {
  const rootId = (
    db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/music/${title}`) as { id: number }
  ).id;
  const nodeId = (
    db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as { id: number }
  ).id;
  const fileId = (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, bitrate, file_mtime, file_size, missing_since)
         VALUES (?, ?, ?, ?, datetime('now'), 0, ?) RETURNING id`,
      )
      .get(nodeId, rootId, `/music/${title}/track.flac`, opts.bitrate ?? 320, opts.missing ? new Date().toISOString() : null) as {
      id: number;
    }
  ).id;
  return { nodeId, fileId };
}

describe("resolveQueueTracks", () => {
  it("preserves the caller's order, including a shuffled (non-sequential) one — #125's shuffled queues hand this their permutation directly", () => {
    const a = seedFile("A");
    const b = seedFile("B");
    const c = seedFile("C");

    // A shuffled play order, not the ids' insertion order.
    const shuffledIds = [c.nodeId, a.nodeId, b.nodeId];
    const tracks = resolveQueueTracks(db, shuffledIds);

    expect(tracks.map((t) => t?.recordingNodeId)).toEqual(shuffledIds);
    expect(tracks.map((t) => t?.fileId)).toEqual([c.fileId, a.fileId, b.fileId]);
  });

  it("returns null in place for an id with no resolvable file, rather than dropping it and shifting everything after it out of position", () => {
    const a = seedFile("A");
    const b = seedFile("B");
    const missingNodeId = 999999;

    const tracks = resolveQueueTracks(db, [a.nodeId, missingNodeId, b.nodeId]);

    expect(tracks).toHaveLength(3);
    expect(tracks[0]?.recordingNodeId).toBe(a.nodeId);
    expect(tracks[1]).toBeNull();
    expect(tracks[2]?.recordingNodeId).toBe(b.nodeId);
  });

  it("treats a file marked missing_since as unresolvable, same as no file at all", () => {
    const missing = seedFile("Gone", { missing: true });

    const tracks = resolveQueueTracks(db, [missing.nodeId]);

    expect(tracks).toEqual([null]);
  });

  it("picks the highest-bitrate file when a collapsed recording has more than one", () => {
    const nodeId = seedFile("Live version", { bitrate: 128 }).nodeId;
    const rootId = (db.prepare("INSERT INTO library_roots (path) VALUES ('/music/dupe') RETURNING id").get() as {
      id: number;
    }).id;
    const betterFileId = (
      db
        .prepare(
          `INSERT INTO files (recording_node_id, library_root_id, file_path, bitrate, file_mtime, file_size)
           VALUES (?, ?, '/music/dupe/track.flac', 1411, datetime('now'), 0) RETURNING id`,
        )
        .get(nodeId, rootId) as { id: number }
    ).id;

    const tracks = resolveQueueTracks(db, [nodeId]);

    expect(tracks[0]?.fileId).toBe(betterFileId);
    expect(tracks[0]?.bitrate).toBe(1411);
  });
});
