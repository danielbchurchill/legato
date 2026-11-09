import type { Database, SQLQueryBindings } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { playTotal } from "../playCounts.js";

/* Library health's metadata gaps: which tracks are missing a tag the map and
 * the library use, grouped by album and paged (#469). Filling a gap isn't
 * done here: the client proposes tag writes through POST /tag-writes, the
 * same review path every other tag edit takes.
 *
 * A gap is a track (a recording with at least one file on disk) whose file
 * lacks the field, or, for "unmatched", a track with no MusicBrainz match.
 * Files that are missing on disk are left out: Missing files lists them, and
 * nothing can be written to them. A track's album is its first appears_on
 * edge, lowest id, the way GET /nodes' artist line picks one artist. */

export type TagManagerField = "bpm" | "label" | "release_date" | "release_type" | "unmatched";
export type TagManagerRow = { id: number; title: string; artist: string | null };

export const GAP_KINDS: readonly TagManagerField[] = ["unmatched", "label", "release_date", "release_type", "bpm"];
/* Album-level facts, which one value can fill for a whole album. A tempo is
 * a track's own, and "unmatched" has no value to fill. */
export const ALBUM_FILL_KINDS: readonly TagManagerField[] = ["label", "release_date", "release_type"];
/* What a file can have a value written for. */
const WRITABLE_KINDS: readonly TagManagerField[] = ["label", "release_date", "release_type", "bpm"];

// Column names, not query values, so they're never a placeholder param —
// interpolated directly below, but only ever from this fixed allowlist,
// never from the request's raw query string.
const MISSING_FIELD_COLUMNS: Record<Exclude<TagManagerField, "unmatched">, string> = {
  bpm: "bpm",
  label: "label",
  release_date: "release_date",
  release_type: "release_type",
};

// Same performed_by-edge subquery nodes.ts's GET /nodes uses for the canvas
// hover plate's second line — one artist per node, lowest edge id when a
// recording has more than one credit, so this list never names a different
// artist for the same node than the rest of the app does.
const artistOf = (node: string) => `(SELECT an.title
   FROM edges e JOIN nodes an ON an.id = e.to_node
  WHERE e.from_node = ${node} AND e.type = 'performed_by'
  ORDER BY e.id
  LIMIT 1)`;
const ARTIST_SUBQUERY = artistOf("n.id");

const albumOf = (recording: string) => `(SELECT e.to_node FROM edges e
  WHERE e.from_node = ${recording} AND e.type = 'appears_on'
  ORDER BY e.id
  LIMIT 1)`;

/* The pre-#469 list: every track missing one field, unpaged. Kept for a
 * desktop app older than this server, which still asks for it. */
export function getMissingField(db: Database, field: TagManagerField): TagManagerRow[] {
  if (field === "unmatched") {
    return db
      .prepare(
        `SELECT n.id, n.title, ${ARTIST_SUBQUERY} AS artist
         FROM nodes n
         WHERE n.type = 'recording' AND n.mbid IS NULL
         ORDER BY n.title`,
      )
      .all() as TagManagerRow[];
  }

  const column = MISSING_FIELD_COLUMNS[field];
  // GROUP BY node id: a node with more than one file (a merge case — see
  // InstancesList in MetadataFields.tsx) shouldn't appear twice just
  // because more than one of its files lacks the field.
  return db
    .prepare(
      `SELECT n.id, n.title, ${ARTIST_SUBQUERY} AS artist
       FROM files f
       JOIN nodes n ON n.id = f.recording_node_id
       WHERE f.${column} IS NULL
       GROUP BY n.id
       ORDER BY n.title`,
    )
    .all() as TagManagerRow[];
}

/* ---- Grouped and paged (#469) --------------------------------------------- */

export type GapCounts = Record<TagManagerField, number>;
export type GapSort = "artist" | "album" | "gaps" | "plays";
export type SortDir = "asc" | "desc";
export const GAP_SORTS: readonly GapSort[] = ["artist", "album", "gaps", "plays"];

export type GapFilter = {
  /** Which gaps count. At least one. */
  kinds: TagManagerField[];
  /** Only tracks credited to an artist whose name contains this. */
  artist?: string | null;
};

