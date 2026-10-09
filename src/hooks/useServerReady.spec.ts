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
import { HEALTH_TIMEOUT_MS, SERVER_BACK_EVENT } from '../connect/unreachable'
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
  let mode: 'ok' | 'refused' | 'silent' | 502 = 'ok'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-09T14:00:00Z'))
    localStorage.clear()
    mode = 'ok'
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (mode === 'ok') {
          const body = { status: 'ok', name: 'musicbox', schemaVersion: MIN_SERVER_SCHEMA_VERSION }
          return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
        }
        if (mode === 'refused') return Promise.reject(new TypeError('Failed to fetch'))
        if (mode === 502) return Promise.resolve({ ok: false, status: 502, json: async () => null } as Response)
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
    await advance(0)
    return result
  }

  it('turns unreachable after three refused checks, and keeps when the server last answered', async () => {
    const result = await mount()
    expect(result.current?.ready).toBe(true)
    expect(result.current?.name).toBe('musicbox')
    const lastAnswer = Date.now()

    mode = 'refused'
    await advance(3000) // the heartbeat that finds it gone
    await advance(300)
    expect(result.current?.outage).toBeNull() // two misses are still noise
    await advance(300)

    expect(result.current?.ready).toBe(false)
    expect(result.current?.everConnected).toBe(true)
    expect(result.current?.outage).toEqual({
      failure: { kind: 'refused' },
      lastSeenAt: lastAnswer,
      networkChangedAt: null,
      deviceOnline: true,
      triedAt: null,
    })
  })

  it('turns unreachable after two checks with no answer at all', async () => {
    const result = await mount()
    mode = 'silent'
    await advance(3000 + HEALTH_TIMEOUT_MS)
    expect(result.current?.outage).toBeNull()
    await advance(300 + HEALTH_TIMEOUT_MS)

    expect(result.current?.outage?.failure).toEqual({ kind: 'no-answer' })
  })

  it("records an answer that isn't Legato's health as a bad status", async () => {
    const result = await mount()
    mode = 502
    await advance(3000 + 300 + 300)

    expect(result.current?.outage?.failure).toEqual({ kind: 'bad-status', status: 502 })
  })

  it('clears the outage when the server answers again, and says so once', async () => {
    const back = vi.fn()
    window.addEventListener(SERVER_BACK_EVENT, back)
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 300 + 300)
    expect(result.current?.outage).not.toBeNull()

    mode = 'ok'
    await advance(1000)

    expect(result.current?.ready).toBe(true)
    expect(result.current?.outage).toBeNull()
    expect(back).toHaveBeenCalledTimes(1)
    window.removeEventListener(SERVER_BACK_EVENT, back)
  })

  it('checks straight away on "Try again", and records that it ran', async () => {
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 300 + 300)
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

  it('notes a network that dropped, and checks again when it does', async () => {
    const result = await mount()
    mode = 'refused'
    await advance(3000 + 300 + 300)

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const calls = vi.mocked(fetch).mock.calls.length
    await act(async () => {
      window.dispatchEvent(new Event('offline'))
    })
    await advance(0)

    expect(vi.mocked(fetch).mock.calls.length).toBe(calls + 1)
    expect(result.current?.outage?.deviceOnline).toBe(false)
    expect(result.current?.outage?.networkChangedAt).toBe(Date.now())
  })

  it('remembers the last answer, so a launch that finds the server gone can say since when', async () => {
    await mount()
    act(() => root?.unmount())
    root = null
    const seenAt = Date.parse('2026-10-09T14:00:00Z')

    vi.setSystemTime(Date.parse('2026-10-10T09:00:00Z'))
    mode = 'refused'
    const result = await mount()
    await advance(300 + 300)

    expect(result.current?.everConnected).toBe(false)
    expect(result.current?.name).toBe('musicbox')
    expect(result.current?.outage?.lastSeenAt).toBe(seenAt)
  })
})
