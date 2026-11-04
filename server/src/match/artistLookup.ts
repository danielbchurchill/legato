import type { Database } from "../sqlite.js";

// Issue #466: which artist node a name means. The ALBUMARTIST tags on the
// reference library say "The Traveling Wilburys" and MusicBrainz's
// band-membership answer says "Traveling Wilburys", and an exact-name lookup
// made those two nodes. Bob Dylan's, Tom Petty's and George Harrison's
// member_of edges all went to the one with no files, which has no place on
// the map, so none of them were drawn.
//
// The rule, for every artist lookup: case, outer spaces and a leading "The"
// don't make two artists. A tag (match/edges.ts's findOrCreatePerson), a
// band-membership answer (enrich/members.ts) and the startup fold
// (match/artistFold.ts) all use it, so what one finds the others find.
//
// Case and outer spaces are SQLite's lower(trim()), which migration 0030
// indexes and every node lookup already used. Without ICU, which sqlite.ts
// doesn't load, lower() folds only A-Z and trim() removes only spaces.
// artistNameKey does exactly that in JS, so a key worked out here agrees
// with the index about which titles match.

function sqliteLowerTrim(value: string): string {
  return value.replace(/^ +| +$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

const LEADING_THE = "the ";

/** Whether two names are the same spelling once case and outer spaces are
 *  set aside, as an exact-name lookup has always compared them. */
export function isSameSpelling(a: string, b: string): boolean {
  return sqliteLowerTrim(a) === sqliteLowerTrim(b);
}

/** What two spellings of one artist share: lower(trim(name)) without a
 *  leading "the ". "The Traveling Wilburys", "traveling wilburys " and
 *  "TRAVELING WILBURYS" all give "traveling wilburys". */
export function artistNameKey(name: string): string {
  const lowered = sqliteLowerTrim(name);
  return lowered.startsWith(LEADING_THE) ? lowered.slice(LEADING_THE.length) : lowered;
}

// Both spellings of a key, as two lookups on migration 0030's index:
// lower(trim(title)) has to stay written the way the index is.
const ARTISTS_BY_KEY_SQL =
  "SELECT id, lower(trim(title)) AS lowered FROM nodes WHERE type = 'artist' AND lower(trim(title)) IN (?, ?) ORDER BY id";

/** Exported for artistLookup.spec.ts, which asks the planner whether it
 *  uses the index. */
export function artistsByKeyQuery(name: string): { sql: string; params: [string, string] } {
  const key = artistNameKey(name);
  return { sql: ARTISTS_BY_KEY_SQL, params: [key, LEADING_THE + key] };
}

/** The MusicBrainz artist id this artist node is known by, or null. The
 *  newest row wins, as resolveArtistMbid (enrich/worker.ts) reads it. */
export function artistMbidOf(db: Database, nodeId: number): string | null {
  const row = db
    .prepare("SELECT value FROM field_provenance WHERE node_id = ? AND field = 'artist_mbid' ORDER BY id DESC LIMIT 1")
    .get(nodeId) as { value: string | null } | undefined;
  return row?.value ?? null;
}

// Migration 0048's partial index answers this; it needs `field =
// 'artist_mbid'` written out.
const ARTIST_BY_MBID_SQL = `SELECT n.id FROM field_provenance fp JOIN nodes n ON n.id = fp.node_id
  WHERE fp.field = 'artist_mbid' AND fp.value = ? AND n.type = 'artist'
  ORDER BY EXISTS (SELECT 1 FROM artists a WHERE a.node_id = n.id AND a.track_count > 0) DESC, n.id
  LIMIT 1`;

/** Exported for artistLookup.spec.ts's planner check. */
export const ARTIST_BY_MBID_QUERY = ARTIST_BY_MBID_SQL;

/** The artist node holding this MusicBrainz artist id, if one does. If more
 *  than one does, the one with tracks of its own, then the oldest. */
export function findArtistByMbid(db: Database, mbid: string): number | undefined {
  return (db.prepare(ARTIST_BY_MBID_SQL).get(mbid) as { id: number } | undefined)?.id;
}

/** The artist node a name means, by the rule above. `mbid` is the
 *  MusicBrainz id of the artist being looked for, if known. In order:
 *  a node with that id; a node with the same name exactly (case and outer
 *  spaces aside), which is that artist whatever its id says, as it always
 *  was; a node whose name only matches once "The" is ignored, unless both
 *  have ids and they differ, which makes them two artists who share a name.
 *  The oldest wins a tie. */
export function findArtistByName(db: Database, name: string, mbid?: string | null): number | undefined {
  const { sql, params } = artistsByKeyQuery(name);
  const candidates = db.prepare(sql).all(...params) as { id: number; lowered: string }[];
  if (candidates.length === 0) return undefined;

  const lowered = sqliteLowerTrim(name);
  const exact = candidates.find((candidate) => candidate.lowered === lowered);
  // The common case, on every file a recompute derives: one node, the same
  // name. Nothing else could win, so no id is read.
  if (candidates.length === 1 && exact) return exact.id;
  if (!mbid) return (exact ?? candidates[0]!).id;

  const ids = candidates.map((candidate) => ({ ...candidate, mbid: artistMbidOf(db, candidate.id) }));
  return (ids.find((c) => c.mbid === mbid) ?? exact ?? ids.find((c) => c.mbid === null))?.id;
}

/** Records the MusicBrainz artist id a band-membership answer named a node
 *  by, unless the node already has one. Confidence 1: it's MusicBrainz's own
 *  id for the artist it related, not a search by name (worker.ts's
 *  resolveArtistMbid), which then finds it here instead of searching. */
export function rememberArtistMbid(db: Database, nodeId: number, mbid: string): void {
  if (artistMbidOf(db, nodeId) !== null) return;
  db.prepare(
    `INSERT INTO field_provenance (node_id, field, value, source, confidence, note)
     VALUES (?, 'artist_mbid', ?, 'musicbrainz', 1, 'named by a band-membership relation')`,
  ).run(nodeId, mbid);
}
