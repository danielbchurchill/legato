import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { resolveCoverForNode } from "../cover/extract.js";
import { libraryRevision } from "../libraryRevision.js";

// The library view's layouts (issue #126 — see DESIGN.md "The library"): a
// paginated, sortable, searchable read model over the same albums, artists
// and tracks the graph already draws. GET /nodes exists for the canvas and
// returns the graph in one shot, up to 5,000 nodes (fine for a force layout
// that needs every node up front) — the library view instead has to stay
// smooth scrolling through 30k albums, and has to see all of them, so it
// gets its own limit/offset routes rather than asking the client to
// paginate an array it already downloaded whole.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function clampOffset(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// LIKE's own wildcards (%, _) are meaningless to a user typing a search
// query, so a literal one in a title (not rare — "Boy_Scout", "50%") must
// not act as a wildcard back at them. Escaped with backslash and paired
// with an explicit ESCAPE clause below, same idea as every other
// user-input-into-a-pattern situation.
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

// Every sort column is wrapped the same way: NULLs sort last regardless of
// direction (an album with no year, a track that's never been played,
// shouldn't jump to the top just because the direction flipped), then the
// real column, then node id as a stable tiebreaker so paging never
// reshuffles rows that compare equal.
function orderClause(column: string, dir: "asc" | "desc", idColumn: string): string {
  const direction = dir === "desc" ? "DESC" : "ASC";
  return `(${column} IS NULL) ASC, ${column} ${direction}, ${idColumn} ASC`;
}

const ALBUM_SORTS = {
  artist: "artist.title",
  title: "n.title",
  year: "al.year_min",
  dateAdded: "n.created_at",
  recentlyPlayed: "rlp.last_played_at",
} as const;
export type AlbumSort = keyof typeof ALBUM_SORTS;

// The column each sort orders a search's hits by (searchTracks); a page
// with no search walks an index instead (TRACK_PAGES).
const TRACK_SORTS = {
  title: "n.title",
  artist: "artist.title",
  album: "album.title",
  duration: "r.canonical_duration_ms",
  format: "r.format",
  dateAdded: "n.created_at",
} as const;
export type TrackSort = keyof typeof TRACK_SORTS;

// As an artist list reads: without regard to case or accents, so "alt-J"
// and "Ólafur Arnalds" sort among the A's and O's, not after "Zappa".
// SQLite's NOCASE folds ASCII case only, and bun:sqlite has no ICU
// collation, so the list is sorted here rather than in SQL. It's one row per
// artist with records of their own, a few thousand at most. The albums and
// tracks sorts compare titles as stored.
const nameCollator = new Intl.Collator(undefined, { sensitivity: "base" });
const ARTIST_SORTS = {
  name: (a: ArtistRow, b: ArtistRow) => nameCollator.compare(a.name, b.name),
} as const;
export type ArtistSort = keyof typeof ARTIST_SORTS;

// `sort in SORTS` is true of "constructor" and every other key a plain
// object inherits, which then reached the SQL as `undefined`.
function pickSort<Sort extends string>(sorts: Record<Sort, unknown>, raw: string | undefined, fallback: Sort): Sort {
  return raw != null && Object.hasOwn(sorts, raw) ? (raw as Sort) : fallback;
}

type LibraryQuery = {
  q?: string;
  sort?: string;
  dir?: string;
  limit?: string;
  offset?: string;
};

export type AlbumRow = {
  id: number;
  title: string;
  artistId: number | null;
  artistName: string | null;
  year: number | null;
  trackCount: number;
  totalDurationMs: number;
  dateAdded: string;
  coverHash: string | null;
};

export type TrackRow = {
  id: number;
  title: string;
  artistId: number | null;
  artistName: string | null;
  albumId: number | null;
  albumTitle: string | null;
  durationMs: number | null;
  format: string | null;
  dateAdded: string;
};

export type ArtistRow = {
  id: number;
  name: string;
  releases: number;
};

