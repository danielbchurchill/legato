import type { Database } from "../sqlite.js";
import type { Link, LinkKind } from "./links.js";
import { memo, PEOPLE_KINDS, ref, type Model, type Ref } from "./model.js";

/* #468: the connection cards, each worked out from the model (model.ts)
 * once per change to the library and kept with it. Every row carries
 * `focus`: the nodes "show on map" lights, the row's own ones first. The
 * client leaves out whichever aren't on the map. */

const ROWS = 6;
/** A focus list stops here: past it, the map lights so much that nothing
 *  stands out. */
const FOCUS_CAP = 40;

/** The order a person's roles are named in: what made them a bridge first. */
const ROLE_ORDER: LinkKind[] = [
  "member",
  "producer",
  "engineer",
  "mixer",
  "arranger",
  "conductor",
  "performer",
  "remixer",
  "with",
];
const byRole = (a: LinkKind, b: LinkKind) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b);

/** The roles a person can bridge artists through: everything a person is
 *  to an artist. A group one of your artists is in isn't a person; band
 *  families shows those. */
const BRIDGE_KINDS: ReadonlySet<LinkKind> = new Set([...PEOPLE_KINDS].filter((k) => k !== "group"));
/** The people behind the desk, for "Shared producers". */
const DESK_KINDS: ReadonlySet<LinkKind> = new Set(["producer", "engineer", "mixer"]);
/** A person tied to more artists than this is left out of the pairs in
 *  "Shared producers" (every pair of them would be one), though not out of
 *  Bridges. */
const MAX_PAIRS_FANOUT = 200;

const capped = (ids: Iterable<number | null>): number[] =>
  [...new Set([...ids].filter((id): id is number => id != null))].slice(0, FOCUS_CAP);

function byTitle(model: Model) {
  return (a: number, b: number) => (ref(model, a)?.title ?? "").localeCompare(ref(model, b)?.title ?? "") || a - b;
}

function artistRef(model: Model, id: number): Ref {
  const a = model.artists.get(id)!;
  return { id, title: a.title, type: "artist" };
}

/* ---- Bridges ---- */

export type BridgeRow = {
  person: Ref;
  roles: LinkKind[];
  artists: Ref[];
  total: number;
  ownRecords: boolean;
  focus: number[];
};

export function bridges(model: Model): BridgeRow[] {
  return memo(model, "bridges", () => {
    const rows: (BridgeRow & { weight: number })[] = [];
    for (const [via, links] of model.byVia) {
      const tied = new Map<number, { weight: number; witness: number | null }>();
      const roles = new Set<LinkKind>();
      for (const l of links) {
        if (!BRIDGE_KINDS.has(l.kind) || l.artist === via) continue;
        roles.add(l.kind);
        const had = tied.get(l.artist);
        if (had) had.weight += l.weight;
        else tied.set(l.artist, { weight: l.weight, witness: l.witness });
      }
      if (tied.size < 2) continue;
      const order = [...tied].sort((a, b) => b[1].weight - a[1].weight || byTitle(model)(a[0], b[0]));
      rows.push({
        person: ref(model, via)!,
        roles: [...roles].sort(byRole),
        artists: order.slice(0, 5).map(([id]) => artistRef(model, id)),
        total: tied.size,
        ownRecords: model.artists.has(via),
        focus: capped([via, ...order.map(([id]) => id), ...order.map(([, t]) => t.witness)]),
        weight: order.reduce((n, [, t]) => n + t.weight, 0),
      });
    }
    return rows
      .sort((a, b) => b.total - a.total || b.weight - a.weight || a.person.title.localeCompare(b.person.title))
      .slice(0, ROWS)
      .map(({ weight: _weight, ...row }) => row);
  });
}

/* ---- Shared producers ---- */

export type SharedPeopleRow = { artists: [Ref, Ref]; people: { person: Ref; roles: LinkKind[] }[]; focus: number[] };

