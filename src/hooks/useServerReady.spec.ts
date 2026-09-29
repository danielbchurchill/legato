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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIN_SERVER_SCHEMA_VERSION } from '../config/serverVersion'
import { readServerVersion, useServerReady, type ServerStatus } from './useServerReady'

describe('readServerVersion', () => {
  it('a current server is not out of date', () => {
    const server = readServerVersion(
      { status: 'ok', version: '0.4.0', gitSha: 'abc1234', schemaVersion: 28, libraryRoots: [] },
      28,
    )

    expect(server).toEqual({ version: '0.4.0', gitSha: 'abc1234', schemaVersion: 28, outOfDate: false })
  })

  it('a server newer than the minimum is not out of date either', () => {
    expect(readServerVersion({ status: 'ok', version: '0.5.0', gitSha: 'def5678', schemaVersion: 31 }, 28).outOfDate).toBe(
      false,
    )
  })

  it('a server reporting an older schemaVersion is out of date, and says what it runs', () => {
    const server = readServerVersion({ status: 'ok', version: '0.3.0', gitSha: 'abc1234', schemaVersion: 24 }, 28)

    expect(server).toEqual({ version: '0.3.0', gitSha: 'abc1234', schemaVersion: 24, outOfDate: true })
  })

  it('a server from before the version fields existed is out of date', () => {
    const server = readServerVersion({ status: 'ok' }, 28)

    expect(server).toEqual({ version: null, gitSha: null, schemaVersion: null, outOfDate: true })
  })

  it('treats wrongly typed or unparseable fields as missing, not as an error', () => {
    expect(readServerVersion({ status: 'ok', schemaVersion: '28' }, 28).outOfDate).toBe(true)
    expect(readServerVersion(null, 28).outOfDate).toBe(true)
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
    })
  })

  it('a pre-#193 server with no version fields is ready but out of date, not an outage', async () => {
    const result = await renderWithHealthBody({ status: 'ok' })

    expect(result.current?.ready).toBe(true)
    expect(result.current?.everConnected).toBe(true)
    expect(result.current?.server?.outOfDate).toBe(true)
  })
})