export type GapAlbum = {
  /** The release node; null for the tracks with no album. */
  id: number | null;
  title: string | null;
  artist: string | null;
  /** Tracks with at least one of the gaps. */
  tracks: number;
  /** The album's gaps summed: a track missing two of the kinds counts twice. */
  gaps: number;
  byKind: Partial<Record<TagManagerField, number>>;
  /** Plays of the tracks listed. */
  plays: number;
  /** MusicBrainz's id for the release, from the files' tags or a match. */
  releaseMbid: string | null;
};

export type GapTrack = {
  id: number;
  title: string;
  artist: string | null;
  discNo: number | null;
  trackNo: number | null;
  /** Which of the asked-for kinds it's missing. */
  missing: TagManagerField[];
  plays: number;
  /** Its files on disk that lack a writable field, and which. */
  files: { id: number; missing: TagManagerField[] }[];
};

export type GapFile = { id: number; trackId: number; missing: TagManagerField[] };

export type Page<T> = { total: number; items: T[] };

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* LIKE's own wildcards in a search box mean themselves. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/* The tracks a gap can be on, one row per track with a 0/1 per kind, filtered
 * to an artist's when there's a search. `where` narrows the files further.
 * The files are grouped by recording on their own, through the
 * recording_node_id index, and the recording's own row is read once per
 * track after: at 300,000 tracks that's half the time of joining every file
 * to its node first. Every file's recording_node_id is a recording, so
 * there's no type to check. */
function trackGapsCte(
  artist: string | null | undefined,
  where: { sql: string; params: SQLQueryBindings[] } = { sql: "", params: [] },
): { sql: string; params: SQLQueryBindings[] } {
  // In the order they appear: the files' own filter, then the artist's.
  const params: SQLQueryBindings[] = [...where.params];
  let artistClause = "";
  if (artist && artist.trim() !== "") {
    // Any artist the track credits, so a duet turns up under either name.
    artistClause = `WHERE EXISTS (SELECT 1 FROM edges ae JOIN nodes an ON an.id = ae.to_node
                      WHERE ae.from_node = fg.rec AND ae.type = 'performed_by'
                        AND an.title LIKE ? ESCAPE '\\')`;
    params.push(likePattern(artist.trim()));
  }
  return {
    sql: `file_gaps AS (
      SELECT f.recording_node_id AS rec,
             MAX(f.bpm IS NULL) AS bpm,
             MAX(f.label IS NULL) AS label,
             MAX(f.release_date IS NULL) AS release_date,
             MAX(f.release_type IS NULL) AS release_type
      FROM files f
      WHERE f.missing_since IS NULL ${where.sql}
      GROUP BY f.recording_node_id
    ),
    track_gaps AS (
      SELECT fg.*, (n.mbid IS NULL) AS unmatched
      FROM file_gaps fg JOIN nodes n ON n.id = fg.rec
      ${artistClause}
    )`,
    params,
  };
}

function gapSum(kinds: TagManagerField[]): string {
  // Only ever names from GAP_KINDS: a request's kinds are checked against it.
  return `(${kinds.map((k) => `t.${k}`).join(" + ")})`;
}

/** How many tracks each kind of gap is on, in one query. */
export function getGapCounts(db: Database, artist?: string | null): GapCounts {
  const cte = trackGapsCte(artist);
  const row = db
    .prepare(
      `WITH ${cte.sql}
       SELECT COALESCE(SUM(unmatched), 0) AS unmatched, COALESCE(SUM(label), 0) AS label,
              COALESCE(SUM(release_date), 0) AS release_date, COALESCE(SUM(release_type), 0) AS release_type,
              COALESCE(SUM(bpm), 0) AS bpm
       FROM track_gaps`,
    )
    .get(...cte.params) as GapCounts;
  return row;
}

function orderBy(sort: GapSort, dir: SortDir): string {
  const d = dir === "desc" ? "DESC" : "ASC";
  // The tracks with no album always come last, whatever the order: they're
  // a catch-all, not an album to compare.
  const head = "(g.album IS NULL) ASC";
  const byAlbum = "(rn.title IS NULL) ASC, rn.title COLLATE NOCASE ASC, g.album ASC";
  switch (sort) {
    case "artist":
      return `${head}, (artist IS NULL) ASC, artist COLLATE NOCASE ${d}, ${byAlbum}`;
    case "album":
      return `${head}, (rn.title IS NULL) ASC, rn.title COLLATE NOCASE ${d}, g.album ASC`;
    case "gaps":
      return `${head}, g.gaps ${d}, ${byAlbum}`;
    case "plays":
      return `${head}, g.plays ${d}, g.gaps DESC, ${byAlbum}`;
  }
}

