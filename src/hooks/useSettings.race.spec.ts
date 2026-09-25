// @vitest-environment jsdom
//
// Regression coverage for issue #81's remaining case: every settings-backed
// toggle in the app (TransportDock's repeat cycle, ViewSwitch, the
// MusicMapSettings/LegatoSettings panels, map presets) funnels through this
// one updateSettings function. It used to apply the server's response only
// after the full PUT round trip resolved, so a caller that reads `settings`
// to compute its next value (e.g. onCycleRepeat's
// NEXT_REPEAT_MODE[repeatMode]) would see the same stale value for every
// click fired before that round trip finished — on a real network hop this
// is long enough that a burst of impatient clicks reads as "the button
// needed several clicks to do one thing."
//
// fetch is mocked with a real (if small) delay specifically so two
// overlapping updateSettings calls have every opportunity to read each
// other's stale state if nothing applies the update immediately.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettings, type Settings } from './useSettings'

const FETCH_DELAY_MS = 5

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let serverSettings: Settings = {}

beforeEach(() => {
  serverSettings = { repeatMode: 'off' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const partial = JSON.parse((init.body as string) ?? '{}') as Settings
        await delay(FETCH_DELAY_MS)
        serverSettings = { ...serverSettings, ...partial }
        return { json: async () => serverSettings } as Response
      }
      return { json: async () => serverSettings } as Response
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderSettingsHook() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  const result: { current: ReturnType<typeof useSettings> | null } = { current: null }

  function Harness() {
    result.current = useSettings()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })

  return { result, unmount: () => act(() => root.unmount()) }
}

const NEXT_REPEAT_MODE: Record<string, string> = { off: 'all', all: 'one', one: 'off' }

describe('useSettings optimistic updates', () => {
  it('applies a partial immediately, without waiting on the PUT round trip', async () => {
    const { result, unmount } = renderSettingsHook()
    await act(async () => {
      await delay(0)
    })

    act(() => {
      void result.current!.updateSettings({ repeatMode: 'all' })
    })

    // Synchronous — no awaiting the mocked network delay at all.
    expect(result.current!.settings.repeatMode).toBe('all')

    unmount()
  })

  it('cycles through two rapid clicks correctly instead of computing both from the same stale value', async () => {
    const { result, unmount } = renderSettingsHook()
    await act(async () => {
      await delay(0)
    })

    // Two rapid clicks on a cycle-style button — exactly what
    // TransportDock's repeat control produces: the second click's handler
    // reads `settings.repeatMode` again before the first click's PUT has
    // resolved.
    act(() => {
      const first = result.current!.settings.repeatMode ?? 'off'
      void result.current!.updateSettings({ repeatMode: NEXT_REPEAT_MODE[first] })
    })
    act(() => {
      const second = result.current!.settings.repeatMode ?? 'off'
      void result.current!.updateSettings({ repeatMode: NEXT_REPEAT_MODE[second] })
    })

    // Two full steps landed (off -> all -> one) — not the same target
    // ('all') applied twice because both reads saw 'off'.
    expect(result.current!.settings.repeatMode).toBe('one')

    await act(async () => {
      await delay(FETCH_DELAY_MS * 3)
    })
    expect(result.current!.settings.repeatMode).toBe('one')

    unmount()
  })

  it('rolls back to the previous value when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          await delay(FETCH_DELAY_MS)
          throw new Error('network error')
        }
        return { json: async () => serverSettings } as Response
      }),
    )

    const { result, unmount } = renderSettingsHook()
    await act(async () => {
      await delay(0)
    })

    await act(async () => {
      await result.current!.updateSettings({ repeatMode: 'all' })
    })

    expect(result.current!.settings.repeatMode).toBeUndefined()

    unmount()
  })
})
