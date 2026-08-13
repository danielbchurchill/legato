import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { getWorklist } from "./hygiene.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeNode(title: string): number {
  const row = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(row.id);
  return row.id;
}

function makeFile(nodeId: number, path: string, overrides: Record<string, unknown> = {}): number {
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${nodeId}`) as {
    id: number;
  };
  const fields = { match_source: "unmatched", missing_since: null, fuzzy_candidate_node_id: null, ...overrides };
  const row = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size,
                           match_source, missing_since, fuzzy_candidate_node_id)
       VALUES (?, ?, ?, datetime('now'), 0, ?, ?, ?) RETURNING id`,
    )
    .get(nodeId, root.id, path, fields.match_source, fields.missing_since, fields.fuzzy_candidate_node_id) as {
    id: number;
  };
  return row.id;
}

describe("getWorklist", () => {
  it("returns an empty list for a clean library", () => {
    makeFile(makeNode("Clean Track"), "/fake/clean.flac", { match_source: "mbid" });
    expect(getWorklist(db)).toEqual([]);
  });

  it("surfaces a fuzzy_pending file with its candidate", () => {
    const a = makeNode("Come Together");
    const b = makeNode("come together");
    makeFile(a, "/fake/a.flac", { match_source: "mbid" });
    makeFile(b, "/fake/b.flac", { match_source: "fuzzy_pending", fuzzy_candidate_node_id: a });

    const items = getWorklist(db, "fuzzy_pending");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "fuzzy_pending", nodeTitle: "come together", candidateTitle: "Come Together" });
  });

  it("surfaces a missing file", () => {
    const nodeId = makeNode("Vanished Track");
    makeFile(nodeId, "/fake/gone.flac", { missing_since: "2026-01-01 00:00:00" });

    const items = getWorklist(db, "missing_file");
    expect(items).toEqual([
      {
        type: "missing_file",
        fileId: expect.any(Number),
        filePath: "/fake/gone.flac",
        nodeId,
        nodeTitle: "Vanished Track",
        missingSince: "2026-01-01 00:00:00",
      },
    ]);
  });

  it("surfaces an enrichment flag, and only the latest one per node", () => {
    const nodeId = makeNode("Ambiguous Track");
    makeFile(nodeId, "/fake/x.flac");
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', NULL, 'musicbrainz', 0, 'first attempt: ambiguous')",
    ).run(nodeId);
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', NULL, 'musicbrainz', 0, 'second attempt: still ambiguous')",
    ).run(nodeId);

    const items = getWorklist(db, "enrichment_flag");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ note: "second attempt: still ambiguous" });
  });

  it("excludes a node whose latest enrichment attempt actually succeeded", () => {
    const nodeId = makeNode("Eventually Matched");
    makeFile(nodeId, "/fake/y.flac");
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', NULL, 'musicbrainz', 0, 'first attempt: no match')",
    ).run(nodeId);
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', 'mb-123', 'musicbrainz', 1.0, NULL)",
    ).run(nodeId);

    expect(getWorklist(db, "enrichment_flag")).toEqual([]);
  });

  it("aggregates all three categories when no type filter is given", () => {
    const a = makeNode("A");
    const b = makeNode("a");
    makeFile(a, "/fake/a.flac", { match_source: "mbid" });
    makeFile(b, "/fake/b.flac", { match_source: "fuzzy_pending", fuzzy_candidate_node_id: a });

    const missingNode = makeNode("Missing");
    makeFile(missingNode, "/fake/missing.flac", { missing_since: "2026-01-01 00:00:00" });

    const flaggedNode = makeNode("Flagged");
    makeFile(flaggedNode, "/fake/flagged.flac");
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', NULL, 'musicbrainz', 0, 'no match')",
    ).run(flaggedNode);

    const items = getWorklist(db);
    expect(items.map((i) => i.type).sort()).toEqual(["enrichment_flag", "fuzzy_pending", "missing_file"]);
  });
});