/** One page of albums with gaps of the given kinds, and how many there are
 * in all. */
export function getGapAlbums(
  db: Database,
  filter: GapFilter,
  sort: GapSort,
  dir: SortDir,
  offset: number,
  limit: number,
): Page<GapAlbum> {
  const cte = trackGapsCte(filter.artist);
  const sum = gapSum(filter.kinds);
  const rows = db
    .prepare(
      `WITH ${cte.sql},
       play_counts AS (
         SELECT recording_node_id AS rec, ${playTotal()} AS n FROM plays GROUP BY recording_node_id
       ),
       gap_tracks AS (
         SELECT t.rec, ${sum} AS gaps, t.unmatched, t.label, t.release_date, t.release_type, t.bpm,
                COALESCE(pc.n, 0) AS plays, ${albumOf("t.rec")} AS album
         FROM track_gaps t LEFT JOIN play_counts pc ON pc.rec = t.rec
         WHERE ${sum} > 0
       ),
       groups AS (
         SELECT album, SUM(gaps) AS gaps, COUNT(*) AS tracks, SUM(plays) AS plays, MIN(rec) AS first_rec,
                SUM(unmatched) AS unmatched, SUM(label) AS label, SUM(release_date) AS release_date,
                SUM(release_type) AS release_type, SUM(bpm) AS bpm
         FROM gap_tracks GROUP BY album
       )
       SELECT g.*, rn.title AS title,
              CASE WHEN g.album IS NULL THEN NULL
                   ELSE COALESCE(pa.title, ${artistOf("g.first_rec")}) END AS artist,
              COUNT(*) OVER () AS total
       FROM groups g
       LEFT JOIN nodes rn ON rn.id = g.album
       LEFT JOIN albums al ON al.node_id = g.album
       LEFT JOIN nodes pa ON pa.id = al.primary_artist_node_id
       ORDER BY ${orderBy(sort, dir)}
       LIMIT ? OFFSET ?`,
    )
    .all(...cte.params, limit, offset) as (Record<TagManagerField, number> & {
    album: number | null;
    gaps: number;
    tracks: number;
    plays: number;
    title: string | null;
    artist: string | null;
    total: number;
  })[];

  const total = rows[0]?.total ?? (offset > 0 ? countGroups(db, filter) : 0);
  return {
    total,
    items: rows.map((r) => ({
      id: r.album,
      title: r.title,
      artist: r.artist,
      tracks: r.tracks,
      gaps: r.gaps,
      byKind: Object.fromEntries(filter.kinds.map((k) => [k, r[k]])),
      plays: r.plays,
      releaseMbid: r.album != null ? releaseMbid(db, r.album) : null,
    })),
  };
}

/* A page past the end has no row to carry the total, so it's counted on its
 * own. Only a client asking beyond the last page gets here. */
function countGroups(db: Database, filter: GapFilter): number {
  const cte = trackGapsCte(filter.artist);
  const row = db
    .prepare(
      `WITH ${cte.sql}
       SELECT COUNT(DISTINCT COALESCE(${albumOf("t.rec")}, -1)) AS n FROM track_gaps t WHERE ${gapSum(filter.kinds)} > 0`,
    )
    .get(...cte.params) as { n: number };
  return row.n;
}

/* The release's MusicBrainz id: from a file's own tag first (Picard writes
 * MUSICBRAINZ_ALBUMID, and it names the edition the files came from), else
 * from the release MusicBrainz matched (enrich/credits.ts). */
