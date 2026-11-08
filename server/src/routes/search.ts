import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { libraryRevision } from "../libraryRevision.js";
import { playTotal } from "../playCounts.js";

/* What the search palette and the phone's search ask while someone types
 * (#463). FTS5 finds the titles; the order is decided here, so every client
 * gets the rows already in the order it shows them:
 *
 *  1. An exact match first, whatever its kind: the whole title is the
 *     query, ignoring case, accents and outer spaces.
 *  2. Then by kind: artists, albums, tracks, then producers and engineers
 *     (credit nodes).
 *  3. Within a kind, the better text match: a title that starts with the
 *     query, then one holding every query word as a whole word, then the
 *     rest (words that only start with what was typed).
 *  4. Ties go to more plays, then more tracks, then the title and the id,
 *     so the order never depends on how SQLite walked the index. FTS5's
 *     bm25 isn't asked for: the tiers say more about a title than its
 *     length does, and scoring every match cost more than the rest of the
 *     search together (a one-letter query on 30,000 albums).
 *
 * Only the kinds a client shows are searched: labels, years and works never
 * reach the limit.
 *
 * The kind order says which group comes first and which kind the top result
 * is from; it never starves a kind. The palette and the phone ask with
 * `perKind`, and get up to that many of each kind, exact matches included:
 * a one-letter query that matches thousands of artists still brings its
 * albums, tracks and producers, so each group and each filter has rows to
 * show. `limit` alone caps the whole answer instead, best first, for a
 * picker that wants a few rows whatever their kind (the personal
 * connection's target in NodeDetails.tsx). Either way the cap applies after
 * ranking, so a strong artist match is never cut off behind weaker tracks. */

const KIND_ORDER = ["artist", "release", "recording", "credit"] as const;
export type SearchKind = (typeof KIND_ORDER)[number];
export type SearchHit = { id: number; type: SearchKind; title: string };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** How much a search answers: up to `perKind` rows of each kind, and up to
 * `total` rows in all. */
export type SearchLimits = { perKind: number; total: number };

// Strips FTS5 query-syntax characters and turns the rest into a
// prefix-match AND query: safe for arbitrary user input. FTS5's unicode61
// tokenizer already folds case and diacritics on both sides.
function toFtsQuery(raw: string): string | null {
  const cleaned = raw.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!cleaned) return null;
  return cleaned
    .split(/\s+/)
    .map((token) => `${token}*`)
    .join(" ");
}

/** A title or query as exact matching compares it: accents gone, case
 * folded, outer spaces trimmed. */
