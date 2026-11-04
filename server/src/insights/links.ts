import type { Database } from "../sqlite.js";
import { LIBRARY_ARTISTS } from "../routes/library.js";
import { pickMode } from "../entities/mode.js";

/* #468: who each of your artists is tied to, and how. "Your artists" are the
 * library's (routes/library.ts's LIBRARY_ARTISTS): the primary artist of at
 * least one album, the Artists tab's rule, so every artist a card names has
 * records of its own. What they're tied to can be anyone: a producer, a
 * session player, a guest on one track, a label.
 *
 * Recompute works these out and keeps them in insight_links
 * (insights/recompute.ts). Band membership is read live instead (model.ts),
 * because member_of edges arrive from enrichment with no recompute after. */

export type LinkKind =
  | "with"
  | "producer"
  | "engineer"
  | "mixer"
  | "performer"
  | "arranger"
  | "conductor"
  | "remixer"
  | "label"
  | "member"
  | "group";

/** One tie: `via` is `kind` to `artist`. A producer produced the artist's
 *  tracks, a label released their albums, a 'with' was on a track with
 *  them, a 'member' is in the artist (a group), and a 'group' is one the
 *  artist is in. `weight` is how many tracks carry it (albums, for a label),
 *  `witness` one of them, so the map can show it. */
export type Link = { artist: number; via: number; kind: LinkKind; weight: number; witness: number | null };

/* The credit edges that tie a person to an artist, and what the person is
 * to them. Mastering isn't here: one mastering engineer often does a whole
 * label's catalogue, and would link everything to everything without saying
 * anything about the music. Neither is a DJ mix. */
export const CREDIT_KINDS: Record<string, LinkKind> = {
  produced_by: "producer",
  engineered_by: "engineer",
  mixed_by: "mixer",
  performed_credit: "performer",
  arranged_by: "arranger",
  conducted_by: "conductor",
  remixed_by: "remixer",
};

const CREDIT_TYPES_SQL = Object.keys(CREDIT_KINDS)
  .map((type) => `'${type}'`)
  .join(", ");

export function libraryArtistIds(db: Database): Set<number> {
  return new Set((db.prepare(LIBRARY_ARTISTS).all() as { id: number }[]).map((r) => r.id));
}

/** Adds a tie, or one more track to it. */
export function addLink(
  into: Map<string, Link>,
  artist: number,
  via: number,
  kind: LinkKind,
  witness: number | null,
): void {
  if (artist === via) return;
  const key = `${artist}:${via}:${kind}`;
  const link = into.get(key);
  if (link) link.weight += 1;
  else into.set(key, { artist, via, kind, weight: 1, witness });
}

/** The edges recompute's Insights phase reads, from one pass over the
 *  table. edges has no index on type, so each `WHERE type = …` is a scan of
 *  every edge: 1.5M at 30,000 albums, and eight of them took 1.2 s where
 *  this one takes 0.3 s. Shared with similar.ts. */
export type LibraryEdges = {
  /** The newest edge id when the read began. */
  watermark: number;
  /** Each recording with a file: its credited artists, performed_by first
   *  in edge order, then featured guests. */
  performers: Map<number, { artist: number; featured: boolean }[]>;
  /** Each recording's first performed_by node, whatever its type, as the
   *  similarity vectors file a track. */
  firstPerformer: Map<number, number>;
  credits: { rec: number; via: number; type: string }[];
  /** Each recording's album, the first appears_on. */
  albumOf: Map<number, number>;
  /** Every released_on edge, in order. */
  labels: [rec: number, label: number][];
  /** Each recording's year, from its first released_in. */
  yearOf: Map<number, number>;
};

export function readLibraryEdges(db: Database): LibraryEdges {
  // Read first, so a credit enrichment adds while this runs is newer than
  // it and model.ts joins it live.
  const watermark = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM edges").get() as { id: number }).id;
  const withFile = new Set(
    (db.prepare("SELECT DISTINCT recording_node_id FROM files").values() as [number][]).map((r) => r[0]),
  );
  const artistNodes = new Set(
    (db.prepare("SELECT id FROM nodes WHERE type = 'artist'").values() as [number][]).map((r) => r[0]),
  );
  const years = new Map(
    (
      db.prepare("SELECT id, CAST(title AS INTEGER) FROM nodes WHERE type = 'year'").values() as [
        number,
        number | null,
      ][]
    ).filter((r): r is [number, number] => r[1] != null && r[1] > 0),
  );

  const performers = new Map<number, { artist: number; featured: boolean }[]>();
  const featured: [number, number][] = [];
  const firstPerformer = new Map<number, number>();
  const credits: { rec: number; via: number; type: string }[] = [];
  const albumOf = new Map<number, number>();
  const labels: [number, number][] = [];
  const yearOf = new Map<number, number>();
  const types = [
    "performed_by",
    "featured_artist",
    "appears_on",
    "released_on",
    "released_in",
    ...Object.keys(CREDIT_KINDS),
  ];
  for (const [from, to, type] of db
    .prepare(
      `SELECT from_node, to_node, type FROM edges WHERE type IN (${types.map(() => "?").join(", ")}) ORDER BY id`,
    )
    .values(...types) as [number, number, string][]) {
    switch (type) {
      case "performed_by": {
        if (!firstPerformer.has(from)) firstPerformer.set(from, to);
        if (!withFile.has(from) || !artistNodes.has(to)) break;
        const list = performers.get(from);
        if (!list) performers.set(from, [{ artist: to, featured: false }]);
        else if (!list.some((p) => p.artist === to)) list.push({ artist: to, featured: false });
        break;
      }
      case "featured_artist":
        if (withFile.has(from) && artistNodes.has(to)) featured.push([from, to]);
        break;
      case "appears_on":
        if (!albumOf.has(from)) albumOf.set(from, to);
        break;
      case "released_on":
        labels.push([from, to]);
        break;
      case "released_in": {
        const year = years.get(to);
        if (year != null && !yearOf.has(from)) yearOf.set(from, year);
        break;
      }
      default:
        credits.push({ rec: from, via: to, type });
    }
  }
  // Guests after the credited artists, so an artist who is both counts as
  // credited.
  for (const [rec, artist] of featured) {
    const list = performers.get(rec);
    if (!list) performers.set(rec, [{ artist, featured: true }]);
    else if (!list.some((p) => p.artist === artist)) list.push({ artist, featured: true });
  }
  return { watermark, performers, firstPerformer, credits, albumOf, labels, yearOf };
}

