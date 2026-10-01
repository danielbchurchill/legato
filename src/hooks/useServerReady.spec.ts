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
