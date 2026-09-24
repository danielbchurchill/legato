import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { resolveCoverForNode } from "../cover/extract.js";

// The library view's two layouts (issue #126, D11 — see DESIGN.md "Library
// view"): a paginated, sortable, searchable read model over the same
// albums/tracks the graph already draws. GET /nodes exists for the canvas
// and returns the *whole* graph in one shot (fine for a force layout that
// needs every node up front) — the library view instead has to stay smooth
// scrolling through 30k albums, so it gets its own limit/offset routes
// rather than asking the client to paginate a 30k-row array it already
// downloaded whole.

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

function listTracks(
  db: Database,
  { q, sort, dir, limit, offset }: { q: string | null; sort: TrackSort; dir: "asc" | "desc"; limit: number; offset: number },
): { items: TrackRow[]; total: number } {
  const where = q
    ? "AND (n.title LIKE ? ESCAPE '\\' OR artist.title LIKE ? ESCAPE '\\' OR album.title LIKE ? ESCAPE '\\')"
    : "";
  const whereParams = q ? [likePattern(q), likePattern(q), likePattern(q)] : [];

  // Both joins below resolve "the first edge of this type", same
  // lowest-id-wins convention GET /nodes already uses for its hover-plate
  // subtitle — a recording can carry more than one performed_by edge
  // (featured artists), but the table shows one artist column, same as the
  // canvas shows one subtitle line.
  const fromAndWhere = `
       FROM nodes n
       JOIN recordings r ON r.node_id = n.id
       LEFT JOIN files f ON f.id = (SELECT MIN(id) FROM files WHERE recording_node_id = n.id)
       LEFT JOIN edges pe ON pe.id = (SELECT MIN(id) FROM edges WHERE from_node = n.id AND type = 'performed_by')
       LEFT JOIN nodes artist ON artist.id = pe.to_node
       LEFT JOIN edges ae ON ae.id = (SELECT MIN(id) FROM edges WHERE from_node = n.id AND type = 'appears_on')
       LEFT JOIN nodes album ON album.id = ae.to_node
       WHERE n.type = 'recording'
       ${where}`;

  const total = (db.prepare(`SELECT COUNT(*) AS count ${fromAndWhere}`).get(...whereParams) as { count: number })
    .count;

  const rows = db
    .prepare(
      `SELECT
         n.id AS id,
         n.title AS title,
         pe.to_node AS artistId,
         artist.title AS artistName,
         ae.to_node AS albumId,
         album.title AS albumTitle,
         r.canonical_duration_ms AS durationMs,
         f.format AS format,
         n.created_at AS dateAdded
       ${fromAndWhere}
       ORDER BY ${orderClause(TRACK_SORTS[sort], dir, "n.id")}
       LIMIT ? OFFSET ?`,
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
