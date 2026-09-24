import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mocked } from "../testing.js";
import * as lrclib from "./lrclib.js";

mock.module("./lrclib.js", () => ({ fetchLrclibLyrics: mock() }));

const { getLyrics } = await import("./service.js");

let db: Database;

function insertRecording(title: string, artist: string | null, durationMs: number | null): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(node.id, durationMs);
  if (artist) {
    const artistNode = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(artist) as {
      id: number;
    };
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      node.id,
      artistNode.id,
    );
  }
  return node.id;
}

beforeEach(() => {
  db = openDb(":memory:");
  mock.clearAllMocks();
});

describe("getLyrics", () => {
  it("fetches, caches, and returns a real hit", async () => {
    const nodeId = insertRecording("Come Together", "The Beatles", 262000);
    mocked(lrclib.fetchLrclibLyrics).mockResolvedValue({
      plainLyrics: "Here come old flat top...",
      syncedLyrics: "[00:12.00]Here come old flat top...",
      instrumental: false,
    });

    const result = await getLyrics(db, nodeId);

    expect(result).toEqual({
      plainLyrics: "Here come old flat top...",
      syncedLyrics: "[00:12.00]Here come old flat top...",
      instrumental: false,
      found: true,
    });
    expect(lrclib.fetchLrclibLyrics).toHaveBeenCalledWith({
      trackName: "Come Together",
      artistName: "The Beatles",
      albumName: null,
      durationSec: 262,
    });
  });

  it("caches a real negative result and does not re-fetch on the next call", async () => {
    const nodeId = insertRecording("Obscure B-Side", "Some Artist", null);
    mocked(lrclib.fetchLrclibLyrics).mockResolvedValue(null);

    const first = await getLyrics(db, nodeId);
    const second = await getLyrics(db, nodeId);

    expect(first).toEqual({ plainLyrics: null, syncedLyrics: null, instrumental: false, found: false });
    expect(second).toEqual(first);
    expect(lrclib.fetchLrclibLyrics).toHaveBeenCalledTimes(1);
  });

  it("reuses a cached hit on the second call without hitting the network again", async () => {
    const nodeId = insertRecording("Come Together", "The Beatles", 262000);
    mocked(lrclib.fetchLrclibLyrics).mockResolvedValue({
      plainLyrics: "lyrics",
      syncedLyrics: null,
      instrumental: false,
    });

    await getLyrics(db, nodeId);
    await getLyrics(db, nodeId);

    expect(lrclib.fetchLrclibLyrics).toHaveBeenCalledTimes(1);
  });

  it("skips the network call (and caching) for a recording with no artist edge yet", async () => {
    const nodeId = insertRecording("Untitled", null, null);

    const result = await getLyrics(db, nodeId);

    expect(result).toEqual({ plainLyrics: null, syncedLyrics: null, instrumental: false, found: false });
    expect(lrclib.fetchLrclibLyrics).not.toHaveBeenCalled();
  });

  it("returns null for a node that isn't a real recording", async () => {
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'The Beatles') RETURNING id").get() as {
      id: number;
    };

    const result = await getLyrics(db, node.id);

    expect(result).toBeNull();
  });
});
