import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { resolveCoverForNode } from "../cover/extract.js";

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

const TRACK_SORTS = {
  title: "n.title",
  artist: "artist.title",
  album: "album.title",
  duration: "r.canonical_duration_ms",
  format: "f.format",
  dateAdded: "n.created_at",
} as const;
export type TrackSort = keyof typeof TRACK_SORTS;

// Case-insensitive, as an artist list reads ("alt-J" among the A's, not
// after "Zappa"). The albums and tracks sorts compare titles as stored.
const ARTIST_SORTS = {
  name: "n.title COLLATE NOCASE",
} as const;
export type ArtistSort = keyof typeof ARTIST_SORTS;

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
// entities/aggregate.ts's rule for an album's artist: each track goes to its
// first performed_by credit, and a record to whoever most of its tracks went
// to, ties to the lower id. The map clusters records by the same rule
// (src/canvas/clusters.ts), so every artist listed here has records beside
// it on the map. An artist who is only ever featured, or credited after
// someone else, has no record of its own and is left out: they'd fill the
// grid with names that lead nowhere.
//
// One definition, read twice: the Artists tab pages through it below, and
// GET /stats counts it for the Library header, so the two can't disagree.
// Both used to read the map's graph, which stops at 5,000 nodes (#302).
const LIBRARY_ARTISTS = `
  SELECT al.primary_artist_node_id AS id, COUNT(*) AS releases
  FROM albums al
  JOIN nodes a ON a.id = al.primary_artist_node_id
  WHERE a.type = 'artist'
  GROUP BY al.primary_artist_node_id`;