export function sharedPeople(model: Model): SharedPeopleRow[] {
  return memo(model, "sharedPeople", () => {
    type Pair = { a: number; b: number; people: Map<number, Set<LinkKind>>; weight: number; witnesses: number[] };
    const pairs = new Map<string, Pair>();
    for (const [via, links] of model.byVia) {
      const desk = new Map<number, { kinds: Set<LinkKind>; weight: number; witness: number | null }>();
      for (const l of links) {
        if (!DESK_KINDS.has(l.kind) || l.artist === via) continue;
        const had = desk.get(l.artist) ?? { kinds: new Set<LinkKind>(), weight: 0, witness: l.witness };
        had.kinds.add(l.kind);
        had.weight += l.weight;
        desk.set(l.artist, had);
      }
      if (desk.size < 2 || desk.size > MAX_PAIRS_FANOUT) continue;
      const artists = [...desk.keys()].sort((x, y) => x - y);
      for (let i = 0; i < artists.length; i++) {
        for (let j = i + 1; j < artists.length; j++) {
          const a = artists[i]!;
          const b = artists[j]!;
          const key = `${a}:${b}`;
          const pair: Pair = pairs.get(key) ?? { a, b, people: new Map(), weight: 0, witnesses: [] };
          const da = desk.get(a)!;
          const db = desk.get(b)!;
          pair.people.set(via, new Set([...da.kinds, ...db.kinds]));
          pair.weight += Math.min(da.weight, db.weight);
          pair.witnesses.push(...[da.witness, db.witness].filter((w): w is number => w != null));
          pairs.set(key, pair);
        }
      }
    }
    const sorted = [...pairs.values()].sort(
      (x, y) =>
        y.people.size - x.people.size || y.weight - x.weight || byTitle(model)(x.a, y.a) || byTitle(model)(x.b, y.b),
    );
    // No artist in more than two rows, so one prolific producer's roster
    // doesn't fill the card.
    const used = new Map<number, number>();
    const rows: SharedPeopleRow[] = [];
    for (const pair of sorted) {
      if ((used.get(pair.a) ?? 0) >= 2 || (used.get(pair.b) ?? 0) >= 2) continue;
      used.set(pair.a, (used.get(pair.a) ?? 0) + 1);
      used.set(pair.b, (used.get(pair.b) ?? 0) + 1);
      const people = [...pair.people]
        .sort((x, y) => byTitle(model)(x[0], y[0]))
        .map(([id, kinds]) => ({ person: ref(model, id)!, roles: [...kinds].sort(byRole) }));
      rows.push({
        artists: [artistRef(model, pair.a), artistRef(model, pair.b)],
        people,
        focus: capped([pair.a, pair.b, ...pair.people.keys(), ...pair.witnesses]),
      });
      if (rows.length === ROWS) break;
    }
    return rows;
  });
}

/* ---- Shared labels ---- */

export type LabelRow = { label: Ref; artists: Ref[]; total: number; albums: number; focus: number[] };

function labelGroups(
  model: Model,
): { label: number; artists: { id: number; albums: number; witness: number | null }[] }[] {
  return memo(model, "labelGroups", () => {
    const groups: { label: number; artists: { id: number; albums: number; witness: number | null }[] }[] = [];
    for (const [via, links] of model.byVia) {
      const artists = links
        .filter((l) => l.kind === "label")
        .map((l) => ({ id: l.artist, albums: l.weight, witness: l.witness }));
      if (artists.length > 0) groups.push({ label: via, artists });
    }
    return groups;
  });
}

