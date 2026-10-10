import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { nodeSummary } from "./summary.js";
import { libraryRoutes } from "./routes/library.js";
import { statsRoutes } from "./routes/stats.js";

// Issue #354: every query that joins plays with edges, planned as SQLite
// plans it for the 30,000-album synthetic library with nothing played. That
// is the case statistics can't help with: ANALYZE records nothing for an
// empty table, so SQLite takes plays for a large one, and a plan that walks
// every edge looks cheaper to it. These are the rows PRAGMA optimize wrote
// to sqlite_stat1 for that library, loaded into a database of a few rows,
// which SQLite then plans exactly as it would the real one.
const THIRTY_THOUSAND_ALBUMS = [
  ["albums", "albums_primary_artist_idx", "30000 10"],
  ["edges", "edges_from_node_idx", "1541676 5"],
  ["edges", "edges_from_node_source_idx", "1541676 5 5"],
  ["edges", "edges_to_node_idx", "1541676 286"],
  ["edges", "edges_member_of_from_idx", "0 0"],
  ["edges", "edges_member_of_to_idx", "0 0"],
  ["files", "files_fuzzy_match_idx", "150900 4 4"],
  ["files", "files_library_root_id_idx", "300900 1450"],
  ["files", "files_recording_node_id_idx", "300900 1"],
  ["files", "sqlite_autoindex_files_1", "300900 1"],
  ["nodes", "nodes_type_title_lookup_idx", "336152 1001 1"],
  ["nodes", "nodes_type_mbid_unique", "0 0 0"],
];

let db: Database;
let app: FastifyInstance;
let artist: number;

beforeEach(async () => {
  db = openDb(":memory:");
  const node = (type: string, title: string) =>
    (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }).id;
  artist = node("artist", "Artist");
  const release = node("release", "Release");
  const recording = node("recording", "Recording");
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(recording, artist);
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(recording, release);

  db.exec("ANALYZE");
  db.exec("DELETE FROM sqlite_stat1");
  const insert = db.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)");
  for (const row of THIRTY_THOUSAND_ALBUMS) insert.run(...row);
  db.exec("ANALYZE sqlite_schema");

  app = Fastify();
  await app.register(libraryRoutes(db));
  await app.register(statsRoutes(db));
});

afterEach(async () => {
  await app.close();
  db.close();
});

// The statements `run` prepared that read plays.
async function playsQueries(run: () => unknown): Promise<string[]> {
  const prepare = spyOn(db, "prepare");
  try {
    await run();
    return prepare.mock.calls.map(([sql]) => sql).filter((sql) => /\bplays\b/.test(sql));
  } finally {
    prepare.mockRestore();
  }
}

// The lines of a statement's plan that read edges from end to end, rather
// than looking up a node's few edges in an index.
function edgeScans(sql: string): string[] {
  const aliases = [
    "edges",
    ...[...sql.matchAll(/\bedges\s+(\w+)/g)].map((match) => match[1]).filter((word) => !/^(ON|WHERE)$/i.test(word)),
  ];
  const params = (sql.match(/\?/g) ?? []).map(() => 0);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail);
  return plan.filter((line) => aliases.some((alias) => line === `SCAN ${alias}` || line.startsWith(`SCAN ${alias} `)));
}

describe("joins of plays and edges with a large library's statistics and nothing played", () => {
  // Without this, the specs below would pass for the wrong reason.
  it("still walk every edge when SQLite picks the order", () => {
    const plain = `SELECT e.to_node, COUNT(*) FROM plays p
                   JOIN edges e ON e.from_node = p.recording_node_id AND e.type = 'appears_on'
                   GROUP BY e.to_node`;
    expect(edgeScans(plain)).not.toEqual([]);
  });

  it("start an artist's summary from the artist's recordings", async () => {
    const queries = await playsQueries(() => nodeSummary(db, artist));
    expect(queries).toHaveLength(1);
    for (const sql of queries) expect(edgeScans(sql)).toEqual([]);
  });

  it.each(["title", "artist", "year", "dateAdded", "recentlyPlayed"])("start an albums page sorted by %s from plays", async (sort) => {
    const queries = await playsQueries(() => app.inject({ method: "GET", url: `/library/albums?sort=${sort}` }));
    expect(queries).toHaveLength(1);
    for (const sql of queries) expect(edgeScans(sql)).toEqual([]);
  });

  it("start /stats' top artist and top album from plays", async () => {
    const queries = await playsQueries(() => app.inject({ method: "GET", url: "/stats" }));
    expect(queries.filter((sql) => /\bedges\b/.test(sql))).toHaveLength(2);
    for (const sql of queries) expect(edgeScans(sql)).toEqual([]);
  });
});
