// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphDataContext, type GraphData } from '../canvas/graphContext'
import type { GraphNode } from '../canvas/useGraphData'
import { TouchLayoutContext } from '../ui/touchLayout'
import { InsightsPanel } from './InsightsPanel'
import type { Insights, ReadyInsights } from './insightsData'

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

/** The panel, with the nodes in `onMap` on the map. */
async function render(options: { onMap?: number[]; phone?: boolean } = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const onOpenNode = vi.fn()
  const onShowOnMap = vi.fn()
  const graph: GraphData = {
    nodes: [],
    edges: [],
    loading: false,
    refetch: async () => {},
    byId: new Map((options.onMap ?? [1, 2, 3, 10]).map((id) => [id, { id } as unknown as GraphNode])),
  }
  const wrap = (child: ReactNode) =>
    createElement(
      GraphDataContext.Provider,
      { value: graph },
      createElement(TouchLayoutContext.Provider, { value: options.phone ?? false }, child),
    )
  await act(async () => root.render(wrap(createElement(InsightsPanel, { onOpenNode, onShowOnMap, phone: options.phone }))))
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
