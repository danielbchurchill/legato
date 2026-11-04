import type { Database } from "../sqlite.js";
import { libraryRevision } from "../libraryRevision.js";
import { LIBRARY_ARTISTS } from "../routes/library.js";
import { creditLinksSince, memberLinks, type Link, type LinkKind } from "./links.js";

/* #468: everything the connection cards read, in memory: your artists, every
 * tie to them (the stored ones, credits added since, and band membership,
 * read live), and the names of everything involved. Built once per
 * revision of the library and newest edge, as routes/library.ts keeps its
 * credit list: a recompute bumps the revision, and enrichment's credits and
 * member lookups add edges. At 30,000 albums it's a few thousand rows. */

export type Ref = { id: number; title: string; type: string };

export type Model = {
  /** Your artists, by id, with how many albums each is the primary artist of. */
  artists: Map<number, { id: number; title: string; albums: number }>;
  links: Link[];
  byArtist: Map<number, Link[]>;
  byVia: Map<number, Link[]>;
  memberEdges: { member: number; group: number }[];
  nodes: Map<number, Ref>;
  /** Whether a recompute has filled insight_links yet. */
  computed: boolean;
  /** Derived results, worked out once per model (cards.ts). */
  memo: Map<string, unknown>;
};

const cache = new WeakMap<Database, { key: string; model: Model }>();

function titles(db: Database, ids: Iterable<number>): Map<number, Ref> {
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

export function loadModel(db: Database): Model {
  const newestEdge = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM edges").get() as { id: number }).id;
  const key = `${libraryRevision()}:${newestEdge}`;
  const cached = cache.get(db);
  if (cached?.key === key) return cached.model;

  const artistRows = db.prepare(LIBRARY_ARTISTS).all() as { id: number; name: string; releases: number }[];
  const artists = new Map(artistRows.map((r) => [r.id, { id: r.id, title: r.name, albums: r.releases }]));
  const yours = new Set(artists.keys());

  const state = db.prepare("SELECT edge_watermark AS watermark FROM insight_state WHERE id = 1").get() as
    { watermark: number } | undefined;
  const stored = db
    .prepare(
      "SELECT artist_node_id AS artist, via_node_id AS via, kind, weight, witness_node_id AS witness FROM insight_links",
    )
    .all() as Link[];
  const merged = new Map<string, Link>();
  // A stored tie whose artist is no longer yours (its last album gone, or
  // merged into another node since) is left out.
  for (const l of stored) if (yours.has(l.artist)) merged.set(`${l.artist}:${l.via}:${l.kind}`, l);
  // A credit enrichment added since may be one the recompute already saw
  // (MusicBrainz's credits are rewritten whole), so it's counted at most
  // once rather than added on.
  if (state) {
    for (const l of creditLinksSince(db, state.watermark, yours)) {
      const key = `${l.artist}:${l.via}:${l.kind}`;
      const had = merged.get(key);
      if (!had) merged.set(key, l);
      else if (l.weight > had.weight) merged.set(key, { ...had, weight: l.weight });
    }
  }
  const members = memberLinks(db, yours);
  for (const l of members.links) merged.set(`${l.artist}:${l.via}:${l.kind}`, l);

  const nodes = titles(db, [
    ...[...merged.values()].map((l) => l.via),
    ...members.edges.flatMap((e) => [e.member, e.group]),
  ]);
  for (const a of artists.values()) nodes.set(a.id, { id: a.id, title: a.title, type: "artist" });
  // A via node deleted since the recompute has no name, and is left out.
  const links = [...merged.values()].filter((l) => nodes.has(l.via));

  const byArtist = new Map<number, Link[]>();
  const byVia = new Map<number, Link[]>();
  for (const l of links) {
    const ofArtist = byArtist.get(l.artist);
    if (ofArtist) ofArtist.push(l);
    else byArtist.set(l.artist, [l]);
    const ofVia = byVia.get(l.via);
    if (ofVia) ofVia.push(l);
    else byVia.set(l.via, [l]);
  }

  const model: Model = {
    artists,
    links,
    byArtist,
    byVia,
    memberEdges: members.edges.filter((e) => nodes.has(e.member) && nodes.has(e.group)),
    nodes,
    computed: state != null,
    memo: new Map(),
  };
  cache.set(db, { key, model });
  return model;
}

/** Works `make` out once per model. */
export function memo<T>(model: Model, name: string, make: () => T): T {
  if (!model.memo.has(name)) model.memo.set(name, make());
  return model.memo.get(name) as T;
}

/** The kinds of tie that make two artists connected: everything but a
 *  shared label. A label puts records on one shelf; it doesn't say anyone
 *  worked together. */
export const PEOPLE_KINDS: ReadonlySet<LinkKind> = new Set([
  "with",
  "producer",
  "engineer",
  "mixer",
  "performer",
  "arranger",
  "conductor",
  "remixer",
  "member",
  "group",
]);

export function ref(model: Model, id: number): Ref | null {
  return model.nodes.get(id) ?? null;
}