// The artists the library lists (#276): an artist with records of its own,
// meaning the primary artist of at least one album. That's
// entities/aggregate.ts's rule for an album's artist, which is the rule the
// map clusters records by (src/canvas/clusters.ts): each track with a file
// goes to its first performed_by credit that is an artist, and a record to
// whoever most of its tracks went to, ties to the lower id. So every artist
// listed here has records beside it on the map. An artist who is only ever featured, or credited after
// someone else, has no record of its own and is left out: they'd fill the
// grid with names that lead nowhere.
//
// One definition, read twice: the Artists tab pages through it below, and
// GET /stats counts it for the Library header, so the two can't disagree.
// Both used to read the map's graph, which stops at 5,000 nodes (#302).
export const LIBRARY_ARTISTS = `
  SELECT a.id AS id, a.title AS name, COUNT(*) AS releases
  FROM albums al
  JOIN nodes a ON a.id = al.primary_artist_node_id
  WHERE a.type = 'artist'
  GROUP BY al.primary_artist_node_id`;

// The whole list, sorted, once per revision of the library and per sort,
// for each database. Ties go to the lower id either way, so paging never
// reshuffles equal names.
//
// The Artists tab asks for 3,000 artists as 20 pages of 150, and each page
// used to rerun the GROUP BY and sort every artist, on the request loop, to
// keep one slice. Now the first page of a revision does that and the rest
// are slices. What the list reads (the albums table and the artists' names)
// is only written by a recompute, which bumps the revision when it's done
// (libraryRevision.ts), so a list is never kept past a change.
const sortedArtists = new WeakMap<Database, { revision: number; lists: Map<string, ArtistRow[]> }>();

function libraryArtists(db: Database, sort: ArtistSort, dir: "asc" | "desc"): ArtistRow[] {
  const revision = libraryRevision();
  let cache = sortedArtists.get(db);
  if (cache?.revision !== revision) {
    cache = { revision, lists: new Map() };
    sortedArtists.set(db, cache);
  }
  const key = `${sort} ${dir}`;
  let list = cache.lists.get(key);
  if (!list) {
    list = db.prepare(LIBRARY_ARTISTS).all() as ArtistRow[];
    const compare = ARTIST_SORTS[sort];
    list.sort((a, b) => (dir === "desc" ? compare(b, a) : compare(a, b)) || a.id - b.id);
    cache.lists.set(key, list);
  }
  return list;
}

// The tab's first page in the default order sorts the same list, so the
// header and the tab share one read per revision.
export function countLibraryArtists(db: Database): number {
  return libraryArtists(db, "name", "asc").length;
}

function listArtists(
  db: Database,
  { sort, dir, limit, offset }: { sort: ArtistSort; dir: "asc" | "desc"; limit: number; offset: number },
): { items: ArtistRow[]; total: number } {
  const all = libraryArtists(db, sort, dir);
  return { items: all.slice(offset, offset + limit), total: all.length };
}

// The people the library credits (#389): every producer and engineer on a
// track with a file, the credit nodes the map draws. The phone's library
// lists them beside albums, artists and tracks. Someone who also performs
// has the artist node instead (match/edges.ts, #273), and is listed under
// artists, not here.
//
// Paged like the artists: the whole list read once, then sliced. A
// recompute bumps the library's revision, but MusicBrainz credits arrive
// one enrichment job at a time without one (enrich/credits.ts), so the list
// is also read again once a newer edge exists. Edge ids only grow
// (AUTOINCREMENT). A job that only takes a credit away shows at the next
// revision.
export type CreditRole = "producer" | "engineer";

export type CreditRow = {
  id: number;
  name: string;
  /** What they did on the library's tracks: producer, engineer, or both, in that order. */
  roles: CreditRole[];
  tracks: number;
};

