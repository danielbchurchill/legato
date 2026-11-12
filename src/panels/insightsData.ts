import { createContext, useContext } from 'react'
import { useGraph } from '../canvas/graphContext'
import { useLibraryChanges } from '../library/useLibraryChanges'
import { useFetched } from './healthData'

/* #468: what GET /insights answers (server/src/routes/insights.ts), and the
 * words the panel says it in. Every row carries `focus`, the nodes "show on
 * map" lights, its own first. */

export type Ref = { id: number; title: string; type: string }

/** What a name and a map button do: open a node's details, and light nodes
 * on the map. The panel's caller says how, for the desktop or the phone,
 * and which kinds of node the map options draw (#482). */
export type InsightsActions = {
  onOpenNode: (id: number) => void
  onShowOnMap: (ids: number[]) => void
  drawsKind: (type: string) => boolean
}

export const InsightsActionsContext = createContext<InsightsActions>({
  onOpenNode: () => {},
  onShowOnMap: () => {},
  drawsKind: () => true,
})

/** Whether the map draws a node: it has a place on the map, and the map
 * options show its kind (#482). A label has no place; a producer has one,
 * drawn only while producers are shown. */
export function useDrawn(): (id: number) => boolean {
  const { byId } = useGraph()
  const { drawsKind } = useContext(InsightsActionsContext)
  return (id) => {
    const node = byId.get(id)
    return node != null && drawsKind(node.type)
  }
}

export type LinkKind =
  'with' | 'producer' | 'engineer' | 'mixer' | 'performer' | 'arranger' | 'conductor' | 'remixer' | 'label' | 'member' | 'group'

export type BridgeRow = { person: Ref; roles: LinkKind[]; artists: Ref[]; total: number; ownRecords: boolean; focus: number[] }
export type SharedPeopleRow = { artists: [Ref, Ref]; people: { person: Ref; roles: LinkKind[] }[]; focus: number[] }
export type LabelRow = { label: Ref; artists: Ref[]; total: number; albums: number; focus: number[] }
export type FamilyRow = { artists: Ref[]; total: number; through: Ref[]; focus: number[] }
export type ConnectedRow = { artist: Ref; artists: number; people: number; focus: number[] }
export type TogetherRow = { artists: [Ref, Ref]; tracks: number; focus: number[] }
export type AlikeRow = { artists: [Ref, Ref]; score: number; shared: string[]; focus: number[] }
export type PlayedRow = { node: Ref; plays: number; by: Ref | null; focus: number[] }
export type RediscoverRow = { artist: Ref; plays: number; lastPlayed: string; focus: number[] }
export type WaitingRow = { album: Ref; by: Ref | null; year: number | null; addedAt: string; focus: number[] }
export type CareerRow = { artist: Ref; first: number; last: number; albums: number; focus: number[] }
export type Web = { artists: number; connected: number; largest: number; groups: number }
export type PathLink = { kind: LinkKind; artistFirst: boolean; weight: number }
export type Path = { nodes: Ref[]; links: PathLink[]; focus: number[] }

export type Insights =
  | { state: 'empty' }
  | {
      state: 'pending' | 'ready'
      web: Web
      bridges: BridgeRow[]
      sharedPeople: SharedPeopleRow[]
      sharedLabels: LabelRow[]
      bandFamilies: FamilyRow[]
      mostConnected: ConnectedRow[]
      islands: { artists: Ref[]; total: number } | null
      recordedTogether: TogetherRow[]
      soundsAlike: AlikeRow[]
      pathSuggestion: { from: Ref; to: Ref } | null
      mostPlayed: { artists: PlayedRow[]; albums: PlayedRow[]; tracks: PlayedRow[] }
      onRepeat: PlayedRow[]
      rediscover: RediscoverRow[]
      waiting: { albums: WaitingRow[]; total: number }
      shape: { decades: { decade: number; albums: number }[]; undated: number; labels: { label: Ref; albums: number }[] }
      careers: CareerRow[]
    }

export type ReadyInsights = Exclude<Insights, { state: 'empty' }>

/** GET /insights, again after each change to the library and after an
 * outage, keeping what it had through a failed refetch. */
export function useInsights(): Insights | null {
  return useFetched<Insights>('/insights', ['scan:done'], { revision: useLibraryChanges(), keep: true }).data
}

/** The cards a ready answer has something to say on, in the panel's order.
 * A card with nothing to say isn't in the list. */
export type CardId =
  | 'bridges'
  | 'path'
  | 'bandFamilies'
  | 'sharedPeople'
  | 'recordedTogether'
  | 'sharedLabels'
  | 'mostConnected'
  | 'islands'
  | 'soundsAlike'
  | 'mostPlayed'
  | 'onRepeat'
  | 'rediscover'
  | 'waiting'
  | 'careers'
  | 'shape'

