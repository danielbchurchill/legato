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
//
// Follow-up coverage: the optimistic-apply fix above introduced its own
// race — nothing stopped an OLDER call's response from overwriting state
// after a NEWER call had already applied its own optimistic value (or, on
// failure, rolling back to a stale `previous` instead of the last value the
// server actually confirmed). The three tests below at the bottom of this
// file target that follow-up specifically.
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
        return { ok: true, json: async () => serverSettings } as Response
      }
      return { ok: true, json: async () => serverSettings } as Response
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

// The initial GET in useSettings' mount effect resolves over a real
// microtask chain with no artificial delay, so whether it's landed by a
// given point is otherwise a race — usually fast enough to look done, but
// not guaranteed. Any test that cares what the CONFIRMED baseline is (as
// opposed to tests that already tolerate an unresolved mount, like the
// `?? 'off'` reads below) needs to wait for it explicitly rather than
// guessing with a fixed delay.
async function waitForLoaded(result: { current: ReturnType<typeof useSettings> | null }) {
  for (let i = 0; i < 20 && !result.current?.loaded; i++) {
    await act(async () => {
      await delay(1)
    })
  }
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

  it('rolls back to the last confirmed value when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          await delay(FETCH_DELAY_MS)
          throw new Error('network error')
        }
        return { ok: true, json: async () => serverSettings } as Response
      }),
    )

    const { result, unmount } = renderSettingsHook()
    // Deterministic on purpose: the mount GET (serverSettings' initial
    // { repeatMode: 'off' }) is the confirmed baseline this test means to
    // roll back to, so it has to have actually landed before the failing
    // update fires, not just be given a fixed delay and hoped for.
    await waitForLoaded(result)
    expect(result.current!.settings.repeatMode).toBe('off')

    await act(async () => {
      await result.current!.updateSettings({ repeatMode: 'all' })
    })

    expect(result.current!.settings.repeatMode).toBe('off')

    unmount()
  })

  it('never regresses to an earlier click\'s value when responses land out of order', async () => {
    // Each PUT's snapshot is computed at CALL time (mirroring a real server
    // that applies writes in the order they arrive), but the promises are
    // resolved manually so the test controls the order RESPONSES land in,
    // independent of send order — exactly what a reordering network can do.
    const resolvers: Array<() => void> = []
    let cumulative: Settings = { repeatMode: 'off' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const partial = JSON.parse((init.body as string) ?? '{}') as Settings
          cumulative = { ...cumulative, ...partial }
          const snapshot = cumulative
          return new Promise<Response>((resolve) => {
            resolvers.push(() => resolve({ ok: true, json: async () => snapshot } as Response))
          })
        }
        return { ok: true, json: async () => serverSettings } as Response
      }),
    )

    const { result, unmount } = renderSettingsHook()
    await act(async () => {
      await delay(0)
    })

    act(() => {
      void result.current!.updateSettings({ repeatMode: 'all' })
    })
    act(() => {
      void result.current!.updateSettings({ repeatMode: 'one' })
    })
    act(() => {
      void result.current!.updateSettings({ repeatMode: 'off' })
    })

    expect(resolvers).toHaveLength(3)

    // Network reorders the responses: the third (most recent) click's
    // response arrives first, then the second's, then the first's — the
    // ordering that would make "last response to land wins" show an
    // earlier click's value after the most recent one already landed.
    await act(async () => {
      resolvers[2]()
      await delay(0)
    })
    expect(result.current!.settings.repeatMode).toBe('off')

    await act(async () => {
      resolvers[1]()
      await delay(0)
    })
    expect(result.current!.settings.repeatMode).toBe('off')

    await act(async () => {
      resolvers[0]()
      await delay(0)
    })
    expect(result.current!.settings.repeatMode).toBe('off')

    unmount()
  })

  it('rolls back a failed newest request to the last server-confirmed state, not an unconfirmed optimistic one', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          call += 1
          const partial = JSON.parse((init.body as string) ?? '{}') as Settings
          if (call === 1) {
            await delay(FETCH_DELAY_MS)
            serverSettings = { ...serverSettings, ...partial }
            return { ok: true, json: async () => serverSettings } as Response
          }
          if (call === 2) {
            // Second call is left hanging — still unconfirmed when the
            // third call below fails.
            return new Promise<Response>(() => {})
          }
          await delay(FETCH_DELAY_MS)
          throw new Error('network error')
        }
        return { ok: true, json: async () => serverSettings } as Response
      }),
    )

    const { result, unmount } = renderSettingsHook()
    await act(async () => {
      await delay(0)
    })

    await act(async () => {
      await result.current!.updateSettings({ repeatMode: 'all' })
    })
    expect(result.current!.settings.repeatMode).toBe('all')

    act(() => {
      void result.current!.updateSettings({ repeatMode: 'one' })
    })
    expect(result.current!.settings.repeatMode).toBe('one')

    await act(async () => {
      await result.current!.updateSettings({ repeatMode: 'off' })
    })

    // Rolled back to 'all' — the last value the server actually
    // confirmed — not 'one', which was only ever a local optimistic guess
    // for a request that's still hanging.
    expect(result.current!.settings.repeatMode).toBe('all')

    unmount()
  })

  it('treats a non-ok response as a failure instead of storing its body as settings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          await delay(FETCH_DELAY_MS)
          return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as unknown as Response
        }
        return { ok: true, json: async () => serverSettings } as Response
      }),
    )

    const { result, unmount } = renderSettingsHook()
    await waitForLoaded(result)
    expect(result.current!.settings.repeatMode).toBe('off')

    await act(async () => {
      await result.current!.updateSettings({ repeatMode: 'all' })
    })

    // Rolled back to the confirmed value, never left holding the error
    // body as if it were Settings.
    expect(result.current!.settings.repeatMode).toBe('off')
    expect(result.current!.settings).not.toHaveProperty('error')

    unmount()
  })
})
