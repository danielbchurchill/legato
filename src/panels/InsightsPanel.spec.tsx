// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { GraphEdge, GraphNode } from '../canvas/useGraphData'
import { TouchLayoutContext } from '../ui/touchLayout'
import { InsightsPanel } from './InsightsPanel'
import type { Insights, ReadyInsights } from './insightsData'
import { mapDraws } from './mapShow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ref = (id: number, title: string, type = 'artist') => ({ id, title, type })
const beatles = ref(1, 'The Beatles')
const wilburys = ref(2, 'Traveling Wilburys')
const harrison = ref(3, 'George Harrison')
const petty = ref(5, 'Tom Petty')

/** A library with Bridges, a path and a most-played track to say, and
 * nothing for every other card. */
function ready(overrides: Partial<ReadyInsights> = {}): ReadyInsights {
  return {
    state: 'ready',
    web: { artists: 5, connected: 4, largest: 4, groups: 1 },
    bridges: [
      { person: harrison, roles: ['member', 'producer'], artists: [beatles, wilburys], total: 2, ownRecords: true, focus: [3, 1, 2, 99] },
    ],
    sharedPeople: [],
    sharedLabels: [],
    bandFamilies: [],
    mostConnected: [],
    islands: null,
    recordedTogether: [],
    soundsAlike: [],
    pathSuggestion: null,
    mostPlayed: {
      artists: [],
      albums: [],
      tracks: [{ node: ref(10, 'Handle with Care', 'recording'), plays: 7, by: wilburys, focus: [10] }],
    },
    onRepeat: [],
    rediscover: [],
    waiting: { albums: [], total: 0 },
    shape: { decades: [], undated: 0, labels: [] },
    careers: [],
    ...overrides,
  }
}

let answer: Insights
let path: unknown
const roots: Root[] = []