const LIBRARY_CREDITS = `
  SELECT c.id AS id, c.title AS name,
         MAX(e.type = 'produced_by') AS produced,
         MAX(e.type = 'engineered_by') AS engineered,
         COUNT(DISTINCT e.from_node) AS tracks
  FROM nodes c
  JOIN edges e ON e.to_node = c.id
  WHERE c.type = 'credit'
    AND e.type IN ('produced_by', 'engineered_by')
    AND EXISTS (SELECT 1 FROM files f WHERE f.recording_node_id = e.from_node)
  GROUP BY c.id`;

const CREDIT_SORTS = {
  name: (a: CreditRow, b: CreditRow) => nameCollator.compare(a.name, b.name),
} as const;
export type CreditSort = keyof typeof CREDIT_SORTS;

// The rows are read once per revision and newest edge, and sorted once per
// order. The read is the slow part: at 30,000 albums, with 100,000 produced_by
// edges over 500 people, it takes about 90 ms, all of it finding each edge's
// row and its track's file.
const creditCache = new WeakMap<
  Database,
  { revision: number; newestEdge: number; rows: CreditRow[]; lists: Map<string, CreditRow[]> }
>();

function libraryCredits(db: Database, sort: CreditSort, dir: "asc" | "desc"): CreditRow[] {
  const revision = libraryRevision();
  const newestEdge = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM edges").get() as { id: number }).id;
  let cache = creditCache.get(db);
  if (cache?.revision !== revision || cache.newestEdge !== newestEdge) {
    const rows = db.prepare(LIBRARY_CREDITS).all() as {
      id: number;
      name: string;
      produced: number;
      engineered: number;
      tracks: number;
    }[];
    cache = {
      revision,
      newestEdge,
      rows: rows.map(({ id, name, produced, engineered, tracks }) => ({
        id,
        name,
        roles: [...(produced ? (["producer"] as const) : []), ...(engineered ? (["engineer"] as const) : [])],
        tracks,
      })),
      lists: new Map(),
    };
    creditCache.set(db, cache);
  }
  const key = `${sort} ${dir}`;
  let list = cache.lists.get(key);
  if (!list) {
    const compare = CREDIT_SORTS[sort];
    list = [...cache.rows].sort((a, b) => (dir === "desc" ? compare(b, a) : compare(a, b)) || a.id - b.id);
    cache.lists.set(key, list);
  }
  return list;
}