export function countLibraryArtists(db: Database): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM (${LIBRARY_ARTISTS})`).get() as { count: number }).count;
}

function listArtists(
  db: Database,
  { sort, dir, limit, offset }: { sort: ArtistSort; dir: "asc" | "desc"; limit: number; offset: number },
): { items: ArtistRow[]; total: number } {
  const items = db
    .prepare(
      `SELECT la.id AS id, n.title AS name, la.releases AS releases
       FROM (${LIBRARY_ARTISTS}) la
       JOIN nodes n ON n.id = la.id
       ORDER BY ${orderClause(ARTIST_SORTS[sort], dir, "n.id")}
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as ArtistRow[];
  return { items, total: countLibraryArtists(db) };
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

  const rows = db
    .prepare(
      `WITH release_last_played AS (
         SELECT e.to_node AS release_node_id, MAX(p.started_at) AS last_played_at
         FROM edges e
         JOIN plays p ON p.recording_node_id = e.from_node
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

// The joins a track row reads. The artist and album joins resolve "the first
// edge of this type", same lowest-id-wins convention GET /nodes already uses
// for its hover-plate subtitle — a recording can carry more than one
// performed_by edge (featured artists), but the table shows one artist
// column, same as the canvas shows one subtitle line.
const TRACK_JOINS = {
  file: "LEFT JOIN files f ON f.id = (SELECT MIN(id) FROM files WHERE recording_node_id = n.id)",
  artist: `LEFT JOIN edges pe ON pe.id = (SELECT MIN(id) FROM edges WHERE from_node = n.id AND type = 'performed_by')
       LEFT JOIN nodes artist ON artist.id = pe.to_node`,
  album: `LEFT JOIN edges ae ON ae.id = (SELECT MIN(id) FROM edges WHERE from_node = n.id AND type = 'appears_on')
       LEFT JOIN nodes album ON album.id = ae.to_node`,
} as const;
type TrackJoin = keyof typeof TRACK_JOINS;

// What each sort has to join to order the whole table by.
const TRACK_SORT_JOINS: Record<TrackSort, TrackJoin[]> = {
  title: [],
  artist: ["artist"],
  album: ["album"],
  duration: [],
  format: ["file"],
  dateAdded: [],
};

function trackJoins(names: TrackJoin[]): string {
  return [...new Set(names)].map((name) => TRACK_JOINS[name]).join("\n       ");
}

function listTracks(
  db: Database,
  { q, sort, dir, limit, offset }: { q: string | null; sort: TrackSort; dir: "asc" | "desc"; limit: number; offset: number },
): { items: TrackRow[]; total: number } {
  const where = q
    ? "AND (n.title LIKE ? ESCAPE '\\' OR artist.title LIKE ? ESCAPE '\\' OR album.title LIKE ? ESCAPE '\\')"
    : "";
  const whereParams = q ? [likePattern(q), likePattern(q), likePattern(q)] : [];
  // A search matches artist and album titles, so it needs both on every row.
  const filterJoins: TrackJoin[] = q ? ["artist", "album"] : [];

  // At 30k albums this table is ~300k tracks, and every join is a few index
  // lookups per row. Joining all three for the count and for the sort took
  // ~5.5 s a page on that size (#263), so the count and the ordering join
  // only what they read, and the full row is joined for the page's ids
  // alone. Each join matches at most one row (an id equality), so leaving
  // one out changes neither the count nor the order.
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM nodes n
         JOIN recordings r ON r.node_id = n.id
         ${trackJoins(filterJoins)}
         WHERE n.type = 'recording'
         ${where}`,
      )
      .get(...whereParams) as { count: number }
  ).count;

  const order = orderClause(TRACK_SORTS[sort], dir, "n.id");
  const rows = db
    .prepare(
      `WITH page AS (
         SELECT n.id
         FROM nodes n
         JOIN recordings r ON r.node_id = n.id
         ${trackJoins([...filterJoins, ...TRACK_SORT_JOINS[sort]])}
         WHERE n.type = 'recording'
         ${where}
         ORDER BY ${order}
         LIMIT ? OFFSET ?
       )
       SELECT
         n.id AS id,
         n.title AS title,
         pe.to_node AS artistId,
         artist.title AS artistName,
         ae.to_node AS albumId,
         album.title AS albumTitle,
         r.canonical_duration_ms AS durationMs,
         f.format AS format,
         n.created_at AS dateAdded
       FROM page
       JOIN nodes n ON n.id = page.id
       JOIN recordings r ON r.node_id = n.id
       ${trackJoins(["file", "artist", "album"])}
       ORDER BY ${order}`,
    )
    .all(...whereParams, limit, offset) as TrackRow[];

  return { items: rows, total };
}

export function libraryRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: LibraryQuery }>("/library/albums", async (request) => {
      const sort = (request.query.sort ?? "title") as AlbumSort;
      return listAlbums(db, {
        q: request.query.q?.trim() || null,
        sort: sort in ALBUM_SORTS ? sort : "title",
        dir: request.query.dir === "desc" ? "desc" : "asc",
        limit: clampLimit(request.query.limit),
        offset: clampOffset(request.query.offset),
      });
    });

    // No search: since v2 the library has no filter, and an artist is found
    // through the search palette like anything else.
    app.get<{ Querystring: LibraryQuery }>("/library/artists", async (request) => {
      const sort = (request.query.sort ?? "name") as ArtistSort;
      return listArtists(db, {
        sort: sort in ARTIST_SORTS ? sort : "name",
        dir: request.query.dir === "desc" ? "desc" : "asc",
        limit: clampLimit(request.query.limit),
        offset: clampOffset(request.query.offset),
      });
    });

    app.get<{ Querystring: LibraryQuery }>("/library/tracks", async (request) => {
      const sort = (request.query.sort ?? "title") as TrackSort;
      return listTracks(db, {
        q: request.query.q?.trim() || null,
        sort: sort in TRACK_SORTS ? sort : "title",
        dir: request.query.dir === "desc" ? "desc" : "asc",
        limit: clampLimit(request.query.limit),
        offset: clampOffset(request.query.offset),
      });
    });
  };
}
