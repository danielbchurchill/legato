// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagWrite, WorklistItem } from '../panels/healthData'
import { HealthPage } from './HealthPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// What the server says: 14 of 20 files matched, 7 tracks unmatched, one
// possible duplicate, one missing file and two tag writes to review.
let server: { worklist: WorklistItem[]; tagWrites: TagWrite[]; unmatched: number }
const requests: { method: string; path: string }[] = []

function tagWrite(id: number): TagWrite {
  return {
    id,
    file_id: id,
    status: 'pending_review',
    diff_json: '[]',
    requested_at: '',
    written_at: null,
    reverted_at: null,
    error_message: null,
  }
}

const roots: Root[] = []

beforeEach(() => {
  requests.length = 0
  server = {
    worklist: [
      { type: 'fuzzy_pending', fileId: 1, filePath: '/a.flac', nodeId: 2, nodeTitle: 'A', candidateNodeId: 3, candidateTitle: 'A' },
      { type: 'missing_file', fileId: 4, filePath: '/b.flac', nodeId: 5, nodeTitle: 'B', missingSince: '' },
    ],
    tagWrites: [tagWrite(1), tagWrite(2)],
    unmatched: 7,
  }
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
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname, search } = new URL(url)
      const path = pathname.replace('/api/v1', '') + search
      requests.push({ method: init?.method ?? 'GET', path })
      const body =
        path === '/hygiene/worklist'
          ? server.worklist
          : path === '/tag-writes'
            ? server.tagWrites
            : path === '/tag-manager?field=unmatched'
              ? Array.from({ length: server.unmatched }, (_, id) => ({ id, title: `T${id}`, artist: null }))
              : path === '/db-inspector'
                ? {
                    pipeline: { latestScan: null, enrichJobs: [] },
                    matchQuality: [
                      { source: 'mbid', count: 14, share: 0.7 },
                      { source: 'unmatched', count: 6, share: 0.3 },
                    ],
                  }
                : path === '/scan-jobs'
                  ? []
                  : {}
      return { ok: true, status: 200, json: async () => body } as Response
    }),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function render(onOpen = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(HealthPage, { onOpen })))
  // Every source answers.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return { container, onOpen }
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text)) ?? null

describe('Library health on the phone', () => {
  it('sums up how much of the library is matched', async () => {
    const { container } = await render()
    expect(container.textContent).toContain('70%')
    expect(container.textContent).toContain('14 of 20 files')
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('70')
  })

  it('lists what needs attention, each row opening its list', async () => {
    const { container, onOpen } = await render()
    const titles = [...container.querySelectorAll('li button')].map((b) => b.querySelector('span span')?.textContent)
    expect(titles).toEqual(['Unmatched tracks', 'Missing files', 'Possible duplicates', 'Tag writes to review'])
    act(() => button(container, 'Unmatched tracks')!.click())
    expect(onOpen).toHaveBeenLastCalledWith('gaps', 'unmatched')
    act(() => button(container, 'Possible duplicates')!.click())
    expect(onOpen).toHaveBeenLastCalledWith('duplicates', undefined)
  })

  it('draws every row at least 64px tall', async () => {
    const { container } = await render()
    for (const row of container.querySelectorAll('li button')) expect(row.className).toContain('min-h-[64px]')
  })

  it('reviews the fixes waiting, opening the tag writes', async () => {
    const { container, onOpen } = await render()
    act(() => button(container, 'Review 2 fixes')!.click())
    expect(onOpen).toHaveBeenLastCalledWith('tag-writes')
  })

  it('rescans the library', async () => {
    const { container } = await render()
    act(() => button(container, 'Rescan')!.click())
    expect(requests).toContainEqual({ method: 'POST', path: '/scan' })
  })

  it('has no review button with nothing to review, and Rescan takes the row', async () => {
    server.tagWrites = []
    const { container } = await render()
    expect(button(container, 'Review')).toBeNull()
    expect(button(container, 'Rescan')!.className).toContain('flex-1')
  })

  it('says so when nothing needs attention', async () => {
    server = { worklist: [], tagWrites: [], unmatched: 0 }
    const { container } = await render()
    expect(container.textContent).toContain('Nothing needs attention')
    expect(container.querySelectorAll('li button')).toHaveLength(0)
  })
})
