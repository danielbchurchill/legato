// @vitest-environment jsdom
//
// Issue #193: the client decides "this server is too old for me" from the
// version fields /health gained in that issue (shape in
// server/src/routes/health.ts). Three servers matter — one that's current,
// one that reports an older schemaVersion, and one from before #193 that
// reports nothing at all — and the last must read as out of date, never as
// an outage.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SERVER_SCHEMA_VERSION } from '../config/serverVersion'
import { HEALTH_TIMEOUT_MS } from '../connect/unreachable'
import { noteLatestScan, reconnectEpoch, SERVER_ANSWERED_EVENT, SERVER_BACK_EVENT } from '../connect/reconnect'
import { readServerVersion, useServerReady, type ServerStatus } from './useServerReady'

describe('readServerVersion', () => {
  it('a current server is not out of date', () => {
    const server = readServerVersion(
      { status: 'ok', version: '0.4.0', gitSha: 'abc1234', schemaVersion: 28, libraryRoots: [] },
      28,
    )

    expect(server).toEqual({ version: '0.4.0', gitSha: 'abc1234', schemaVersion: 28, outOfDate: false, update: null })
  })

  it('a server newer than the minimum is not out of date either', () => {
    expect(readServerVersion({ status: 'ok', version: '0.5.0', gitSha: 'def5678', schemaVersion: 31 }, 28).outOfDate).toBe(
      false,
    )
  })

  it('a server reporting an older schemaVersion is out of date, and says what it runs', () => {
    const server = readServerVersion({ status: 'ok', version: '0.3.0', gitSha: 'abc1234', schemaVersion: 24 }, 28)

    expect(server).toEqual({ version: '0.3.0', gitSha: 'abc1234', schemaVersion: 24, outOfDate: true, update: null })
  })

  it('a server from before the version fields existed is out of date', () => {
    const server = readServerVersion({ status: 'ok' }, 28)

    expect(server).toEqual({ version: null, gitSha: null, schemaVersion: null, outOfDate: true, update: null })
  })

  it('treats wrongly typed or unparseable fields as missing, not as an error', () => {
    expect(readServerVersion({ status: 'ok', schemaVersion: '28' }, 28).outOfDate).toBe(true)
    expect(readServerVersion(null, 28).outOfDate).toBe(true)
  })

  it('reads an available update with the command for the server\'s install channel', () => {
    const server = readServerVersion({
      version: '0.3.0',
      schemaVersion: MIN_SERVER_SCHEMA_VERSION,
      installChannel: 'docker',
      update: { check: 'on', latestVersion: '0.4.0', available: true, releaseUrl: null, checkedAt: null },
    })

    expect(server.update).toEqual({
      latestVersion: '0.4.0',
      action: { kind: 'command', command: 'docker compose pull && docker compose up -d' },
    })
  })

  it('has no update when the server says none is available, or is too old to report one', () => {
    const current = {
      schemaVersion: MIN_SERVER_SCHEMA_VERSION,
      installChannel: 'brew',
      update: { check: 'on', latestVersion: '0.3.0', available: false, releaseUrl: null, checkedAt: null },
    }

    expect(readServerVersion(current).update).toBeNull()
    expect(readServerVersion({ schemaVersion: MIN_SERVER_SCHEMA_VERSION }).update).toBeNull()
    expect(readServerVersion({ ...current, update: 'yes' }).update).toBeNull()
  })

  it('has no update for the desktop app\'s server, which the Tauri updater handles', () => {
    const server = readServerVersion({
      schemaVersion: MIN_SERVER_SCHEMA_VERSION,
      installChannel: 'desktop',
      update: { check: 'on', latestVersion: '0.4.0', available: true, releaseUrl: null, checkedAt: null },
    })

    expect(server.update).toBeNull()
  })

  it('defaults to the one minimum declared in config/serverVersion.ts', () => {
    expect(readServerVersion({ schemaVersion: MIN_SERVER_SCHEMA_VERSION }).outOfDate).toBe(false)
    expect(readServerVersion({ schemaVersion: MIN_SERVER_SCHEMA_VERSION - 1 }).outOfDate).toBe(true)
  })
})

