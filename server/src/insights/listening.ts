import type { Database } from "../sqlite.js";
import { libraryRevision } from "../libraryRevision.js";
import type { Ref } from "./model.js";

/* #468: the cards read from plays and the albums table.
 *
 * Plays holds one row per listen, with when it began (started_at, an ISO
 * time the client sends), so "haven't played for months" can be answered.
 * Every listening card comes from one pass over it: the plays grouped by
 * recording first, then only the played recordings' artist and album edges,
 * found by index. Going from each play to its edges instead, as GET /stats
 * does for its one top artist, took about 100 ms a card at 20,000 plays.
 *
 * The answer is kept until a play lands or the library changes, and for ten
 * minutes at most, since "the last 30 days" moves on by itself. */

const ROWS = 5;
const KEEP_MS = 10 * 60_000;

/** How long since an artist was last played before it counts as gone
 *  quiet, and how many plays count as having played it a lot. */
export const REDISCOVER_AFTER_DAYS = 90;
export const REDISCOVER_MIN_PLAYS = 5;
/** "On repeat": this many plays or more in the last ON_REPEAT_DAYS. */
export const ON_REPEAT_DAYS = 30;
export const ON_REPEAT_MIN_PLAYS = 3;

export type PlayedRow = { node: Ref; plays: number; by: Ref | null; focus: number[] };
export type RediscoverRow = { artist: Ref; plays: number; lastPlayed: string; focus: number[] };
export type WaitingRow = { album: Ref; by: Ref | null; year: number | null; addedAt: string; focus: number[] };

export type Listening = {
  mostPlayed: { artists: PlayedRow[]; albums: PlayedRow[]; tracks: PlayedRow[] };
  onRepeat: PlayedRow[];
  rediscover: RediscoverRow[];
  waiting: { albums: WaitingRow[]; total: number };
};

const cache = new WeakMap<Database, { key: string; at: number; value: Listening }>();