export function sharedLabels(model: Model): LabelRow[] {
  return memo(model, "sharedLabels", () =>
    labelGroups(model)
      .filter((g) => g.artists.length >= 2)
      .map((g) => {
        const order = [...g.artists].sort((a, b) => b.albums - a.albums || byTitle(model)(a.id, b.id));
        return {
          label: ref(model, g.label)!,
          artists: order.slice(0, 5).map((a) => artistRef(model, a.id)),
          total: order.length,
          albums: order.reduce((n, a) => n + a.albums, 0),
          focus: capped([...order.map((a) => a.id), ...order.map((a) => a.witness)]),
        };
      })
      .sort((a, b) => b.total - a.total || b.albums - a.albums || a.label.title.localeCompare(b.label.title))
      .slice(0, ROWS),
  );
}

/** The labels with the most of your albums, for Library shape. */
export function topLabels(model: Model, limit = 8): { label: Ref; albums: number }[] {
  return labelGroups(model)
    .map((g) => ({ label: ref(model, g.label)!, albums: g.artists.reduce((n, a) => n + a.albums, 0) }))
    .sort((a, b) => b.albums - a.albums || a.label.title.localeCompare(b.label.title))
    .slice(0, limit);
}

/* ---- Band families ---- */

export type FamilyRow = { artists: Ref[]; total: number; through: Ref[]; focus: number[] };

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

export function bandFamilies(model: Model): FamilyRow[] {
  return memo(model, "bandFamilies", () => {
    const uf = new UnionFind();
    const degree = new Map<number, Set<number>>();
    for (const { member, group } of model.memberEdges) {
      uf.union(member, group);
      degree.set(member, (degree.get(member) ?? new Set()).add(group));
      degree.set(group, (degree.get(group) ?? new Set()).add(member));
    }
    const families = new Map<number, number[]>();
    for (const node of degree.keys()) {
      const root = uf.find(node);
      const family = families.get(root);
      if (family) family.push(node);
      else families.set(root, [node]);
    }
    const rows: (FamilyRow & { size: number })[] = [];
    for (const nodes of families.values()) {
      const yours = nodes.filter((id) => model.artists.has(id));
      if (yours.length < 2) continue;
      // Who joins them: anyone else in the family in two or more of its
      // groups (or a group with two or more of its people), most first.
      const through = nodes
        .filter((id) => !model.artists.has(id) && (degree.get(id)?.size ?? 0) >= 2)
        .sort((a, b) => degree.get(b)!.size - degree.get(a)!.size || byTitle(model)(a, b));
      const order = yours.sort(
        (a, b) => model.artists.get(b)!.albums - model.artists.get(a)!.albums || byTitle(model)(a, b),
      );
      rows.push({
        artists: order.slice(0, 6).map((id) => artistRef(model, id)),
        total: yours.length,
        through: through.slice(0, 4).map((id) => ref(model, id)!),
        focus: capped([...order, ...through, ...nodes]),
        size: nodes.length,
      });
    }
    return rows
      .sort((a, b) => b.total - a.total || b.size - a.size || a.artists[0]!.title.localeCompare(b.artists[0]!.title))
      .slice(0, 5)
      .map(({ size: _size, ...row }) => row);
  });
}

/* ---- Most connected, islands, and the web as a whole ---- */

type Neighbours = { artists: Map<number, Set<number>>; people: Map<number, Set<number>> };

/** For each of your artists, the others it shares someone with (or a
 *  track, or a band), and the people it shares them through. */
function neighbours(model: Model): Neighbours {
  return memo(model, "neighbours", () => {
    const artists = new Map<number, Set<number>>();
    const people = new Map<number, Set<number>>();
    for (const id of model.artists.keys()) {
      artists.set(id, new Set());
      people.set(id, new Set());
    }
    for (const [via, links] of model.byVia) {
      const tied = new Set<number>();
      for (const l of links) if (PEOPLE_KINDS.has(l.kind)) tied.add(l.artist);
      if (tied.size === 0) continue;
      for (const a of tied) people.get(a)!.add(via);
      // A via that is one of your artists is tied to each of them directly.
      if (model.artists.has(via)) tied.add(via);
      if (tied.size < 2) continue;
      for (const a of tied) {
        const set = artists.get(a)!;
        for (const b of tied) if (a !== b) set.add(b);
      }
    }
    return { artists, people };
  });
}