export function foldTitle(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

const words = (folded: string): string[] => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

type Tier = 0 | 1 | 2 | 3;

// Both sides already folded.
function tierOf(title: string, query: string, queryWords: readonly string[]): Tier {
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  const titleWords = new Set(words(title));
  return queryWords.every((word) => titleWords.has(word)) ? 2 : 3;
}

/** How well a title matches beyond FTS5's "every word starts with what was
 * typed": 0 is the whole title, 1 a title that starts with the query, 2
 * every query word whole in the title, 3 the rest. */
export function matchTier(title: string, query: string): Tier {
  const q = foldTitle(query);
  return tierOf(foldTitle(title), q, words(q));
}

type Candidate = SearchHit & { folded: string; plays: number; tracks: number };

// How much music is under a node: the aggregate tables' counts for artists
// and albums, the tracks credited for a producer or engineer. A track is one.
const TRACKS_SQL: Record<Exclude<SearchKind, "recording">, string> = {
  artist: "SELECT node_id AS id, track_count AS n FROM artists WHERE node_id IN (SELECT value FROM json_each(?))",
  release: "SELECT node_id AS id, track_count AS n FROM albums WHERE node_id IN (SELECT value FROM json_each(?))",
  credit: `SELECT e.to_node AS id, COUNT(DISTINCT e.from_node) AS n FROM edges e
           WHERE e.to_node IN (SELECT value FROM json_each(?)) AND e.type IN ('produced_by', 'engineered_by')
           GROUP BY e.to_node`,
};

// The listening behind every node that has any: a track's own plays, and
// for an artist, an album or a producer its tracks' plays, through the
// edges the map draws (performed_by, appears_on, produced_by and
// engineered_by, all from the recording). A track with two edges to one
// node counts once. Read from the plays' side, so the cost follows the
// listening history rather than the matches: counting each of the 5,000
// albums a one-letter query matches on the 30,000-album fixture took 52 ms
// by itself.
const PLAYS_SQL = `
  WITH played AS (SELECT recording_node_id AS r, ${playTotal()} AS n FROM plays GROUP BY recording_node_id)
  SELECT r AS id, n FROM played
  UNION ALL
  SELECT to_node AS id, SUM(n) AS n FROM (
    SELECT e.to_node, played.n
    FROM played CROSS JOIN edges e ON e.from_node = played.r
    WHERE e.type IN ('performed_by', 'appears_on', 'produced_by', 'engineered_by')
    GROUP BY played.r, e.to_node
  ) GROUP BY to_node`;

type Listening = { key: string; plays: Map<number, number>; creditTracks: Map<number, number> };

// Kept between keystrokes until something it counts could have changed: a
// recompute or a merge (the library's revision), a newer edge (enrichment
// adds credits a job at a time without a revision, as routes/library.ts
// notes) or a play added or taken away. A producer's track count is read
// the first time a search ranks them, and kept with the rest.
const listeningCache = new WeakMap<Database, Listening>();

function listening(db: Database): Listening {
  const now = db
    .prepare(
      `SELECT (SELECT COALESCE(MAX(id), 0) FROM edges) AS edge, (SELECT COALESCE(MAX(id), 0) FROM plays) AS play,
              (SELECT COALESCE(${playTotal()}, 0) FROM plays) AS plays`,
    )
    .get() as { edge: number; play: number; plays: number };
  const key = `${libraryRevision()} ${now.edge} ${now.play} ${now.plays}`;
  let known = listeningCache.get(db);
  if (known?.key !== key) {
    const plays = new Map<number, number>();
    for (const row of db.prepare(PLAYS_SQL).all() as { id: number; n: number }[]) plays.set(row.id, (plays.get(row.id) ?? 0) + row.n);
    known = { key, plays, creditTracks: new Map() };
    listeningCache.set(db, known);
  }
  return known;
}

function counted(db: Database, sql: string, ids: number[]): Map<number, number> {
  const rows = db.prepare(sql).all(JSON.stringify(ids)) as { id: number; n: number }[];
  return new Map(rows.map((row) => [row.id, row.n]));
}

function trackCounts(db: Database, kind: SearchKind, ids: number[], known: Listening): Map<number, number> | null {
  if (kind === "recording") return null;
  if (kind !== "credit") return counted(db, TRACKS_SQL[kind], ids);
  const missing = ids.filter((id) => !known.creditTracks.has(id));
  if (missing.length > 0) {
    const read = counted(db, TRACKS_SQL.credit, missing);
    for (const id of missing) known.creditTracks.set(id, read.get(id) ?? 0);
  }
  return known.creditTracks;
}

// Fills in plays and tracks for one kind's candidates.
function addCounts(db: Database, kind: SearchKind, group: Candidate[], known: Listening): void {
  if (group.length === 0) return;
  const tracks = trackCounts(db, kind, group.map((c) => c.id), known);
  for (const c of group) {
    c.plays = known.plays.get(c.id) ?? 0;
    c.tracks = tracks ? (tracks.get(c.id) ?? 0) : 1;
  }
}

function byListening(a: Candidate, b: Candidate): number {
  return b.plays - a.plays || b.tracks - a.tracks || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || a.id - b.id;
}

/** Every match for `query`, best first, within `limits`. */
export function search(db: Database, query: string, { perKind, total }: SearchLimits): SearchHit[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery || perKind <= 0 || total <= 0) return [];
  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.title
       FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
       WHERE nodes_fts MATCH ? AND n.type IN ('artist', 'release', 'recording', 'credit')`,
    )
    .all(ftsQuery) as SearchHit[];

  const q = foldTitle(query);
  const queryWords = words(q);
  const exact: Candidate[] = [];
  const byKind = new Map<SearchKind, Candidate[]>(KIND_ORDER.map((kind) => [kind, []]));
  for (const row of rows) {
    const candidate: Candidate = { id: row.id, type: row.type, title: row.title, folded: foldTitle(row.title), plays: 0, tracks: 0 };
    if (candidate.folded === q) exact.push(candidate);
    else byKind.get(row.type)!.push(candidate);
  }

  const known = listening(db);
  const ranked: Candidate[] = [];
  const taken = new Map<SearchKind, number>(KIND_ORDER.map((kind) => [kind, 0]));
  const roomFor = (kind: SearchKind) => Math.min(perKind - taken.get(kind)!, total - ranked.length);
  const take = (kind: SearchKind, rows: Candidate[]) => {
    ranked.push(...rows);
    taken.set(kind, taken.get(kind)! + rows.length);
  };

  // Exact matches are few; all of them come first, by kind, then listening,
  // each counting towards its kind's share.
  for (const kind of KIND_ORDER) {
    const own = exact.filter((c) => c.type === kind);
    addCounts(db, kind, own, known);
    take(kind, own.sort(byListening).slice(0, Math.max(0, roomFor(kind))));
  }

  // Then each kind in turn, a tier at a time, up to its own share. Track
  // counts are only read for a tier that still reaches into that share, so
  // a producer's tracks are counted only when producers are being ranked.
  for (const kind of KIND_ORDER) {
    const tiers: Candidate[][] = [[], [], [], []];
    for (const c of byKind.get(kind)!) tiers[tierOf(c.folded, q, queryWords)].push(c);
    for (const inTier of tiers.slice(1)) {
      const room = roomFor(kind);
      if (room <= 0) break;
      addCounts(db, kind, inTier, known);
      take(kind, inTier.sort(byListening).slice(0, room));
    }
  }

  return ranked.map(({ id, type, title }) => ({ id, type, title }));
}

// A count asked for, within 1–100; 20 when it isn't a positive number.
function clampCount(raw: string): number {
  const asked = Math.floor(Number(raw));
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;
}

/** What a request asks for. `perKind` (1–100) caps each kind and nothing
 * else; without it, `limit` (1–100, 20 by default) caps the whole answer. */
export function searchLimits(params: { limit?: string; perKind?: string }): SearchLimits {
  if (params.perKind !== undefined) return { perKind: clampCount(params.perKind), total: Infinity };
  const limit = clampCount(params.limit ?? String(DEFAULT_LIMIT));
  return { perKind: limit, total: limit };
}

export function searchRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { q?: string; limit?: string; perKind?: string } }>("/search", async (request) =>
      search(db, request.query.q ?? "", searchLimits(request.query)),
    );
  };
}