export function cardsWithSomethingToSay(insights: ReadyInsights): CardId[] {
  const has: Record<CardId, boolean> = {
    bridges: insights.bridges.length > 0,
    path: insights.pathSuggestion != null,
    bandFamilies: insights.bandFamilies.length > 0,
    sharedPeople: insights.sharedPeople.length > 0,
    recordedTogether: insights.recordedTogether.length > 0,
    sharedLabels: insights.sharedLabels.length > 0,
    mostConnected: insights.mostConnected.length > 0,
    islands: insights.islands != null,
    soundsAlike: insights.soundsAlike.length > 0,
    mostPlayed: insights.mostPlayed.artists.length + insights.mostPlayed.albums.length + insights.mostPlayed.tracks.length > 0,
    onRepeat: insights.onRepeat.length > 0,
    rediscover: insights.rediscover.length > 0,
    waiting: insights.waiting.albums.length > 0,
    careers: insights.careers.length > 0,
    shape: insights.shape.decades.length > 1 || insights.shape.labels.length > 1,
  }
  return (Object.keys(has) as CardId[]).filter((id) => has[id])
}

/** The panel's opening line: how much of the library is one web. */
export function webLine(web: Web): string | null {
  if (web.artists < 2) return null
  if (web.connected === 0)
    return `None of your ${web.artists} artists share anyone yet. Credits and band members fill this in as they're looked up.`
  if (web.largest === web.artists)
    return `All ${web.artists} of your artists connect to each other through the people and tracks they share.`
  if (web.groups === 1)
    return `${web.largest} of your ${web.artists} artists connect to each other through the people and tracks they share.`
  return `${web.connected} of your ${web.artists} artists connect through the people and tracks they share, in ${web.groups} separate webs. The biggest has ${web.largest}.`
}

/* What someone is to an artist, as a word in a list. */
const ROLE_WORD: Record<LinkKind, string> = {
  member: 'member',
  group: 'band',
  producer: 'producer',
  engineer: 'engineer',
  mixer: 'mixing',
  arranger: 'arranger',
  conductor: 'conductor',
  performer: 'session player',
  remixer: 'remixer',
  with: 'on tracks with',
  label: 'label',
}

export function roleWords(roles: LinkKind[]): string {
  return roles.map((role) => ROLE_WORD[role]).join(', ')
}

/** A path step's words, read from the node before it to the node after:
 * "is a member of", "produced", "is on a track with". `artistFirst` says
 * whether the node before is the tie's artist side. */
export function stepWords({ kind, artistFirst, weight }: PathLink): string {
  switch (kind) {
    case 'member':
      return artistFirst ? 'has as a member' : 'is a member of'
    case 'group':
      return artistFirst ? 'is a member of' : 'has as a member'
    case 'with':
      return weight > 1 ? `is on ${weight} tracks with` : 'is on a track with'
    case 'label':
      return artistFirst ? 'is on the label' : 'also put out'
    case 'performer':
      return artistFirst ? 'has playing on its records' : 'plays on records by'
    case 'producer':
      return artistFirst ? 'was produced by' : 'produced'
    case 'engineer':
      return artistFirst ? 'was engineered by' : 'engineered'
    case 'mixer':
      return artistFirst ? 'was mixed by' : 'mixed'
    case 'arranger':
      return artistFirst ? 'was arranged by' : 'arranged for'
    case 'conductor':
      return artistFirst ? 'was conducted by' : 'conducted'
    case 'remixer':
      return artistFirst ? 'was remixed by' : 'remixed'
  }
}

/* What someone or something is on a path, as a noun: "Mara Quinn,
 * producer". */
const ROLE_NOUN: Record<LinkKind, string> = { ...ROLE_WORD, mixer: 'mixer', with: 'artist' }

const roleNouns = (kinds: LinkKind[]) => [...new Set(kinds)].map((kind) => ROLE_NOUN[kind]).join(', ')

/** #504: the credits the map has no line for. Their edges (arranged_by,
 * conducted_by, remixed_by) aren't among the map's edge types (EDGE_TYPES
 * in server/src/routes/nodes.ts), so a step through one can't be lit even
 * when the map draws both of its ends. */
export const NO_LINE_KINDS: ReadonlySet<LinkKind> = new Set<LinkKind>(['arranger', 'conductor', 'remixer'])

/** A node on a path the map doesn't draw, and what it is on the way. With
 * `line` (#504), the map draws the node, but not the line of a step to it. */
export type HiddenStep = { node: Ref; role: string; line: boolean }

/** #482: the nodes of a path the map leaves out (a producer while the map
 * options hide producers, a label, which the map never draws), each with
 * what it is to the artists either side of it. #504: and the nodes it
 * draws at the credited end of a step it has no line for (an arranger, a
 * conductor, a remixer), when it draws the step's other end too. */