export type ConnectedRow = { artist: Ref; artists: number; people: number; focus: number[] };

export function mostConnected(model: Model): ConnectedRow[] {
  return memo(model, "mostConnected", () => {
    const { artists, people } = neighbours(model);
    const rows = [...artists]
      .filter(([, set]) => set.size > 0)
      .sort(
        (a, b) =>
          b[1].size - a[1].size ||
          model.artists.get(b[0])!.albums - model.artists.get(a[0])!.albums ||
          byTitle(model)(a[0], b[0]),
      )
      .slice(0, ROWS)
      .map(([id, set]) => ({
        artist: artistRef(model, id),
        artists: set.size,
        people: people.get(id)!.size,
        focus: capped([id, ...set]),
      }));
    // One shared person each isn't "most connected": say nothing.
    return rows.length > 0 && rows[0]!.artists >= 2 ? rows : [];
  });
}

export type Islands = { artists: Ref[]; total: number };

export function islands(model: Model): Islands | null {
  return memo(model, "islands", () => {
    const { artists } = neighbours(model);
    const alone = [...artists]
      .filter(([, set]) => set.size === 0)
      .map(([id]) => id)
      .sort((a, b) => model.artists.get(b)!.albums - model.artists.get(a)!.albums || byTitle(model)(a, b));
    // Every artist an island means nothing's been found yet, which the
    // panel's opening line says; no artist one means no card.
    if (alone.length === 0 || alone.length === model.artists.size) return null;
    return { artists: alone.slice(0, 12).map((id) => artistRef(model, id)), total: alone.length };
  });
}

export type Web = { artists: number; connected: number; largest: number; groups: number };

export function web(model: Model): Web {
  return memo(model, "web", () => {
    const { artists } = neighbours(model);
    const uf = new UnionFind();
    for (const [a, set] of artists) for (const b of set) uf.union(a, b);
    const sizes = new Map<number, number>();
    for (const a of artists.keys()) sizes.set(uf.find(a), (sizes.get(uf.find(a)) ?? 0) + 1);
    const joined = [...sizes.values()].filter((n) => n >= 2);
    return {
      artists: model.artists.size,
      connected: joined.reduce((n, s) => n + s, 0),
      largest: Math.max(0, ...joined),
      groups: joined.length,
    };
  });
}

/* ---- Recorded together ---- */

export type TogetherRow = { artists: [Ref, Ref]; tracks: number; focus: number[] };

export function recordedTogether(model: Model): TogetherRow[] {
  return memo(model, "recordedTogether", () => {
    const pairs = new Map<string, { a: number; b: number; tracks: number; witness: number | null }>();
    for (const l of model.links) {
      if (l.kind !== "with" || !model.artists.has(l.via)) continue;
      const a = Math.min(l.artist, l.via);
      const b = Math.max(l.artist, l.via);
      const key = `${a}:${b}`;
      const had = pairs.get(key);
      if (!had || l.weight > had.tracks) pairs.set(key, { a, b, tracks: l.weight, witness: l.witness });
    }
    return [...pairs.values()]
      .sort((x, y) => y.tracks - x.tracks || byTitle(model)(x.a, y.a) || byTitle(model)(x.b, y.b))
      .slice(0, ROWS)
      .map((p) => ({
        artists: [artistRef(model, p.a), artistRef(model, p.b)],
        tracks: p.tracks,
        focus: capped([p.a, p.b, p.witness]),
      }));
  });
}

/* ---- Sounds alike ---- */

export type AlikeRow = { artists: [Ref, Ref]; score: number; shared: string[]; focus: number[] };