describe('useServerReady', () => {
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.unstubAllGlobals()
  })

  async function renderWithHealthBody(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => body }) as Response),
    )
    const result: { current: ServerStatus | null } = { current: null }
    function Harness() {
      result.current = useServerReady()
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    // Let the first health check's fetch and json() promises settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return result
  }

  it('a current server is ready and not out of date', async () => {
    const result = await renderWithHealthBody({
      status: 'ok',
      version: '0.4.0',
      gitSha: 'abc1234',
      schemaVersion: MIN_SERVER_SCHEMA_VERSION,
    })

    expect(result.current?.ready).toBe(true)
    expect(result.current?.server?.outOfDate).toBe(false)
  })

  it('a server with an older schemaVersion is ready but out of date', async () => {
    const result = await renderWithHealthBody({
      status: 'ok',
      version: '0.3.0',
      gitSha: 'abc1234',
      schemaVersion: MIN_SERVER_SCHEMA_VERSION - 1,
    })

    expect(result.current?.ready).toBe(true)
    expect(result.current?.server).toEqual({
      version: '0.3.0',
      gitSha: 'abc1234',
      schemaVersion: MIN_SERVER_SCHEMA_VERSION - 1,
      outOfDate: true,
      update: null,
    })
  })

  it('a pre-#193 server with no version fields is ready but out of date, not an outage', async () => {
    const result = await renderWithHealthBody({ status: 'ok' })

    expect(result.current?.ready).toBe(true)
    expect(result.current?.everConnected).toBe(true)
    expect(result.current?.server?.outOfDate).toBe(true)
  })
})