export function hiddenSteps(path: Path, drawn: (id: number) => boolean): HiddenStep[] {
  const hidden: HiddenStep[] = []
  path.nodes.forEach((node, i) => {
    // The node is the tie's other side when the artist side is its
    // neighbour: the node before it on the link in, the node after on the
    // link out.
    const sides: { kind: LinkKind; artist: number }[] = []
    const into = path.links[i - 1]
    const out = path.links[i]
    if (into?.artistFirst) sides.push({ kind: into.kind, artist: path.nodes[i - 1]!.id })
    if (out && !out.artistFirst) sides.push({ kind: out.kind, artist: path.nodes[i + 1]!.id })
    if (!drawn(node.id)) {
      hidden.push({ node, role: sides.length > 0 ? roleNouns(sides.map((side) => side.kind)) : node.type, line: false })
      return
    }
    const unlined = sides.filter((side) => NO_LINE_KINDS.has(side.kind) && drawn(side.artist))
    if (unlined.length > 0) hidden.push({ node, role: roleNouns(unlined.map((side) => side.kind)), line: true })
  })
  return hidden
}

/** Two ends of a row or a path (its artists, people and labels) that one of
 * the tracks or albums in its focus ties together. */
export type Tie = readonly [number, number]

/** #482, #504: the drawn-step rule, for what a map button lights. Every one
 * of `ends` the map draws lights. A track or album of `witnesses` lights
 * only for a tie whose two ends the map draws, and only when the map's
 * edges join it to both: it's the one that ties them, whatever order the
 * server lists witnesses in. A tie with an end the map leaves out is left
 * unlit, its witness too, so nothing lit stops at a node the map doesn't
 * draw. It's a pass over every edge, so it's worked out on a click, not on
 * every render. */
export function drawnFocus(
  ends: number[],
  ties: readonly Tie[],
  witnesses: number[],
  drawn: (id: number) => boolean,
  edges: Iterable<{ from_node: number; to_node: number }>,
): number[] {
  const lit = ends.filter(drawn)
  const shown = ties.filter(([a, b]) => drawn(a) && drawn(b))
  const candidates = new Set(witnesses.filter(drawn))
  if (shown.length > 0 && candidates.size > 0) {
    const tied = new Set(shown.flat())
    // Which ends each witness is joined to.
    const joined = new Map<number, Set<number>>()
    const join = (witness: number, end: number) => {
      const set = joined.get(witness) ?? new Set<number>()
      set.add(end)
      joined.set(witness, set)
    }
    for (const edge of edges) {
      if (candidates.has(edge.from_node) && tied.has(edge.to_node)) join(edge.from_node, edge.to_node)
      else if (candidates.has(edge.to_node) && tied.has(edge.from_node)) join(edge.to_node, edge.from_node)
    }
    for (const [a, b] of shown) {
      for (const witness of candidates) if (joined.get(witness)?.has(a) && joined.get(witness)?.has(b)) lit.push(witness)
    }
  }
  return [...new Set(lit)]
}

/** #482: what "show the way on the map" lights: the drawn-step rule, with
 * each step a tie. #504: a step the map has no line for lights no track,
 * so the lit way matches what the card names. */
export function pathFocus(path: Path, drawn: (id: number) => boolean, edges: Iterable<{ from_node: number; to_node: number }>): number[] {
  const ends = path.nodes.map((node) => node.id)
  const onPath = new Set(ends)
  const ties = path.links.flatMap((link, i): Tie[] => (NO_LINE_KINDS.has(link.kind) ? [] : [[ends[i]!, ends[i + 1]!]]))
  return drawnFocus(
    ends,
    ties,
    path.focus.filter((id) => !onPath.has(id)),
    drawn,
    edges,
  )
}

/** #504: the ties of a row about one person or label: theirs to each of
 * the row's other ends. A Bridges row's person is tied to every artist
 * they link, a shared label to every artist on it. */
export function hubTies(hub: number): (ends: number[]) => Tie[] {
  return (ends) => ends.filter((id) => id !== hub).map((id): Tie => [hub, id])
}

/* The kinds of node that witness a tie: the track a credit or a shared
 * track is on, and the album a label put out (`witness` in
 * server/src/insights/links.ts). No row's tie has one at either end. */
const WITNESS_TYPES: ReadonlySet<string> = new Set(['recording', 'release'])

/** #504: a row's focus, as its ends and the tracks and albums that witness
 * its ties. `typeOf` is a node's kind on the map. A node the map has no
 * place for is never lit, so which it's counted as doesn't matter. */
export function splitFocus(focus: number[], typeOf: (id: number) => string | undefined): { ends: number[]; witnesses: number[] } {
  const ends: number[] = []
  const witnesses: number[] = []
  for (const id of focus) (WITNESS_TYPES.has(typeOf(id) ?? '') ? witnesses : ends).push(id)
  return { ends, witnesses }
}

/** "Mar 2026", for when something was last played. */
export function monthYear(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

/** The decade most of the library is from, and its share, or null when no
 * album has a year. */
export function peakDecade(decades: { decade: number; albums: number }[]): { decade: number; share: number } | null {
  const total = decades.reduce((n, d) => n + d.albums, 0)
  if (total === 0) return null
  const top = [...decades].sort((a, b) => b.albums - a.albums || a.decade - b.decade)[0]!
  return { decade: top.decade, share: top.albums / total }
}