export function soundsAlike(db: Database, model: Model): AlikeRow[] {
  return memo(model, "soundsAlike", () => {
    const { artists: tied } = neighbours(model);
    const labels = new Map<number, Set<number>>();
    for (const g of labelGroups(model))
      for (const a of g.artists) labels.set(a.id, (labels.get(a.id) ?? new Set()).add(g.label));
    const shareLabel = (a: number, b: number) => [...(labels.get(a) ?? [])].some((l) => labels.get(b)?.has(l));

    const rows: AlikeRow[] = [];
    const used = new Set<number>();
    const seen = new Set<string>();
    for (const row of db
      .prepare(
        `SELECT artist_node_id AS a, other_node_id AS b, score, shared FROM insight_similar_artists
          ORDER BY score DESC, artist_node_id, other_node_id`,
      )
      .all() as { a: number; b: number; score: number; shared: string }[]) {
      const key = `${Math.min(row.a, row.b)}:${Math.max(row.a, row.b)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!model.artists.has(row.a) || !model.artists.has(row.b)) continue;
      // "No direct connection": nobody in common, no track, no band and no
      // label. A pair the map already ties together isn't news.
      if (tied.get(row.a)?.has(row.b) || shareLabel(row.a, row.b)) continue;
      // Each artist once, so one prolific genre doesn't fill the card.
      if (used.has(row.a) || used.has(row.b)) continue;
      used.add(row.a);
      used.add(row.b);
      let shared: string[] = [];
      try {
        shared = JSON.parse(row.shared) as string[];
      } catch {
        shared = [];
      }
      rows.push({
        artists: [artistRef(model, row.a), artistRef(model, row.b)],
        score: row.score,
        shared,
        focus: [row.a, row.b],
      });
      if (rows.length === 5) break;
    }
    return rows;
  });
}

/* ---- How are these connected? ---- */

export type PathLink = { kind: LinkKind; artistFirst: boolean; weight: number };
export type Path = { nodes: Ref[]; links: PathLink[]; focus: number[] };

/** A label step costs this much, so a path through people wins over an
 *  equally short one through a label: sharing a label says less. */
const LABEL_COST = 2;

/** Which step names a tie best, when two are as short. */
const STEP_RANK: Record<LinkKind, number> = {
  member: 0,
  group: 0,
  with: 1,
  producer: 2,
  engineer: 2,
  mixer: 2,
  arranger: 2,
  conductor: 2,
  performer: 2,
  remixer: 2,
  label: 3,
};

type Adjacent = { to: number; link: Link; cost: number };

function graph(model: Model): Map<number, Adjacent[]> {
  return memo(model, "graph", () => {
    const adjacency = new Map<number, Adjacent[]>();
    const add = (from: number, to: number, link: Link) => {
      const list = adjacency.get(from);
      const entry = { to, link, cost: link.kind === "label" ? LABEL_COST : 1 };
      if (list) list.push(entry);
      else adjacency.set(from, [entry]);
    };
    for (const l of model.links) {
      add(l.artist, l.via, l);
      add(l.via, l.artist, l);
    }
    return adjacency;
  });
}

/** Cheapest paths from `from` to everything it reaches: a plain Dijkstra
 *  over a graph of a few thousand nodes. */
function search(
  model: Model,
  from: number,
): Map<number, { cost: number; prev: number | null; link: Link | null; hops: number }> {
  const adjacency = graph(model);
  const best = new Map<number, { cost: number; prev: number | null; link: Link | null; hops: number }>([
    [from, { cost: 0, prev: null, link: null, hops: 0 }],
  ]);
  const done = new Set<number>();
  // A binary heap of [cost, node].
  const heap: [number, number][] = [[0, from]];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]![0] <= item[0]) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = item;
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = -1;
        let smallest = last[0];
        if (l < heap.length && heap[l]![0] < smallest) {
          m = l;
          smallest = heap[l]![0];
        }
        if (r < heap.length && heap[r]![0] < smallest) m = r;
        if (m < 0) break;
        heap[i] = heap[m]!;
        i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  while (heap.length > 0) {
    const [cost, node] = pop();
    if (done.has(node)) continue;
    done.add(node);
    const here = best.get(node)!;
    for (const { to, link, cost: step } of adjacency.get(node) ?? []) {
      const next = cost + step;
      const had = best.get(to);
      if (had && had.cost < next) continue;
      // At equal cost, the stronger step is named: a band before a shared
      // track, a shared track before a credit, a credit before a label,
      // then the one carrying more tracks.
      if (had && had.cost === next) {
        const was = had.link == null ? -1 : STEP_RANK[had.link.kind];
        const is = STEP_RANK[link.kind];
        const better = had.link != null && (is < was || (is === was && link.weight > had.link.weight));
        if (!better) continue;
      }
      best.set(to, { cost: next, prev: node, link, hops: here.hops + 1 });
      push([next, to]);
    }
  }
  return best;
}

function pathTo(model: Model, best: ReturnType<typeof search>, to: number): Path | null {
  if (!best.has(to)) return null;
  const nodes: number[] = [];
  const links: PathLink[] = [];
  let at: number | null = to;
  while (at != null) {
    nodes.unshift(at);
    const step: { prev: number | null; link: Link | null } = best.get(at)!;
    if (step.link && step.prev != null)
      links.unshift({ kind: step.link.kind, artistFirst: step.link.artist === step.prev, weight: step.link.weight });
    at = step.prev;
  }
  const witnesses: number[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const link = best.get(nodes[i]!)!.link;
    if (link?.witness != null) witnesses.push(link.witness);
  }
  return { nodes: nodes.map((id) => ref(model, id)!), links, focus: [...new Set([...nodes, ...witnesses])] };
}

/** The shortest way from one of your artists to another, each step named;
 *  null when nothing joins them. */
export function connect(model: Model, from: number, to: number): Path | null {
  if (!model.artists.has(from) || !model.artists.has(to)) return null;
  if (from === to) return { nodes: [artistRef(model, from)], links: [], focus: [from] };
  return pathTo(model, search(model, from), to);
}

/** Two artists to start "How are these connected?" with, far apart: from
 *  the most connected artist to the one of yours the most steps away, then
 *  from there to the one the most steps from it. Two searches find a pair
 *  close to the farthest apart, where trying every pair would take one
 *  search per artist. */
export function pathSuggestion(model: Model): { from: Ref; to: Ref } | null {
  return memo(model, "pathSuggestion", () => {
    const start = mostConnected(model)[0]?.artist.id ?? [...neighbours(model).artists].find(([, s]) => s.size > 0)?.[0];
    if (start == null) return null;
    const farthest = (from: number): { id: number; hops: number } | null => {
      let far: { id: number; hops: number } | null = null;
      for (const [id, step] of search(model, from)) {
        if (id === from || !model.artists.has(id)) continue;
        if (!far || step.hops > far.hops || (step.hops === far.hops && id < far.id)) far = { id, hops: step.hops };
      }
      return far;
    };
    const one = farthest(start);
    if (!one) return null;
    const two = farthest(one.id);
    const [from, to, hops] = two && two.hops > one.hops ? [one.id, two.id, two.hops] : [start, one.id, one.hops];
    // Two artists tied directly leave the card nothing to find.
    return hops >= 2 ? { from: artistRef(model, from), to: artistRef(model, to) } : null;
  });
}

/** Your artists whose name holds `q`, ignoring case and accents, for the
 *  path card's pickers. */
export function findArtists(model: Model, q: string, limit: number): Ref[] {
  const fold = (s: string) =>
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
  const needle = fold(q.trim());
  const all = memo(model, "artistsByName", () =>
    [...model.artists.values()]
      .map((a) => ({ ref: artistRef(model, a.id), folded: fold(a.title) }))
      .sort((a, b) => a.folded.localeCompare(b.folded) || a.ref.id - b.ref.id),
  );
  const hits = needle ? all.filter((a) => a.folded.includes(needle)) : all;
  return hits.slice(0, limit).map((a) => a.ref);
}