function nodes(db: Database, ids: Iterable<number>): Map<number, Ref> {
  const out = new Map<number, Ref>();
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const row of db
      .prepare(`SELECT id, title, type FROM nodes WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as Ref[]) {
      out.set(row.id, row);
    }
  }
  return out;
}

/** A Julian day as an ISO time. */
function fromJulian(day: number): string {
  return new Date(Math.round((day - 2440587.5) * 86_400_000)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function listening(db: Database): Listening {
  const newestPlay = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM plays").get() as { id: number }).id;
  const newestEdge = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM edges").get() as { id: number }).id;
  const key = `${libraryRevision()}:${newestEdge}:${newestPlay}`;
  const cached = cache.get(db);
  if (cached && cached.key === key && Date.now() - cached.at < KEEP_MS) return cached.value;
  const value = readListening(db);
  cache.set(db, { key, at: Date.now(), value });
  return value;
}

function readListening(db: Database): Listening {
  const now = (db.prepare("SELECT julianday('now') AS day").get() as { day: number }).day;
  const recordings = db
    .prepare(
      `SELECT recording_node_id, COUNT(*), MAX(julianday(started_at)), SUM(julianday(started_at) >= ?)
         FROM plays GROUP BY recording_node_id`,
    )
    .values(now - ON_REPEAT_DAYS) as [number, number, number | null, number][];
  const byRecording = new Map(
    recordings.map(([rec, plays, last, recent]) => [rec, { plays, last: last ?? 0, recent }]),
  );

  const artistPlays = new Map<number, { plays: number; last: number }>();
  const albumPlays = new Map<number, number>();
  const trackArtists = new Map<number, number[]>();
  for (const [rec, to, type] of db
    .prepare(
      `SELECT from_node, to_node, type FROM edges
        WHERE from_node IN (SELECT DISTINCT recording_node_id FROM plays) AND type IN ('performed_by', 'appears_on')
        ORDER BY id`,
    )
    .values() as [number, number, string][]) {
    const played = byRecording.get(rec);
    if (!played) continue;
    if (type === "appears_on") {
      albumPlays.set(to, (albumPlays.get(to) ?? 0) + played.plays);
      continue;
    }
    const had = artistPlays.get(to);
    if (had) {
      had.plays += played.plays;
      had.last = Math.max(had.last, played.last);
    } else artistPlays.set(to, { plays: played.plays, last: played.last });
    trackArtists.set(rec, [...(trackArtists.get(rec) ?? []), to]);
  }

  // Names for what can make a card: every played artist (some performed_by
  // edges point at a credit, which isn't one), the top albums, and the
  // tracks that can.
  const topAlbums = [...albumPlays].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, ROWS * 4);
  const topTracks = [...byRecording].sort((a, b) => b[1].plays - a[1].plays || a[0] - b[0]).slice(0, ROWS);
  const repeated = [...byRecording]
    .filter(([, r]) => r.recent >= ON_REPEAT_MIN_PLAYS)
    .sort((a, b) => b[1].recent - a[1].recent || a[0] - b[0])
    .slice(0, ROWS);
  const names = nodes(db, [
    ...artistPlays.keys(),
    ...topAlbums.map(([id]) => id),
    ...topTracks.map(([id]) => id),
    ...repeated.map(([id]) => id),
  ]);
  const artistRef = (id: number | undefined) =>
    id != null && names.get(id)?.type === "artist" ? names.get(id)! : null;
  const trackBy = (rec: number) =>
    artistRef((trackArtists.get(rec) ?? []).find((id) => names.get(id)?.type === "artist"));

  const artists = [...artistPlays]
    .filter(([id]) => names.get(id)?.type === "artist")
    .sort((a, b) => b[1].plays - a[1].plays || a[0] - b[0]);

  const albumsTop = topAlbums.filter(([id]) => names.get(id)?.type === "release").slice(0, ROWS);
  const primary = new Map<number, number>();
  for (const [album, artist] of db
    .prepare(
      `SELECT node_id, primary_artist_node_id FROM albums WHERE node_id IN (${albumsTop.map(() => "?").join(",") || "NULL"})`,
    )
    .values(...albumsTop.map(([id]) => id)) as [number, number | null][]) {
    if (artist != null) primary.set(album, artist);
  }
  const primaryNames = nodes(db, primary.values());

  return {
    mostPlayed: {
      artists: artists
        .slice(0, ROWS)
        .map(([id, a]) => ({ node: names.get(id)!, plays: a.plays, by: null, focus: [id] })),
      albums: albumsTop.map(([id, plays]) => {
        const by = primary.get(id);
        return { node: names.get(id)!, plays, by: by != null ? (primaryNames.get(by) ?? null) : null, focus: [id] };
      }),
      tracks: topTracks
        .filter(([id]) => names.has(id))
        .map(([id, r]) => ({ node: names.get(id)!, plays: r.plays, by: trackBy(id), focus: [id] })),
    },
    onRepeat: repeated
      .filter(([id]) => names.has(id))
      .map(([id, r]) => ({ node: names.get(id)!, plays: r.recent, by: trackBy(id), focus: [id] })),
    rediscover: artists
      .filter(([, a]) => a.plays >= REDISCOVER_MIN_PLAYS && now - a.last >= REDISCOVER_AFTER_DAYS)
      .slice(0, ROWS)
      .map(([id, a]) => ({ artist: names.get(id)!, plays: a.plays, lastPlayed: fromJulian(a.last), focus: [id] })),
    waiting: waiting(db, new Set(albumPlays.keys())),
  };
}

const WAITING_ROWS = 8;
const WAITING_PAGE = 64;

/** Albums with no track ever played, newest added first, and how many. */
function waiting(db: Database, played: Set<number>): { albums: WaitingRow[]; total: number } {
  const page = db.prepare(
    `SELECT n.id, n.title, n.created_at, al.year_min, a.id, a.title
       FROM albums al
       JOIN nodes n ON n.id = al.node_id AND n.type = 'release'
       LEFT JOIN nodes a ON a.id = al.primary_artist_node_id
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ? OFFSET ?`,
  );
  const albums: WaitingRow[] = [];
  // A page at a time, so a library whose newest albums have all been played
  // reads on only as far as it has to.
  for (let offset = 0; albums.length < WAITING_ROWS; offset += WAITING_PAGE) {
    const rows = page.values(WAITING_PAGE, offset) as [
      number,
      string,
      string,
      number | null,
      number | null,
      string | null,
    ][];
    for (const [id, title, addedAt, year, byId, byTitle] of rows) {
      if (played.has(id) || albums.length === WAITING_ROWS) continue;
      albums.push({
        album: { id, title, type: "release" },
        by: byId != null && byTitle != null ? { id: byId, title: byTitle, type: "artist" } : null,
        year,
        addedAt,
        focus: [id],
      });
    }
    if (rows.length < WAITING_PAGE) break;
  }
  const all = db
    .prepare("SELECT al.node_id FROM albums al JOIN nodes n ON n.id = al.node_id AND n.type = 'release'")
    .values() as [number][];
  return { albums, total: all.filter(([id]) => !played.has(id)).length };
}

export type Decade = { decade: number; albums: number };

/** Your albums by the decade of their earliest track, and how many have
 *  no year at all. */
export function decades(db: Database): { decades: Decade[]; undated: number } {
  const rows = db
    .prepare(
      `SELECT CASE WHEN al.year_min BETWEEN 1000 AND 9999 THEN (al.year_min / 10) * 10 END AS decade, COUNT(*) AS albums
         FROM albums al JOIN nodes n ON n.id = al.node_id AND n.type = 'release'
        GROUP BY decade ORDER BY decade`,
    )
    .all() as { decade: number | null; albums: number }[];
  return {
    decades: rows.filter((r): r is Decade => r.decade != null),
    undated: rows.find((r) => r.decade == null)?.albums ?? 0,
  };
}

export type CareerRow = { artist: Ref; first: number; last: number; albums: number; focus: number[] };

/** The artists whose albums span the most years, ten or more. */
export function careers(db: Database): CareerRow[] {
  return (
    db
      .prepare(
        `SELECT a.id AS id, a.title AS title, MIN(al.year_min) AS first, MAX(COALESCE(al.year_max, al.year_min)) AS last,
                COUNT(*) AS albums
           FROM albums al JOIN nodes a ON a.id = al.primary_artist_node_id AND a.type = 'artist'
          WHERE al.year_min BETWEEN 1000 AND 9999
          GROUP BY al.primary_artist_node_id
         HAVING albums >= 2 AND last - first >= 10
          ORDER BY last - first DESC, albums DESC, a.id
          LIMIT ${ROWS}`,
      )
      .all() as { id: number; title: string; first: number; last: number; albums: number }[]
  ).map((r) => ({
    artist: { id: r.id, title: r.title, type: "artist" },
    first: r.first,
    last: r.last,
    albums: r.albums,
    focus: [r.id],
  }));
}