beforeEach(() => {
  // Tooltips ask about reduced motion.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  vi.stubGlobal(
    'WebSocket',
    class {
      static CLOSED = 3
      readyState = 0
      close() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const { pathname } = new URL(url)
      const body = pathname.endsWith('/insights') ? answer : pathname.endsWith('/insights/artists') ? [beatles, petty, harrison] : { path }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** The panel, with the nodes in `onMap` on the map, or `nodes` and
 * `edges` as the map's graph, and the map options in `settings`. */
async function render(
  options: {
    onMap?: number[]
    nodes?: { id: number; type: string }[]
    edges?: [from: number, to: number][]
    settings?: Record<string, string>
    phone?: boolean
  } = {},
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const onOpenNode = vi.fn()
  const onShowOnMap = vi.fn()
  const nodes = options.nodes ?? (options.onMap ?? [1, 2, 3, 10]).map((id) => ({ id, type: 'artist' }))
  const graph: GraphData = {
    nodes: [],
    edges: (options.edges ?? []).map(([from, to], i) => ({ id: i + 1, from_node: from, to_node: to }) as GraphEdge),
    loading: false,
    refetch: async () => {},
    byId: new Map(nodes.map((node) => [node.id, node as unknown as GraphNode])),
  }
  const drawsKind = (type: string) => mapDraws(options.settings ?? {}, type)
  const wrap = (child: ReactNode) =>
    createElement(
      GraphDataContext.Provider,
      { value: graph },
      createElement(TouchLayoutContext.Provider, { value: options.phone ?? false }, child),
    )
  await act(async () => root.render(wrap(createElement(InsightsPanel, { onOpenNode, onShowOnMap, drawsKind, phone: options.phone }))))
  // The fetches and what they set.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return { container, onOpenNode, onShowOnMap }
}

const section = (container: HTMLElement, title: string) => container.querySelector<HTMLElement>(`section[aria-label="${title}"]`)
const button = (scope: HTMLElement, text: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent === text)!

describe('InsightsPanel', () => {
  it('says one plain line, and nothing else, for a library with nothing scanned', async () => {
    answer = { state: 'empty' }
    const { container } = await render()
    expect(container.textContent).toContain('Insights appear here once your library is scanned')
    expect(container.querySelectorAll('section')).toHaveLength(0)
  })

  it('draws the cards with something to say, and leaves out the rest', async () => {
    answer = ready()
    const { container } = await render()
    expect(section(container, 'Bridges')).not.toBeNull()
    expect(section(container, 'Most played')).not.toBeNull()
    for (const empty of [
      'Shared labels',
      'Band families',
      'Islands',
      'Sounds alike',
      'Waiting for you',
      'Rediscover',
      'How are these connected?',
    ]) {
      expect(section(container, empty)).toBeNull()
    }
  })

  it('says each bridge in a sentence, with what the person is to them', async () => {
    answer = ready()
    const { container } = await render()
    const bridges = section(container, 'Bridges')!
    expect(bridges.textContent).toContain('George Harrison links The Beatles and Traveling Wilburys')
    expect(bridges.textContent).toContain('member, producer · has records of their own')
  })

  it('opens a name in the details panel', async () => {
    answer = ready()
    const { container, onOpenNode } = await render()
    act(() => button(section(container, 'Bridges')!, 'Traveling Wilburys').click())
    expect(onOpenNode).toHaveBeenCalledWith(2)
  })

  it("lights a row's nodes on the map, leaving out what the map doesn't draw", async () => {
    answer = ready()
    const { container, onShowOnMap } = await render({ onMap: [1, 2, 3] })
    act(() => section(container, 'Bridges')!.querySelector<HTMLButtonElement>('button[aria-label="Show on map"]')!.click())
    expect(onShowOnMap).toHaveBeenCalledWith([3, 1, 2])
  })

  it('has no map button for a row with nothing on the map', async () => {
    answer = ready()
    const { container } = await render({ onMap: [] })
    expect(section(container, 'Bridges')!.querySelector('button[aria-label="Show on map"]')).toBeNull()
  })

  it('opens with how much of the library is one web', async () => {
    answer = ready()
    const { container } = await render()
    expect(container.textContent).toContain('4 of your 5 artists connect to each other through the people and tracks they share.')
  })

  it('says it is still working while the first recompute runs', async () => {
    answer = ready({ state: 'pending', bridges: [] })
    const { container } = await render()
    expect(container.textContent).toContain('Working out how your library connects')
    expect(section(container, 'Most played')).not.toBeNull()
  })

  it('walks the suggested path, each step named, and shows it on the map', async () => {
    answer = ready({ pathSuggestion: { from: petty, to: beatles } })
    path = {
      nodes: [petty, wilburys, harrison, beatles],
      links: [
        { kind: 'group', artistFirst: true, weight: 1 },
        { kind: 'member', artistFirst: true, weight: 1 },
        { kind: 'group', artistFirst: true, weight: 1 },
      ],
      focus: [5, 2, 3, 1],
    }
    const { container, onShowOnMap } = await render()
    const card = section(container, 'How are these connected?')!
    expect(card.querySelector('ol')!.textContent).toBe(
      'Tom Pettyis a member ofTraveling Wilburyshas as a memberGeorge Harrisonis a member ofThe Beatles',
    )
    act(() => card.querySelector<HTMLButtonElement>('button[aria-label="Show the way on the map"]')!.click())
    expect(onShowOnMap).toHaveBeenCalledWith([2, 3, 1])
  })

  describe('a path through a node the map leaves out (#482)', () => {
    // Harbour Lights was produced by Mara Quinn, who produced Velvet
    // Signals, on the label Iron Coast Records with Paper Towers. Tracks 11
    // and 12 tie each artist to the producer; albums 21 and 22 put each
    // record on the label.
    const harbour = ref(71, 'Harbour Lights')
    const quinn = ref(75, 'Mara Quinn', 'credit')
    const velvet = ref(78, 'Velvet Signals')
    const ironCoast = ref(81, 'Iron Coast Records', 'label')
    const towers = ref(84, 'Paper Towers')
    const throughBoth = {
      nodes: [harbour, quinn, velvet, ironCoast, towers],
      links: [
        { kind: 'producer', artistFirst: true, weight: 7 },
        { kind: 'producer', artistFirst: false, weight: 7 },
        { kind: 'label', artistFirst: true, weight: 2 },
        { kind: 'label', artistFirst: false, weight: 2 },
      ],
      focus: [71, 75, 78, 81, 84, 11, 12, 21, 22],
    }
    // The map's graph: no label has a place on it, and Mara Quinn has one,
    // drawn while producers are shown.
    const map = {
      nodes: [
        { id: 71, type: 'artist' },
        { id: 75, type: 'credit' },
        { id: 78, type: 'artist' },
        { id: 84, type: 'artist' },
        { id: 11, type: 'recording' },
        { id: 12, type: 'recording' },
        { id: 13, type: 'recording' },
        { id: 21, type: 'release' },
        { id: 22, type: 'release' },
      ],
      edges: [
        [11, 71],
        [11, 75],
        [12, 78],
        [12, 75],
        [12, 21],
        [13, 84],
        [13, 22],
      ] as [number, number][],
    }
    const card = (container: HTMLElement) => section(container, 'How are these connected?')!
    const show = (container: HTMLElement) =>
      act(() => card(container).querySelector<HTMLButtonElement>('button[aria-label="Show the way on the map"]')!.click())

    it('leaves the steps through a hidden producer and a label unlit, and says which', async () => {
      answer = ready({ pathSuggestion: { from: harbour, to: towers } })
      path = throughBoth
      const { container, onShowOnMap } = await render(map)
      expect(card(container).textContent).toContain(
        "The map doesn't draw Mara Quinn, producer, or Iron Coast Records, label, so those parts of the way aren't lit.",
      )
      show(container)
      // The three artists, with neither producer track nor either album:
      // each would end at a step the map doesn't draw.
      expect(onShowOnMap).toHaveBeenCalledWith([71, 78, 84])
    })

    it('leaves a step through a label unlit, and names it', async () => {
      answer = ready({ pathSuggestion: { from: velvet, to: towers } })
      path = {
        nodes: [velvet, ironCoast, towers],
        links: throughBoth.links.slice(2),
        focus: [78, 81, 84, 21, 22],
      }
      const { container, onShowOnMap } = await render({ ...map, settings: { showCreditNodes: 'true' } })
      expect(card(container).textContent).toContain("The map doesn't draw Iron Coast Records, label, so that part of the way isn't lit.")
      // The label opens its details like any other name.
      act(() => button(card(container), 'Iron Coast Records').click())
      show(container)
      expect(onShowOnMap).toHaveBeenCalledWith([78, 84])
    })

    it('lights the producer step like any other once producers are shown', async () => {
      answer = ready({ pathSuggestion: { from: harbour, to: velvet } })
      path = { nodes: [harbour, quinn, velvet], links: throughBoth.links.slice(0, 2), focus: [71, 75, 78, 11, 12] }
      const { container, onShowOnMap } = await render({ ...map, settings: { showCreditNodes: 'true' } })
      expect(card(container).textContent).not.toContain("The map doesn't draw")
      show(container)
      // Each step's track: the one joined to both of its ends.
      expect(onShowOnMap).toHaveBeenCalledWith([71, 75, 78, 11, 12])
    })

    it('names a hidden producer on the phone too, as a pill', async () => {
      answer = ready({ pathSuggestion: { from: harbour, to: velvet } })
      path = { nodes: [harbour, quinn, velvet], links: throughBoth.links.slice(0, 2), focus: [71, 75, 78, 11, 12] }
      const { container } = await render({ ...map, phone: true })
      expect(card(container).textContent).toContain("The map doesn't draw Mara Quinn, producer, so that part of the way isn't lit.")
      const names = [...card(container).querySelectorAll('p button')].filter((b) => b.textContent === 'Mara Quinn')
      expect(names).toHaveLength(1)
      expect(names[0]!.className).toContain('touch-target')
    })
  })

  it('says so when nothing joins the two', async () => {
    answer = ready({ pathSuggestion: { from: petty, to: beatles } })
    path = null
    const { container } = await render()
    expect(section(container, 'How are these connected?')!.textContent).toContain('Nothing joins Tom Petty and The Beatles yet.')
  })

  it('draws each name as a pill a finger can take on the phone', async () => {
    answer = ready()
    const { container } = await render({ phone: true })
    expect(container.querySelector('h2')).toBeNull()
    expect(button(section(container, 'Bridges')!, 'George Harrison').className).toContain('touch-target')
  })
})