/** Every stored tie: shared tracks, credits and labels. */
export function computeLinks(db: Database, edges: LibraryEdges = readLibraryEdges(db)): Link[] {
  const yours = libraryArtistIds(db);
  const links = new Map<string, Link>();

  // On a track together: each of your artists on it is tied to everyone
  // else credited on it.
  for (const [rec, list] of edges.performers) {
    if (list.length < 2) continue;
    for (const a of list) {
      if (!yours.has(a.artist)) continue;
      for (const b of list) addLink(links, a.artist, b.artist, "with", rec);
    }
  }

  // Credits: a person credited on a track is tied to the artists it's by.
  // A featured guest isn't who the track is by, so isn't tied this way.
  for (const credit of edges.credits) {
    const list = edges.performers.get(credit.rec);
    if (!list) continue;
    for (const p of list)
      if (!p.featured && yours.has(p.artist))
        addLink(links, p.artist, credit.via, CREDIT_KINDS[credit.type]!, credit.rec);
  }

  // Labels: an album's label is the one most of its tracks name, as
  // entities/collaboration.ts reads it, and the album is its primary
  // artist's.
  const labelCounts = new Map<number, Map<number, number>>();
  for (const [rec, label] of edges.labels) {
    const album = edges.albumOf.get(rec);
    if (album == null) continue;
    const counts = labelCounts.get(album) ?? new Map<number, number>();
    counts.set(label, (counts.get(label) ?? 0) + 1);
    labelCounts.set(album, counts);
  }
  for (const [album, artist] of db
    .prepare(
      "SELECT node_id, primary_artist_node_id FROM albums WHERE primary_artist_node_id IS NOT NULL ORDER BY node_id",
    )
    .values() as [number, number][]) {
    if (!yours.has(artist)) continue;
    const counts = labelCounts.get(album);
    const label = counts ? pickMode(counts) : null;
    if (label != null) addLink(links, artist, label, "label", album);
  }

  return [...links.values()];
}

/** Credits added since `watermark`, tied to your artists the way
 *  computeLinks ties them. Enrichment adds MusicBrainz's credits one
 *  recording at a time, after the recompute that stored the rest. */
export function creditLinksSince(db: Database, watermark: number, yours: Set<number>): Link[] {
  const links = new Map<string, Link>();
  for (const row of db
    .prepare(
      `SELECT c.from_node AS rec, c.to_node AS via, c.type AS type, p.to_node AS artist
         FROM edges c
         CROSS JOIN edges p ON p.from_node = c.from_node AND p.type = 'performed_by'
        WHERE c.id > ? AND c.type IN (${CREDIT_TYPES_SQL})
        ORDER BY c.id`,
    )
    .all(watermark) as { rec: number; via: number; type: string; artist: number }[]) {
    if (yours.has(row.artist)) addLink(links, row.artist, row.via, CREDIT_KINDS[row.type]!, row.rec);
  }
  return [...links.values()];
}

/** Band membership, read live: a member_of edge ties a group to its member
 *  ('member') if the group is yours, and the member to the group ('group')
 *  if the member is. Built only on member_of edges, so it gets better as
 *  the member lookups do. */
export function memberLinks(
  db: Database,
  yours: Set<number>,
): { links: Link[]; edges: { member: number; group: number }[] } {
  const edges = db
    .prepare("SELECT from_node AS member, to_node AS \"group\" FROM edges WHERE type = 'member_of'")
    .all() as {
    member: number;
    group: number;
  }[];
  const links = new Map<string, Link>();
  for (const { member, group } of edges) {
    if (yours.has(group)) addLink(links, group, member, "member", null);
    if (yours.has(member)) addLink(links, member, group, "group", null);
  }
  return { links: [...links.values()], edges };
}
