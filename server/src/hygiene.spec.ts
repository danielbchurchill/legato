import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSqlite, type Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { getWorklist } from "./hygiene.js";
import { MIGRATIONS } from "./migrations/manifest.generated.js";

let db: Database;

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

  it("surfaces a won't-decode file, and only the latest outcome per node (B-4)", () => {
    const nodeId = makeNode("Leopard-Skin Pill-Box Hat");
    const fileId = makeFile(nodeId, "/fake/leopard-skin.flac");
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, note) VALUES (?, 'decode_error', 'Invalid data found when processing input', 'local', 'Invalid data found when processing input')",
    ).run(nodeId);

    const items = getWorklist(db, "wont_decode");
    expect(items).toEqual([
      {
        type: "wont_decode",
        fileId,
        filePath: "/fake/leopard-skin.flac",
        nodeId,
        nodeTitle: "Leopard-Skin Pill-Box Hat",
        error: "Invalid data found when processing input",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("excludes a node whose latest backfill attempt actually decoded fine", () => {
    const nodeId = makeNode("Fixed Later");
    makeFile(nodeId, "/fake/fixed.flac");
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, note) VALUES (?, 'decode_error', 'corrupt', 'local', 'corrupt')",
    ).run(nodeId);
    db.prepare("INSERT INTO field_provenance (node_id, field, value, source) VALUES (?, 'decode_error', NULL, 'local')").run(
      nodeId,
    );

    expect(getWorklist(db, "wont_decode")).toEqual([]);
  });

  it("aggregates all four categories when no type filter is given", () => {
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

    const wontDecodeNode = makeNode("Won't Decode");
    makeFile(wontDecodeNode, "/fake/wont-decode.flac");
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, note) VALUES (?, 'decode_error', 'corrupt', 'local', 'corrupt')",
    ).run(wontDecodeNode);

    const items = getWorklist(db);
    expect(items.map((i) => i.type).sort()).toEqual(["enrichment_flag", "fuzzy_pending", "missing_file", "wont_decode"]);
  });
});

// #272: the four kinds of row a real library's enrichment worklist held.
describe("getWorklist enrichment_flag (#272)", () => {
  const PHOTO_SKIP = "artist tag names more than one artist — no photo looked up";

  function makeArtist(title: string): number {
    return (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as { id: number }).id;
  }

  function flag(nodeId: number, note: string): void {
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', NULL, 'musicbrainz', 0, ?)",
    ).run(nodeId, note);
  }

  it("leaves out an artist whose photo lookup was skipped", () => {
    flag(makeArtist("Pussy Riot; Slayyyter"), PHOTO_SKIP);

    expect(getWorklist(db, "enrichment_flag")).toEqual([]);
  });

  it("keeps a recording MusicBrainz found no match for", () => {
    const nodeId = makeNode("Unfindable");
    makeFile(nodeId, "/fake/unfindable.flac");
    flag(nodeId, "no MusicBrainz match found");

    expect(getWorklist(db, "enrichment_flag")).toMatchObject([{ nodeId, note: "no MusicBrainz match found" }]);
  });

  it("keeps an ambiguous recording", () => {
    const nodeId = makeNode("Tied");
    makeFile(nodeId, "/fake/tied.flac");
    flag(nodeId, "ambiguous — 2 tied candidates, needs manual confirmation");

    expect(getWorklist(db, "enrichment_flag")).toMatchObject([{ nodeId }]);
  });

  it("leaves out a recording that has an MBID now, though its last enrichment row is still null", () => {
    const nodeId = makeNode("Tagged Later");
    makeFile(nodeId, "/fake/tagged-later.flac", { match_source: "mbid" });
    flag(nodeId, "no MusicBrainz match found");
    db.prepare("UPDATE nodes SET mbid = 'mb-from-tag' WHERE id = ?").run(nodeId);

    expect(getWorklist(db, "enrichment_flag")).toEqual([]);
  });
});

describe("migration 0034 (#272)", () => {
  let dataDir: string | null = null;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it("deletes the null mbid rows the artist photo job wrote, and nothing else", () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "legato-0034-"));
    const dbPath = path.join(dataDir, "legato.db");
    const old = openSqlite(dbPath);
    old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    for (const { version, sql } of MIGRATIONS) {
      if (version >= 34) break;
      old.exec(sql);
      old.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    }
    const artist = (old.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'A; B') RETURNING id").get() as { id: number }).id;
    const recording = (old.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'Song') RETURNING id").get() as { id: number })
      .id;
    const insert = old.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, ?, ?, 'musicbrainz', ?, ?)",
    );
    insert.run(artist, "mbid", null, 0, "artist tag names more than one artist — no photo looked up");
    insert.run(artist, "artist_mbid", "artist-mb", 0.8, null);
    insert.run(recording, "mbid", null, 0, "no MusicBrainz match found");
    insert.run(recording, "mbid", "rec-mb", 1, null);
    old.close();

    const upgraded = openDb(dbPath, { log: () => {} });
    const rows = upgraded.prepare("SELECT node_id, field, value FROM field_provenance ORDER BY id").all();
    upgraded.close();

    expect(rows).toEqual([
      { node_id: artist, field: "artist_mbid", value: "artist-mb" },
      { node_id: recording, field: "mbid", value: null },
      { node_id: recording, field: "mbid", value: "rec-mb" },
    ]);
  });
});
