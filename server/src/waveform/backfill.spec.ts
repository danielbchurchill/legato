import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mocked } from "../testing.js";
import * as decode from "./decode.js";
import * as store from "./store.js";

mock.module("./decode.js", () => ({ computePeaks: mock() }));
mock.module("./store.js", () => ({ isCached: mock(), writePeaks: mock() }));

const { backfillWaveforms } = await import("./backfill.js");

let db: Database;

function insertFile(hash: string): { fileId: number; nodeId: number } {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
    id: number;
  };
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${node.id}`) as {
    id: number;
  };
  const file = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, file_hash)
       VALUES (?, ?, ?, datetime('now'), 0, ?) RETURNING id`,
    )
    .get(node.id, root.id, `/fake/${node.id}.flac`, hash) as { id: number };
  return { fileId: file.id, nodeId: node.id };
}

function decodeProvenanceFor(nodeId: number) {
  return db
    .prepare("SELECT value, note FROM field_provenance WHERE node_id = ? AND field = 'decode_error' ORDER BY id DESC LIMIT 1")
    .get(nodeId) as { value: string | null; note: string | null } | undefined;
}

beforeEach(() => {
  db = openDb(":memory:");
  mock.clearAllMocks();
});

describe("backfillWaveforms — B-4's decode-failure tracking", () => {
  it("records a real error message when ffmpeg can't decode the file", async () => {
    const { nodeId } = insertFile("hash-1");
    mocked(store.isCached).mockResolvedValue(false);
    mocked(decode.computePeaks).mockRejectedValue(new Error("Invalid data found when processing input"));

    const progress = await backfillWaveforms(db);

    expect(progress.failures).toBe(1);
    expect(progress.peaksComputed).toBe(0);
    const provenance = decodeProvenanceFor(nodeId);
    expect(provenance?.value).toBe("Invalid data found when processing input");
  });

  it("clears a previous failure once the file decodes successfully", async () => {
    const { nodeId } = insertFile("hash-2");
    mocked(store.isCached).mockResolvedValue(false);
    mocked(decode.computePeaks).mockResolvedValue([0.1, 0.2, 0.3]);

    await backfillWaveforms(db);

    const provenance = decodeProvenanceFor(nodeId);
    expect(provenance?.value).toBeNull();
    expect(store.writePeaks).toHaveBeenCalledWith("hash-2", [0.1, 0.2, 0.3]);
  });

  it("writes nothing to field_provenance for a file whose peaks are already cached", async () => {
    const { nodeId } = insertFile("hash-3");
    mocked(store.isCached).mockResolvedValue(true);

    const progress = await backfillWaveforms(db);

    expect(progress.skipped).toBe(1);
    expect(decode.computePeaks).not.toHaveBeenCalled();
    expect(decodeProvenanceFor(nodeId)).toBeUndefined();
  });

  it("keeps processing the rest of the library after one file fails", async () => {
    const a = insertFile("hash-a");
    const b = insertFile("hash-b");
    mocked(store.isCached).mockResolvedValue(false);
    mocked(decode.computePeaks)
      .mockRejectedValueOnce(new Error("corrupt"))
      .mockResolvedValueOnce([0.5]);

    const progress = await backfillWaveforms(db);

    expect(progress.failures).toBe(1);
    expect(progress.peaksComputed).toBe(1);
    expect(decodeProvenanceFor(a.nodeId)?.value).toBe("corrupt");
    expect(decodeProvenanceFor(b.nodeId)?.value).toBeNull();
  });
});