function listAlbums(
  db: Database,
  { q, sort, dir, limit, offset }: { q: string | null; sort: AlbumSort; dir: "asc" | "desc"; limit: number; offset: number },
): { items: AlbumRow[]; total: number } {
  const where = q ? "WHERE (n.title LIKE ? ESCAPE '\\' OR artist.title LIKE ? ESCAPE '\\')" : "";
  const whereParams = q ? [likePattern(q), likePattern(q)] : [];

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM albums al
         JOIN nodes n ON n.id = al.node_id
         LEFT JOIN nodes artist ON artist.id = al.primary_artist_node_id
         ${where}`,
      )
      .get(...whereParams) as { count: number }
  ).count;

  // CROSS JOIN starts release_last_played from plays, each play then finding
  // its recording's few edges by edges_from_node_idx, as routes/stats.ts's
  // topByEdge does and for the same reason (issue #354). With nothing played,
  // plays has no statistics, and SQLite went through every appears_on edge
  // instead: half a second a page at 30,000 albums, statistics or not.
  const rows = db
    .prepare(
      `WITH release_last_played AS (
         SELECT e.to_node AS release_node_id, MAX(p.started_at) AS last_played_at
         FROM plays p
         CROSS JOIN edges e ON e.from_node = p.recording_node_id
         WHERE e.type = 'appears_on'
         GROUP BY e.to_node
       )
       SELECT
         al.node_id AS id,
         n.title AS title,
         al.primary_artist_node_id AS artistId,
         artist.title AS artistName,
         al.year_min AS year,
         al.track_count AS trackCount,
         al.total_duration_ms AS totalDurationMs,
         n.created_at AS dateAdded
       FROM albums al
       JOIN nodes n ON n.id = al.node_id
       LEFT JOIN nodes artist ON artist.id = al.primary_artist_node_id
       LEFT JOIN release_last_played rlp ON rlp.release_node_id = al.node_id
       ${where}
       ORDER BY ${orderClause(ALBUM_SORTS[sort], dir, "n.id")}
       LIMIT ? OFFSET ?`,
    )
    .all(...whereParams, limit, offset) as Omit<AlbumRow, "coverHash">[];

  // Cover resolution is per-node JS (nodes.ts does the same, see its own
  // comment) — cheap because it only ever runs over one page's worth of
  // rows, never the full 30k-album table.
  return { items: rows.map((row) => ({ ...row, coverHash: resolveCoverForNode(db, row.id)?.hash ?? null })), total };
}

// The Tracks table (#126). At 30,000 albums it's 300,000 tracks, and a page
// took 0.2 to 3.4 s and a search 4 to 6 s (#383), because each row's artist,
// album and format were found from its edges and files, a few lookups a row,
// before anything could be sorted, counted or filtered. Those are stored on
// the track now (migration 0054, written by entities/aggregate.ts at each
// recompute), and each sort walks an index in its own order and stops at
// the page it was asked for, so a page reads about as far as its offset
// (TRACK_PAGES below).
//
// A track is a recordings row. Every recording node has one, made with it
// (scan/scanner.ts, match/collapse.ts), and only recording nodes do, so the
// sorts that walk recording nodes and those that walk recordings rows list
// the same tracks, and the total counts either.
//
// Every order is the one orderClause gives: the key, tracks without one
// last either way, then id. The artist is the track's own, by the album
// artist's rule (#359, entities/aggregate.ts's trackArtists).

type Page = { limit: number; offset: number };
type SqlDirection = "ASC" | "DESC";

function pageIds(db: Database, sql: string, limit: number, offset: number): number[] {
  return (db.prepare(sql).all(limit, offset) as { id: number }[]).map((row) => row.id);
}

// A sort by a key some tracks lack: those with it, in its order (`present`),
// then those without, by id (`absent`). How many have it (`presentCount`) is
// only asked when the page starts past them.
function nullsLast(db: Database, { limit, offset }: Page, present: string, presentCount: string, absent: string): number[] {
  const ids = pageIds(db, present, limit, offset);
  if (ids.length === limit) return ids;
  const count = ids.length > 0 ? offset + ids.length : (db.prepare(presentCount).get() as { count: number }).count;
  return [...ids, ...pageIds(db, absent, limit - ids.length, Math.max(0, offset - count))];
}

// By the title of the artist or album each track names: those in title
// order, and each one's tracks by id, so a page reads only as far as its
// offset. Reading every track and looking up its artist to sort them all
// took about 0.4 s. CROSS JOIN pins that order of the loops, as
// release_last_played's does, whatever the statistics say. Two with the
// same title still interleave their tracks by id, as one key: SQLite sorts
// each run of equal titles by id as it goes. The stored ids only ever name
// an artist or a release node (aggregate.ts), so the type is the index's,
// not a filter.
function byNamedNode(type: "artist" | "release", column: "artist_node_id" | "album_node_id") {
  return (db: Database, dir: SqlDirection, page: Page) =>
    nullsLast(
      db,
      page,
      `SELECT r.node_id AS id FROM nodes named CROSS JOIN recordings r ON r.${column} = named.id
       WHERE named.type = '${type}'
       ORDER BY named.title ${dir}, r.node_id ASC LIMIT ? OFFSET ?`,
      `SELECT COUNT(*) AS count FROM recordings WHERE ${column} IS NOT NULL`,
      `SELECT node_id AS id FROM recordings WHERE ${column} IS NULL ORDER BY node_id LIMIT ? OFFSET ?`,
    );
}

// A library has a handful of formats, so walking the format index backwards
// for a descending sort finds most of the library under one value with its
// ids the wrong way round, and sorted them all again (0.4 s). So the page is
// put together a format at a time instead: how many tracks have each, from
// the index alone, then the ones the page reaches from each, by id.
function byFormat(db: Database, dir: SqlDirection, { limit, offset }: Page): number[] {
  const formats = db
    .prepare(`SELECT format, COUNT(*) AS count FROM recordings GROUP BY format ORDER BY format IS NULL, format ${dir}`)
    .all() as { format: string | null; count: number }[];
  const ofFormat = db.prepare("SELECT node_id AS id FROM recordings WHERE format IS ? ORDER BY node_id LIMIT ? OFFSET ?");
  const ids: number[] = [];
  let skip = offset;
  for (const { format, count } of formats) {
    if (ids.length === limit) break;
    if (skip >= count) {
      skip -= count;
      continue;
    }
    ids.push(...(ofFormat.all(format, limit - ids.length, skip) as { id: number }[]).map((row) => row.id));
    skip = 0;
  }
  return ids;
}

// Title and date added are never missing, so their walk is the whole order.
const TRACK_PAGES: Record<TrackSort, (db: Database, dir: SqlDirection, page: Page) => number[]> = {
  title: (db, dir, { limit, offset }) =>
    pageIds(db, `SELECT id FROM nodes WHERE type = 'recording' ORDER BY title ${dir}, id ASC LIMIT ? OFFSET ?`, limit, offset),
  dateAdded: (db, dir, { limit, offset }) =>
    pageIds(db, `SELECT id FROM nodes WHERE type = 'recording' ORDER BY created_at ${dir}, id ASC LIMIT ? OFFSET ?`, limit, offset),
  duration: (db, dir, page) =>
    nullsLast(
      db,
      page,
      `SELECT node_id AS id FROM recordings WHERE canonical_duration_ms IS NOT NULL
       ORDER BY canonical_duration_ms ${dir}, node_id ASC LIMIT ? OFFSET ?`,
      "SELECT COUNT(*) AS count FROM recordings WHERE canonical_duration_ms IS NOT NULL",
      "SELECT node_id AS id FROM recordings WHERE canonical_duration_ms IS NULL ORDER BY node_id LIMIT ? OFFSET ?",
    ),
  artist: byNamedNode("artist", "artist_node_id"),
  album: byNamedNode("release", "album_node_id"),
  format: byFormat,
};

// A search finds the few artists and albums whose names match before their
// tracks, rather than every track's artist and album to test each one: the
// tracks whose own title matches, those by a matching artist, and those on a
// matching album. Then only those are sorted, joined to what their sort
// reads.
const SEARCH_HITS = `
  WITH hits(id) AS (
    SELECT id FROM nodes WHERE type = 'recording' AND title LIKE ?1 ESCAPE '\\'
    UNION
    SELECT r.node_id FROM nodes a CROSS JOIN recordings r ON r.artist_node_id = a.id
     WHERE a.type = 'artist' AND a.title LIKE ?1 ESCAPE '\\'
    UNION
    SELECT r.node_id FROM nodes al CROSS JOIN recordings r ON r.album_node_id = al.id
     WHERE al.type = 'release' AND al.title LIKE ?1 ESCAPE '\\'
  )`;

const TRACK_SORT_JOINS: Record<TrackSort, string> = {
  title: "JOIN nodes n ON n.id = h.id",
  dateAdded: "JOIN nodes n ON n.id = h.id",
  duration: "JOIN recordings r ON r.node_id = h.id",
  format: "JOIN recordings r ON r.node_id = h.id",
  artist: "JOIN recordings r ON r.node_id = h.id LEFT JOIN nodes artist ON artist.id = r.artist_node_id",
  album: "JOIN recordings r ON r.node_id = h.id LEFT JOIN nodes album ON album.id = r.album_node_id",
};

// The page and the count come from one pass over the hits: counted on their
// own as well, a search that matches most of the library (a single letter)
// found its 300,000 hits twice. A page past the last hit has no row to carry
// the count, so that one is counted on its own.
function searchTracks(db: Database, q: string, sort: TrackSort, dir: "asc" | "desc", { limit, offset }: Page) {
  const pattern = likePattern(q);
  const rows = db
    .prepare(
      `${SEARCH_HITS}
       SELECT h.id AS id, COUNT(*) OVER () AS total FROM hits h
       ${TRACK_SORT_JOINS[sort]}
       ORDER BY ${orderClause(TRACK_SORTS[sort], dir, "h.id")}
       LIMIT ?2 OFFSET ?3`,
    )
    .all(pattern, limit, offset) as { id: number; total: number }[];
  const total =
    rows[0]?.total ??
    (offset === 0 ? 0 : (db.prepare(`${SEARCH_HITS} SELECT COUNT(*) AS count FROM hits`).get(pattern) as { count: number }).count);
  return { ids: rows.map((row) => row.id), total };
}

function listTracks(
  db: Database,
  { q, sort, dir, limit, offset }: { q: string | null; sort: TrackSort; dir: "asc" | "desc"; limit: number; offset: number },
): { items: TrackRow[]; total: number } {
  const { ids, total } = q
    ? searchTracks(db, q, sort, dir, { limit, offset })
    : {
        ids: TRACK_PAGES[sort](db, dir === "desc" ? "DESC" : "ASC", { limit, offset }),
        total: (db.prepare("SELECT COUNT(*) AS count FROM recordings").get() as { count: number }).count,
      };

  // The page's rows, in the page's order.
  const items = db
    .prepare(
      `SELECT
         n.id AS id,
         n.title AS title,
         r.artist_node_id AS artistId,
         artist.title AS artistName,
         r.album_node_id AS albumId,
         album.title AS albumTitle,
         r.canonical_duration_ms AS durationMs,
         r.format AS format,
         n.created_at AS dateAdded
       FROM json_each(?) page
       JOIN nodes n ON n.id = page.value
       LEFT JOIN recordings r ON r.node_id = n.id
       LEFT JOIN nodes artist ON artist.id = r.artist_node_id
       LEFT JOIN nodes album ON album.id = r.album_node_id
       ORDER BY page.key`,
    )
    .all(JSON.stringify(ids)) as TrackRow[];

  return { items, total };
}

export function libraryRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: LibraryQuery }>("/library/albums", async (request) => {
      return listAlbums(db, {
        q: request.query.q?.trim() || null,
        sort: pickSort(ALBUM_SORTS, request.query.sort, "title"),
        dir: request.query.dir === "desc" ? "desc" : "asc",
        limit: clampLimit(request.query.limit),
        offset: clampOffset(request.query.offset),
      });
    });

    // No search: since v2 the library has no filter, and an artist is found
    // through the search palette like anything else.
    app.get<{ Querystring: LibraryQuery }>("/library/artists", async (request) => {
      return listArtists(db, {
        sort: pickSort(ARTIST_SORTS, request.query.sort, "name"),
        dir: request.query.dir === "desc" ? "desc" : "asc",
        limit: clampLimit(request.query.limit),
        offset: clampOffset(request.query.offset),
      });
    });

    // No search either, for the same reason.
    app.get<{ Querystring: LibraryQuery }>("/library/credits", async (request) => {
      const sort = pickSort(CREDIT_SORTS, request.query.sort, "name");
      const all = libraryCredits(db, sort, request.query.dir === "desc" ? "desc" : "asc");
      const offset = clampOffset(request.query.offset);
      return { items: all.slice(offset, offset + clampLimit(request.query.limit)), total: all.length };
    });

    app.get<{ Querystring: LibraryQuery }>("/library/tracks", async (request) => {
      return listTracks(db, {
        q: request.query.q?.trim() || null,
        sort: pickSort(TRACK_SORTS, request.query.sort, "title"),
        dir: request.query.dir === "desc" ? "desc" : "asc",
        limit: clampLimit(request.query.limit),
        offset: clampOffset(request.query.offset),
      });
    });
  };
}
