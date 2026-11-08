import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { libraryRoutes } from "./routes/library.js";

// Issue #383: each sort of the Tracks table walks an index in its own order
// and stops at the page, rather than sorting all of a 300,000-track library
// for every page. That's a choice SQLite makes from what sqlite_stat1 says,
// so these are the rows PRAGMA optimize wrote for the 30,000-album synthetic
// library after migration 0054, loaded into a database of a few rows, which
// SQLite then plans exactly as it would the real one (as
// plays-join-plans.spec.ts does for #354).
const THIRTY_THOUSAND_ALBUMS = [
  ["edges", "edges_from_node_idx", "1548267 5"],
  ["edges", "edges_from_node_source_idx", "1548267 5 5"],
  ["edges", "edges_to_node_idx", "1548267 318"],
  ["files", "files_recording_node_id_idx", "300000 1"],
  ["files", "sqlite_autoindex_files_1", "300000 1"],
  ["nodes", "nodes_type_created_at_idx", "335062 1270 225"],
  ["nodes", "nodes_type_title_idx", "335062 1270 1"],
  ["nodes", "nodes_type_title_lookup_idx", "335062 1270 1"],
  ["nodes", "nodes_type_mbid_unique", "0 0 0"],
  ["recordings", "recordings_album_node_id_idx", "300000 10"],
  ["recordings", "recordings_artist_node_id_idx", "300000 96"],
  ["recordings", "recordings_canonical_duration_ms_idx", "300000 2"],
  ["recordings", "recordings_format_idx", "300000 1905"],
  ["recordings", "recordings_work_node_id_idx", "300000 1905"],
];

let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(":memory:");
  const artist = (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'Artist') RETURNING id").get() as { id: number }).id;
  const recording = (db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'Track') RETURNING id").get() as { id: number }).id;
  db.prepare("INSERT INTO recordings (node_id, artist_node_id) VALUES (?, ?)").run(recording, artist);

  db.exec("ANALYZE");
  db.exec("DELETE FROM sqlite_stat1");
  const insert = db.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)");
  for (const row of THIRTY_THOUSAND_ALBUMS) insert.run(...row);
  db.exec("ANALYZE sqlite_schema");

  app = Fastify();
  await app.register(libraryRoutes(db));
});

afterEach(async () => {
  await app.close();
  db.close();
});

function plan(sql: string): string[] {
  // `?` once a value, `?N` once a number.
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));
  const count = numbered.length > 0 ? Math.max(...numbered) : (sql.match(/\?/g) ?? []).length;
  const params = Array.from({ length: count }, () => 0);
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail);
}

// The statements a request prepared that page through tracks.
async function pageQueries(url: string): Promise<string[]> {
  const prepare = spyOn(db, "prepare");
  try {
    await app.inject({ method: "GET", url });
    return prepare.mock.calls.map(([sql]) => sql).filter((sql) => /\bLIMIT\b/.test(sql));
  } finally {
    prepare.mockRestore();
  }
}

// A sort of every row that reaches the ORDER BY, as against one that only
// orders each run of equal keys ("LAST TERM", "RIGHT PART").
const sortsEverything = (lines: string[]) => lines.filter((line) => line === "USE TEMP B-TREE FOR ORDER BY");

describe("a Tracks page with a large library's statistics", () => {
  // Without this, the specs below could pass for the wrong reason: the
  // shape the table used to page with, each track's artist joined and its
  // NULLs ordered last by expression, sorts every track.
  it("sorts every track the way a page used to be read", () => {
    const before = `SELECT n.id FROM nodes n JOIN recordings r ON r.node_id = n.id
                    LEFT JOIN nodes artist ON artist.id = r.artist_node_id
                    WHERE n.type = 'recording'
                    ORDER BY (artist.title IS NULL) ASC, artist.title ASC, n.id ASC LIMIT 150 OFFSET 150000`;
    expect(sortsEverything(plan(before))).not.toEqual([]);
  });

  for (const sort of ["title", "artist", "album", "duration", "format", "dateAdded"]) {
    for (const dir of ["asc", "desc"]) {
      it(`walks an index for ${sort} ${dir}, past the tracks with a ${sort} and into those without`, async () => {
        // Deep enough that every sort's tracks without a key are read too.
        const queries = await pageQueries(`/library/tracks?sort=${sort}&dir=${dir}&limit=150&offset=150000`);
        expect(queries.length).toBeGreaterThan(0);
        for (const sql of queries) expect({ sql, sorts: sortsEverything(plan(sql)) }).toEqual({ sql, sorts: [] });
      });
    }
  }

  // A search finds its tracks from the matching names (routes/library.ts's
  // SEARCH_HITS), then sorts only those, so it never reads every track's
  // artist or album.
  it("finds a search's tracks by name, through the indexes", async () => {
    const queries = await pageQueries("/library/tracks?q=love&sort=artist&dir=asc&limit=150&offset=0");
    const lines = queries.flatMap(plan);
    expect(lines.filter((line) => /^SCAN (r|recordings)\b/.test(line))).toEqual([]);
    expect(lines.filter((line) => /^SEARCH (a|al) USING COVERING INDEX nodes_type_title_idx/.test(line))).toHaveLength(2);
  });
});
