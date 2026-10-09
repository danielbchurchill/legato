// @vitest-environment jsdom
//
// Issue #119: the queue survives an outage because the signed-in app stays
// mounted through it. useAuth re-checks sign-in on window focus, so a focus
// during the outage mustn't turn a check that couldn't reach the server
// into a screen that unmounts the app.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announceServerBack, reconnectEpoch, SERVER_BACK_EVENT } from '../connect/reconnect'
import { useAuth, type AuthState } from './useAuth'

const SIGNED_IN = {
  ownerExists: true,
  setupCodeRequired: false,
  user: { role: 'owner', provider: 'password', displayName: 'Tester', email: null },
  oauth: { google: false, github: false },
}

describe('useAuth across a server outage', () => {
  let root: Root | null = null
  const server = { up: true }

  beforeEach(() => {
    server.up = true
    localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!server.up) throw new TypeError('Failed to fetch')
        return { ok: true, status: 200, json: async () => SIGNED_IN } as Response
      }),
    )
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.unstubAllGlobals()
  })

  async function mount() {
    const result: { current: AuthState | null; refresh: (() => Promise<void>) | null } = { current: null, refresh: null }
    function Harness() {
      const auth = useAuth()
      result.current = auth.state
      result.refresh = auth.refresh
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return result
  }

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

  it('stays signed in when a re-check during the outage fails', async () => {
    const result = await mount()
    expect(result.current?.kind).toBe('signed-in')
    const before = result.current

    server.up = false
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()

    expect(result.current).toBe(before)
  })

  it('still says the sign-in check failed when there was no session to keep', async () => {
    server.up = false
    const result = await mount()

    expect(result.current?.kind).toBe('unreachable')
  })

  it('checks again once the server is back, so a failed first check clears by itself', async () => {
    server.up = false
    const result = await mount()
    expect(result.current?.kind).toBe('unreachable')

    server.up = true
    await act(async () => {
      await announceServerBack({ restarted: true })
    })
    await settle()

    expect(result.current?.kind).toBe('signed-in')
  })

  // The coordinator's review of #346: the web player reloaded its source
  // on the same event that set off the session's renewal, so the reload
  // could go out with a media ticket that had run out.
  it('has the server back only once the session check has finished', async () => {
    const result = await mount()
    expect(result.current?.kind).toBe('signed-in')

    let answer: (res: Response) => void = () => undefined
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    const epoch = reconnectEpoch()

    let announced: Promise<void> = Promise.resolve()
    await act(async () => {
      announced = announceServerBack({ restarted: true })
    })
    await settle()
    expect(back).not.toHaveBeenCalled()
    expect(reconnectEpoch()).toBe(epoch)

    await act(async () => {
      answer({ ok: true, status: 200, json: async () => SIGNED_IN } as Response)
      await announced
    })
    expect(back).toHaveBeenCalledTimes(1)
    expect(reconnectEpoch()).toBe(epoch + 1)
    window.removeEventListener(SERVER_BACK_EVENT, back)
  })
})