// Issue #119: what the hook keeps about a server that stops answering, for
// the unreachable state to work out why.
describe('useServerReady when the server goes away', () => {
  let root: Root | null = null
  // What the fake server does with the next health check.
  let mode: 'ok' | 'refused' | 'silent' | 'cut-body' | 'not-json' | 'held' | 502 = 'ok'
  // A server that's stopped (SIGSTOP), or whose loop is blocked: requests
  // wait, and are answered once it runs again.
  let frozenUntil = 0
  // Which process answers (/health's bootId), and its latest scan job.
  let bootId = 'boot-1'
  const latestScan = { id: 7, status: 'done' }
  // A check held in flight ('held'), to fail by hand.
  let failHeld: () => void = () => undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-09T14:00:00Z'))
    localStorage.clear()
    mode = 'ok'
    frozenUntil = 0
    bootId = 'boot-1'
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/scan-jobs')) return Promise.resolve({ ok: true, status: 200, json: async () => [latestScan] } as Response)
        if (mode === 'held') return new Promise<Response>((_, reject) => (failHeld = () => reject(new TypeError('Failed to fetch'))))
        if (mode === 'ok') {
          const body = { status: 'ok', name: 'musicbox', bootId, schemaVersion: MIN_SERVER_SCHEMA_VERSION }
          const answer = { ok: true, status: 200, json: async () => body } as Response
          if (Date.now() >= frozenUntil) return Promise.resolve(answer)
          return new Promise<Response>((resolve, reject) => {
            const thaw = setTimeout(() => resolve(answer), frozenUntil - Date.now())
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(thaw)
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            })
          })
        }
        if (mode === 'refused') return Promise.reject(new TypeError('Failed to fetch'))
        if (mode === 502) return Promise.resolve({ ok: false, status: 502, json: async () => null } as Response)
        // Headers arrived, then the body was cut off on the way.
        if (mode === 'cut-body') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
          } as Response)
        }
        if (mode === 'not-json') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) } as Response)
        }
        // No answer at all: only the hook's own timeout ends it.
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
        )
      }),
    )
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  async function mount() {
    const result: { current: ServerStatus | null; renders: number } = { current: null, renders: 0 }
    function Harness() {
      result.current = useServerReady()
      result.renders++
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    await advance(0)
    return result
  }

  it('turns unreachable once it has turned checks away for three seconds, and keeps when the server last answered', async () => {
    const result = await mount()
    expect(result.current?.ready).toBe(true)
    expect(result.current?.name).toBe('musicbox')
    const lastAnswer = Date.now()

    mode = 'refused'
    await advance(3000) // the heartbeat that finds it gone
    await advance(2700)
    expect(result.current?.outage).toBeNull() // a restart is back by now
    await advance(300)

    expect(result.current?.ready).toBe(false)
    expect(result.current?.everConnected).toBe(true)
    expect(result.current?.outage).toEqual({
      since: Date.now(),
      failure: { kind: 'refused' },
      lastSeenAt: lastAnswer,
      networkChangedAt: null,
      deviceOnline: true,
      triedAt: null,
    })
  })

  it('turns unreachable only after fifteen seconds with no answer at all', async () => {
    const result = await mount()
    mode = 'silent'
    await advance(3000 + HEALTH_TIMEOUT_MS)
    expect(result.current?.outage).toBeNull()
    await advance(300 + HEALTH_TIMEOUT_MS)

    expect(result.current?.outage?.failure).toEqual({ kind: 'no-answer' })
  })

  // The coordinator's review of #346: a new outage object every second
  // re-rendered the whole workspace under the state.
  it("sets nothing when a check during an outage finds nothing new", async () => {
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 3000)
    const outage = result.current?.outage
    expect(outage).not.toBeNull()
    const renders = result.renders

    await advance(10_000) // ten more checks, all refused
    expect(result.renders).toBe(renders)
    expect(result.current?.outage).toBe(outage)
  })

  // A LAN host that's asleep: unanswered at first, then turned away at once
  // by this computer's own network stack.
  it('keeps how the outage failed steady when the checks after it fail another way', async () => {
    const result = await mount()
    mode = 'silent'
    await advance(3000 + 2 * HEALTH_TIMEOUT_MS + 300)
    const outage = result.current?.outage
    expect(outage?.failure).toEqual({ kind: 'no-answer' })

    mode = 'refused'
    for (let i = 0; i < 5; i++) {
      await advance(1000)
      expect(result.current?.outage?.failure).toEqual({ kind: 'no-answer' })
    }
  })

  // The coordinator's review of #346: a slow answer isn't an outage.
  it('takes a server that answers after nine seconds as up', async () => {
    const result = await mount()
    frozenUntil = Date.now() + 3000 + 9000
    await advance(3000 + 9000)

    expect(result.current?.ready).toBe(true)
    expect(result.current?.outage).toBeNull()
  })

  it('takes a server that stops answering for twelve seconds, longer than one check waits, as up', async () => {
    const result = await mount()
    frozenUntil = Date.now() + 3000 + 12_000
    for (let t = 0; t < 3000 + 12_000 + 1000; t += 500) {
      await advance(500)
      expect(result.current?.outage).toBeNull()
    }
    expect(result.current?.ready).toBe(true)
  })

  it("records an answer that isn't Legato's health as a bad status", async () => {
    const result = await mount()
    mode = 502
    await advance(3000 + 3000)

    expect(result.current?.outage?.failure).toEqual({ kind: 'bad-status', status: 502 })
  })

  // The coordinator's review of #346: an empty answer read as "out of
  // date", and the app remounted around that and lost the queue.
  it('fails a check whose body was cut off, rather than reading the server as out of date', async () => {
    const result = await mount()
    const server = result.current?.server
    expect(server?.outOfDate).toBe(false)

    mode = 'cut-body'
    await advance(3000)
    expect(result.current?.server).toBe(server)
    expect(result.current?.ready).toBe(true)
    await advance(20_000)

    expect(result.current?.server).toBe(server)
    expect(result.current?.outage).not.toBeNull()
  })

  it("takes a 200 that isn't JSON for something other than Legato answering", async () => {
    const result = await mount()
    mode = 'not-json'
    await advance(3000 + 20_000)

    expect(result.current?.server?.outOfDate).toBe(false)
    expect(result.current?.outage?.failure).toEqual({ kind: 'bad-status', status: 200 })
  })

  it('clears the outage when the server answers again, and says so once', async () => {
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 3000)
    expect(result.current?.outage).not.toBeNull()

    mode = 'ok'
    await advance(1000)

    expect(result.current?.ready).toBe(true)
    expect(result.current?.outage).toBeNull()
    expect(back).toHaveBeenCalledTimes(1)
    window.removeEventListener(SERVER_BACK_EVENT, back)
  })

  // The coordinator's review of #346: one missed heartbeat said the server
  // was back, and everything listening reloaded for it.
  it("doesn't say the server's back after a check or two that failed short of an outage", async () => {
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 1000)
    mode = 'ok'
    await advance(1000)

    expect(result.current?.ready).toBe(true)
    expect(back).not.toHaveBeenCalled()
    window.removeEventListener(SERVER_BACK_EVENT, back)
  })

  // The coordinator's second review of #346: a restart back within the
  // three seconds is no outage, but it's a restart, and the web player has to
  // hear that the server answers again.
  it('says the server answers again after a failed check, outage or not', async () => {
    const answered = vi.fn()
    window.addEventListener(SERVER_ANSWERED_EVENT, answered)
    await mount()
    mode = 'refused'
    await advance(3000)
    expect(answered).not.toHaveBeenCalled()
    mode = 'ok'
    await advance(300)

    expect(answered).toHaveBeenCalledTimes(1)
    await advance(3000)
    expect(answered).toHaveBeenCalledTimes(1)
    window.removeEventListener(SERVER_ANSWERED_EVENT, answered)
  })

  // ...and finding 9: a restart is the one thing that needs everything
  // read again, however quickly it came back.
  it('reads everything again after a restart between two heartbeats, which no check saw fail', async () => {
    const back = vi.fn()
    const answered = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    window.addEventListener(SERVER_ANSWERED_EVENT, answered)
    const result = await mount()
    const epoch = reconnectEpoch()

    bootId = 'boot-2'
    await advance(3000)

    expect(result.current?.outage).toBeNull()
    expect(answered).toHaveBeenCalledTimes(1)
    expect(back).toHaveBeenCalledTimes(1)
    expect(reconnectEpoch()).toBe(epoch + 1)
    window.removeEventListener(SERVER_BACK_EVENT, back)
    window.removeEventListener(SERVER_ANSWERED_EVENT, answered)
  })

  it('reads everything again after an outage the server restarted in', async () => {
    noteLatestScan(latestScan)
    await mount()
    const epoch = reconnectEpoch()
    mode = 'refused'
    await advance(3000 + 3000)
    bootId = 'boot-2'
    mode = 'ok'
    await advance(1000)

    expect(reconnectEpoch()).toBe(epoch + 1)
  })

  it("only replaces the sockets after an outage the server didn't restart in and no scan moved on", async () => {
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    noteLatestScan(latestScan)
    await mount()
    const epoch = reconnectEpoch()
    mode = 'refused'
    await advance(3000 + 3000)
    mode = 'ok'
    await advance(1000)

    expect(back).toHaveBeenCalledTimes(1)
    expect(reconnectEpoch()).toBe(epoch)
    window.removeEventListener(SERVER_BACK_EVENT, back)
  })

  // Finding 6: a check in flight when the page froze (a phone's tab in the
  // background, a laptop asleep) fails once it runs again, ten minutes on.
  it("doesn't call it an outage when the one check that failed spanned a ten-minute freeze", async () => {
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    const result = await mount()
    mode = 'held'
    await advance(3000) // the heartbeat goes out, and the page freezes
    vi.setSystemTime(Date.now() + 10 * 60_000)
    mode = 'ok'
    await act(async () => failHeld())
    await advance(0)

    expect(result.current?.outage).toBeNull()
    expect(result.current?.ready).toBe(true)
    // It looks again soon, and finds the server there.
    await advance(300)
    expect(result.current?.outage).toBeNull()
    expect(back).not.toHaveBeenCalled()
    window.removeEventListener(SERVER_BACK_EVENT, back)
  })

  it('still names a server that is really gone after the freeze, once the grace has run from the wake', async () => {
    const result = await mount()
    mode = 'held'
    await advance(3000)
    vi.setSystemTime(Date.now() + 10 * 60_000)
    mode = 'refused'
    await act(async () => failHeld())
    await advance(300) // the check after the wake fails, and starts the clock
    await advance(2400)
    expect(result.current?.outage).toBeNull()
    await advance(600)

    expect(result.current?.outage?.failure).toEqual({ kind: 'refused' })
  })

  it("doesn't count failures from before a freeze towards an outage", async () => {
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 1500) // failing for 1.5 s
    // Frozen between two polls: the next comes ten minutes late.
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await advance(300)
    expect(result.current?.outage).toBeNull()
    await advance(2700)
    expect(result.current?.outage).toBeNull()
    await advance(600)
    expect(result.current?.outage).not.toBeNull()
  })

  it('checks straight away on "Try again", and records that it ran', async () => {
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 3000)
    const calls = vi.mocked(fetch).mock.calls.length

    // A host that doesn't answer keeps the try running until the timeout.
    mode = 'silent'
    await act(async () => result.current?.retry())
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls + 1)
    expect(result.current?.retrying).toBe(true)
    await advance(HEALTH_TIMEOUT_MS)

    expect(result.current?.retrying).toBe(false)
    expect(result.current?.outage?.failure).toEqual({ kind: 'no-answer' })
    expect(result.current?.outage?.triedAt).toBe(Date.now())
  })

  it('notes a device that went offline, and checks again when it does', async () => {
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 3000)

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const calls = vi.mocked(fetch).mock.calls.length
    await act(async () => {
      window.dispatchEvent(new Event('offline'))
    })
    await advance(0)

    expect(vi.mocked(fetch).mock.calls.length).toBe(calls + 1)
    expect(result.current?.outage?.deviceOnline).toBe(false)
    // Going offline isn't a change of network; coming back is.
    expect(result.current?.outage?.networkChangedAt).toBeNull()

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await advance(0)
    expect(result.current?.outage?.deviceOnline).toBe(true)
    expect(result.current?.outage?.networkChangedAt).toBe(Date.now())
  })

  // The coordinator's review of #346: Chromium fires `change` for its rtt
  // and downlink estimates all the time.
  describe('with Chromium\'s navigator.connection', () => {
    const connection = Object.assign(new EventTarget(), { type: 'wifi', rtt: 50 })

    beforeEach(() => {
      connection.type = 'wifi'
      Object.defineProperty(navigator, 'connection', { value: connection, configurable: true })
    })

    afterEach(() => {
      Reflect.deleteProperty(navigator, 'connection')
    })

    it("takes a new estimate for no change, and doesn't check on it", async () => {
      const result = await mount()
      mode = 'silent'
      await advance(3000 + 2 * HEALTH_TIMEOUT_MS + 300)
      expect(result.current?.outage?.failure).toEqual({ kind: 'no-answer' })
      const calls = vi.mocked(fetch).mock.calls.length

      await act(async () => {
        connection.rtt = 900
        connection.dispatchEvent(new Event('change'))
      })
      await advance(0)

      expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
      expect(result.current?.outage?.networkChangedAt).toBeNull()
    })

    it('takes a different kind of network for a change, and checks at once', async () => {
      const result = await mount()
      mode = 'refused'
      await advance(3000 + 3000)
      const calls = vi.mocked(fetch).mock.calls.length

      await act(async () => {
        connection.type = 'cellular'
        connection.dispatchEvent(new Event('change'))
      })
      await advance(0)

      expect(vi.mocked(fetch).mock.calls.length).toBe(calls + 1)
      expect(result.current?.outage?.networkChangedAt).toBe(Date.now())
    })
  })

  it('remembers the last answer, so a launch that finds the server gone can say since when', async () => {
    await mount()
    act(() => root?.unmount())
    root = null
    const seenAt = Date.parse('2026-10-09T14:00:00Z')

    vi.setSystemTime(Date.parse('2026-10-10T09:00:00Z'))
    mode = 'refused'
    const result = await mount()
    await advance(3000)

    expect(result.current?.everConnected).toBe(false)
    expect(result.current?.name).toBe('musicbox')
    expect(result.current?.outage?.lastSeenAt).toBe(seenAt)
  })

  // A cold launch of the desktop app: its own server takes a moment to
  // listen, and the window opens the moment it does.
  it('keeps checking every 300 ms for the first minute before the first answer, then eases off', async () => {
    mode = 'refused'
    await mount()
    const calls = () => vi.mocked(fetch).mock.calls.length

    await advance(30_000)
    let before = calls()
    await advance(3000)
    expect(calls() - before).toBeGreaterThanOrEqual(9)

    await advance(61_000 - 33_000)
    before = calls()
    await advance(3000)
    expect(calls() - before).toBe(3)

    await advance(5 * 60_000 - 64_000)
    before = calls()
    await advance(10_000)
    expect(calls() - before).toBe(2)
  })

  it('opens as soon as the server answers, however many checks it turned away first', async () => {
    mode = 'refused'
    const result = await mount()
    await advance(20_000)
    expect(result.current?.everConnected).toBe(false)

    mode = 'ok'
    await advance(300)
    expect(result.current?.everConnected).toBe(true)
  })
})
