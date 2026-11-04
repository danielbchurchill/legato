import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";

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
 * reach the limit. The limit applies after ranking, so a strong artist match
 * is never cut off behind weaker tracks. */

const KIND_ORDER = ["artist", "release", "recording", "credit"] as const;
export type SearchKind = (typeof KIND_ORDER)[number];
export type SearchHit = { id: number; type: SearchKind; title: string };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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

// The listening behind a node: its own plays for a track, its tracks' plays
// for anything else, through the edges the map draws (performed_by,
// appears_on, produced_by/engineered_by, all from the recording). Asked per
// candidate, from the candidate's side, so the cost follows the matches
// rather than the whole play history.
const PLAYS_SQL: Record<SearchKind, string> = {
  recording: `SELECT c.value AS id, (SELECT COUNT(*) FROM plays p WHERE p.recording_node_id = c.value) AS n
              FROM json_each(?) c`,
  artist: viaEdges("'performed_by'"),
  release: viaEdges("'appears_on'"),
  credit: viaEdges("'produced_by', 'engineered_by'"),
};

function viaEdges(types: string): string {
  return `SELECT c.value AS id,
                 (SELECT COUNT(DISTINCT p.id) FROM edges e JOIN plays p ON p.recording_node_id = e.from_node
                  WHERE e.to_node = c.value AND e.type IN (${types})) AS n
          FROM json_each(?) c`;
}

// How much music is under a node: the aggregate tables' counts for artists
// and albums, the tracks credited for a producer or engineer. A track is one.
const TRACKS_SQL: Record<SearchKind, string | null> = {
  recording: null,
  artist: "SELECT node_id AS id, track_count AS n FROM artists WHERE node_id IN (SELECT value FROM json_each(?))",
  release: "SELECT node_id AS id, track_count AS n FROM albums WHERE node_id IN (SELECT value FROM json_each(?))",
  credit: `SELECT e.to_node AS id, COUNT(DISTINCT e.from_node) AS n FROM edges e
           WHERE e.to_node IN (SELECT value FROM json_each(?)) AND e.type IN ('produced_by', 'engineered_by')
           GROUP BY e.to_node`,
};

function counted(db: Database, sql: string, ids: number[]): Map<number, number> {
  const rows = db.prepare(sql).all(JSON.stringify(ids)) as { id: number; n: number }[];
  return new Map(rows.map((row) => [row.id, row.n]));
}

// Fills in plays and tracks for one kind's candidates.
function addCounts(db: Database, kind: SearchKind, group: Candidate[]): void {
  if (group.length === 0) return;
  const ids = group.map((c) => c.id);
  const plays = counted(db, PLAYS_SQL[kind], ids);
  const tracksSql = TRACKS_SQL[kind];
  const tracks = tracksSql ? counted(db, tracksSql, ids) : null;
  for (const c of group) {
    c.plays = plays.get(c.id) ?? 0;
    c.tracks = tracks ? (tracks.get(c.id) ?? 0) : 1;
  }
}

const kindRank = (kind: SearchKind) => KIND_ORDER.indexOf(kind);

function byListening(a: Candidate, b: Candidate): number {
  return b.plays - a.plays || b.tracks - a.tracks || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || a.id - b.id;
}

/** Every match for `query`, best first, up to `limit`. */
export function search(db: Database, query: string, limit: number): SearchHit[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery || limit <= 0) return [];
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

  // Exact matches are few; all of them come first, by kind, then listening.
  for (const kind of KIND_ORDER) addCounts(db, kind, exact.filter((c) => c.type === kind));
  exact.sort((a, b) => kindRank(a.type) - kindRank(b.type) || byListening(a, b));
  const ranked: Candidate[] = exact.slice(0, limit);

  // Then each kind in turn, a tier at a time. Plays and tracks are only
  // counted for a tier that still reaches into the limit, so one letter
  // typed against a large library doesn't count the plays of every track
  // whose title has a word starting with it.
  for (const kind of KIND_ORDER) {
    if (ranked.length >= limit) break;
    const tiers: Candidate[][] = [[], [], [], []];
    for (const c of byKind.get(kind)!) tiers[tierOf(c.folded, q, queryWords)].push(c);
    for (const inTier of tiers.slice(1)) {
      const room = limit - ranked.length;
      if (room <= 0) break;
      addCounts(db, kind, inTier);
      ranked.push(...inTier.sort(byListening).slice(0, room));
    }
  }

  return ranked.map(({ id, type, title }) => ({ id, type, title }));
}

/** The limit asked for, within 1–100; 20 when it's missing or isn't a
 * number. */
export function searchLimit(raw: string | undefined): number {
  const asked = Math.floor(Number(raw ?? DEFAULT_LIMIT));
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;
}

export function searchRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { q?: string; limit?: string } }>("/search", async (request) =>
      search(db, request.query.q ?? "", searchLimit(request.query.limit)),
    );
  };
}
