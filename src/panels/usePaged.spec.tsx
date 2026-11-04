// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gapQuery, usePaged, DEFAULT_GAP_VIEW } from './healthData'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* #469: the gaps list never loads every row at once. usePaged asks for a
 * page, then a page more, and after a change elsewhere asks again for only
 * the pages already shown. */

const requests: string[] = []
let total = 120
const roots: Root[] = []

beforeEach(() => {
  requests.length = 0
  total = 120
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url)
      requests.push(u.pathname.replace('/api/v1', '') + u.search)
      const offset = Number(u.searchParams.get('offset'))
      const limit = Number(u.searchParams.get('limit'))
      const items = Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => `${u.searchParams.get('q')}:${offset + i}`,
      )
      return { ok: true, status: 200, json: async () => ({ total, items }) } as Response
    }),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
})

type Paged = ReturnType<typeof usePaged<string>>

async function mount(path: string, revision = 0) {
  // What the hook last returned, kept on an object the probe writes into.
  const seen: { latest: Paged | null } = { latest: null }
  function Probe({ path, revision }: { path: string; revision: number }) {
    seen.latest = usePaged<string>(path, revision, 50)
    return null
  }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  const render = async (p: string, r: number) => {
    await act(async () => root.render(createElement(Probe, { path: p, revision: r })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  }
  await render(path, revision)
  return { get: () => seen.latest!, render }
}

describe('usePaged', () => {
  it('asks for the first page, then the next on more()', async () => {
    const list = await mount('/list?q=a', 0)
    expect(requests).toEqual(['/list?q=a&offset=0&limit=50'])
    expect(list.get().items).toHaveLength(50)
    expect(list.get().total).toBe(120)
    await act(async () => list.get().more())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(requests.at(-1)).toBe('/list?q=a&offset=50&limit=50')
    expect(list.get().items).toHaveLength(100)
  })

  it('asks again for just the pages shown when something changes', async () => {
    const list = await mount('/list?q=a', 0)
    await act(async () => list.get().more())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    requests.length = 0
    total = 90
    await list.render('/list?q=a', 1)
    expect(requests).toEqual(['/list?q=a&offset=0&limit=50', '/list?q=a&offset=50&limit=50'])
    expect(list.get().items).toHaveLength(90)
    expect(list.get().total).toBe(90)
  })

  it('starts again from the first page for a new query, showing nothing of the old one meanwhile', async () => {
    const list = await mount('/list?q=a', 0)
    await act(async () => list.get().more())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    requests.length = 0
    await list.render('/list?q=b', 0)
    expect(requests).toEqual(['/list?q=b&offset=0&limit=50'])
    expect(list.get().items?.[0]).toBe('b:0')
    expect(list.get().items).toHaveLength(50)
  })

  it('does nothing past the last page', async () => {
    total = 30
    const list = await mount('/list?q=a', 0)
    await act(async () => list.get().more())
    expect(requests).toHaveLength(1)
  })
})

describe('gapQuery', () => {
  it('says the kinds, the order and an artist when there is one', () => {
    expect(gapQuery(DEFAULT_GAP_VIEW)).toBe('kinds=unmatched%2Clabel%2Crelease_date%2Crelease_type&sort=gaps&dir=desc')
    expect(gapQuery({ ...DEFAULT_GAP_VIEW, kinds: ['bpm'], sort: 'artist', dir: 'asc', artist: '  Zappa ' })).toBe(
      'kinds=bpm&sort=artist&dir=asc&artist=Zappa',
    )
  })
})