export function releaseMbid(db: Database, releaseNodeId: number): string | null {
  const tagged = db
    .prepare(
      `SELECT mbid FROM (
         SELECT f.id, CASE WHEN json_valid(f.tags_raw) THEN json_extract(f.tags_raw, '$.mbReleaseId') END AS mbid
         FROM edges e JOIN files f ON f.recording_node_id = e.from_node
         WHERE e.to_node = ? AND e.type = 'appears_on'
       )
       WHERE mbid IS NOT NULL
       ORDER BY id
       LIMIT 1`,
    )
    .get(releaseNodeId) as { mbid: unknown } | undefined;
  if (typeof tagged?.mbid === "string" && MBID.test(tagged.mbid)) return tagged.mbid.toLowerCase();
  const matched = db
    .prepare(
      `SELECT value FROM field_provenance
       WHERE node_id = ? AND field = 'release_mbid' AND source = 'musicbrainz' AND is_active = 1
         AND value IS NOT NULL
       ORDER BY confidence DESC, updated_at DESC, id DESC
       LIMIT 1`,
    )
    .get(releaseNodeId) as { value: string } | undefined;
  return matched && MBID.test(matched.value) ? matched.value.toLowerCase() : null;
}

/* The files of an album's tracks, or of the tracks with no album when
 * `albumId` is null, by the same first-edge rule the grouping uses. */
function onAlbum(albumId: number | null): { sql: string; params: SQLQueryBindings[] } {
  if (albumId == null) {
    return {
      sql: "AND NOT EXISTS (SELECT 1 FROM edges xe WHERE xe.from_node = f.recording_node_id AND xe.type = 'appears_on')",
      params: [],
    };
  }
  return {
    sql: `AND f.recording_node_id IN (SELECT from_node FROM edges WHERE to_node = ? AND type = 'appears_on')
          AND ${albumOf("f.recording_node_id")} = ?`,
    params: [albumId, albumId],
  };
}

function missingKinds(row: Record<string, unknown>, kinds: readonly TagManagerField[]): TagManagerField[] {
  return kinds.filter((k) => row[k] === 1);
}

/** One page of an album's tracks with gaps of the given kinds, in disc and
 * track order, each with its files that a value could be written to. */
export function getGapTracks(
  db: Database,
  albumId: number | null,
  filter: GapFilter,
  offset: number,
  limit: number,
): Page<GapTrack> {
  const cte = trackGapsCte(filter.artist, onAlbum(albumId));
  const sum = gapSum(filter.kinds);
  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT t.*, n.title, ${ARTIST_SUBQUERY} AS artist,
              (SELECT disc_no FROM files WHERE recording_node_id = t.rec ORDER BY id LIMIT 1) AS disc_no,
              (SELECT track_no FROM files WHERE recording_node_id = t.rec ORDER BY id LIMIT 1) AS track_no,
              (SELECT COALESCE(${playTotal("p")}, 0) FROM plays p WHERE p.recording_node_id = t.rec) AS plays,
              COUNT(*) OVER () AS total
       FROM track_gaps t JOIN nodes n ON n.id = t.rec
       WHERE ${sum} > 0
       ORDER BY (disc_no IS NULL), disc_no, (track_no IS NULL), track_no, n.title COLLATE NOCASE, t.rec
       LIMIT ? OFFSET ?`,
    )
    .all(...cte.params, limit, offset) as (Record<TagManagerField, number> & {
    rec: number;
    title: string;
    artist: string | null;
    disc_no: number | null;
    track_no: number | null;
    plays: number;
    total: number;
  })[];

  const filesOf = db.prepare(
    `SELECT id, bpm IS NULL AS bpm, label IS NULL AS label, release_date IS NULL AS release_date,
            release_type IS NULL AS release_type
     FROM files WHERE recording_node_id = ? AND missing_since IS NULL ORDER BY id`,
  );
  const writable = WRITABLE_KINDS.filter((k) => filter.kinds.includes(k));
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({
      id: r.rec,
      title: r.title,
      artist: r.artist,
      discNo: r.disc_no,
      trackNo: r.track_no,
      missing: missingKinds(r, filter.kinds),
      plays: r.plays,
      files: (filesOf.all(r.rec) as ({ id: number } & Record<string, number>)[])
        .map((f) => ({ id: f.id, missing: missingKinds(f, writable) }))
        .filter((f) => f.missing.length > 0),
    })),
  };
}

/** Every file on an album that lacks one of the album-level fields, for a
 * value entered once to go on each (#469). Not paged: it's one album, and
 * the client proposes a tag write per file. The whole album, whatever the
 * artist search, because a label or a date is the album's. */
export function getGapFiles(db: Database, albumId: number): GapFile[] {
  const album = onAlbum(albumId);
  const rows = db
    .prepare(
      `SELECT f.id, f.recording_node_id AS track_id, f.label IS NULL AS label,
              f.release_date IS NULL AS release_date, f.release_type IS NULL AS release_type
       FROM files f JOIN nodes n ON n.id = f.recording_node_id
       WHERE f.missing_since IS NULL AND n.type = 'recording' ${album.sql}
         AND (f.label IS NULL OR f.release_date IS NULL OR f.release_type IS NULL)
       ORDER BY f.id`,
    )
    .all(...album.params) as ({ id: number; track_id: number } & Record<string, number>)[];
  return rows.map((r) => ({ id: r.id, trackId: r.track_id, missing: missingKinds(r, ALBUM_FILL_KINDS) }));
}

function isValidField(field: string | undefined): field is TagManagerField {
  return field != null && (GAP_KINDS as readonly string[]).includes(field);
}

/* "label,release_date" → the kinds, or null when any of them isn't one. */
export function parseKinds(value: string | undefined): TagManagerField[] | null {
  if (value == null || value.trim() === "") return null;
  const kinds = [...new Set(value.split(","))];
  return kinds.every(isValidField) ? kinds : null;
}

const MAX_PAGE = 200;
function pageParams(
  query: { offset?: string; limit?: string },
  fallback: number,
): { offset: number; limit: number } | null {
  const offset = query.offset == null ? 0 : Number(query.offset);
  const limit = query.limit == null ? fallback : Number(query.limit);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return null;
  return { offset, limit };
}

const KINDS_ERROR = `kinds must be a comma-separated list of ${GAP_KINDS.join(", ")}`;
const PAGE_ERROR = `offset must be 0 or more, and limit 1 to ${MAX_PAGE}`;

/* :id is a release node, or "none" for the tracks with no album. */
function albumParam(id: string): number | null | undefined {
  if (id === "none") return null;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

type GapQuery = { kinds?: string; artist?: string; sort?: string; dir?: string; offset?: string; limit?: string };

export function tagManagerRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { field?: string } }>("/tag-manager", async (request, reply) => {
      const { field } = request.query;
      if (!isValidField(field)) {
        reply.code(400);
        return { error: "field must be one of bpm, label, release_date, release_type, unmatched" };
      }
      return getMissingField(db, field);
    });

    app.get<{ Querystring: { artist?: string } }>("/tag-manager/counts", async (request) =>
      getGapCounts(db, request.query.artist),
    );

    app.get<{ Querystring: GapQuery }>("/tag-manager/albums", async (request, reply) => {
      const { artist, sort = "gaps", dir } = request.query;
      const kinds = parseKinds(request.query.kinds);
      const page = pageParams(request.query, 50);
      if (!kinds || !page) {
        reply.code(400);
        return { error: !kinds ? KINDS_ERROR : PAGE_ERROR };
      }
      if (!(GAP_SORTS as readonly string[]).includes(sort) || (dir != null && dir !== "asc" && dir !== "desc")) {
        reply.code(400);
        return { error: `sort must be one of ${GAP_SORTS.join(", ")}, and dir asc or desc` };
      }
      const order = dir ?? (sort === "gaps" || sort === "plays" ? "desc" : "asc");
      return getGapAlbums(db, { kinds, artist }, sort as GapSort, order, page.offset, page.limit);
    });

    app.get<{ Params: { id: string }; Querystring: GapQuery }>(
      "/tag-manager/albums/:id/tracks",
      async (request, reply) => {
        const albumId = albumParam(request.params.id);
        const kinds = parseKinds(request.query.kinds);
        const page = pageParams(request.query, 100);
        if (albumId === undefined || !kinds || !page) {
          reply.code(400);
          return {
            error: albumId === undefined ? "id must be a release node id or none" : !kinds ? KINDS_ERROR : PAGE_ERROR,
          };
        }
        return getGapTracks(db, albumId, { kinds, artist: request.query.artist }, page.offset, page.limit);
      },
    );

    app.get<{ Params: { id: string } }>("/tag-manager/albums/:id/files", async (request, reply) => {
      const albumId = albumParam(request.params.id);
      if (albumId == null) {
        reply.code(400);
        return { error: "id must be a release node id" };
      }
      return getGapFiles(db, albumId);
    });
  };
}
