// @vitest-environment jsdom
//
// #467: a change saved on one device shows on the others while they're
// open. The server broadcasts `settings:changed` with what a write changed
// and which page wrote it (server/src/routes/settings.ts); these check the
// receiving side.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ws = vi.hoisted(() => ({ names: [] as string[][], handler: null as ((payload?: unknown) => void) | null }))
vi.mock('./useWs', () => ({
  useWsEvent: (names: string[], onEvent: (payload?: unknown) => void) => {
    ws.names.push(names)
    ws.handler = onEvent
  },
}))

import { SETTINGS_CHANGED_EVENT, SETTINGS_CLIENT_ID, useSettings, type Settings } from './useSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Pending = { url: string; body: Settings | null; resolve: (settings: Settings) => void }

let pending: Pending[] = []
const roots: Root[] = []

beforeEach(() => {
  ws.names = []
  ws.handler = null
  pending = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({
            url,
            body: init?.body ? (JSON.parse(init.body as string) as Settings) : null,
            resolve: (settings) => resolve({ ok: true, json: async () => settings } as Response),
          })
        }),
    ),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
})

const isMap = (key: string) => key.startsWith('force') || key === 'showTracks'

function mount(live?: (key: string) => boolean) {
  const result: { current: ReturnType<typeof useSettings> | null } = { current: null }
  function Harness() {
    result.current = useSettings(live ? { live } : {})
    return null
  }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  act(() => root.render(createElement(Harness)))
  return result
}

async function answer(index: number, settings: Settings) {
  await act(async () => {
    pending[index].resolve(settings)
    await new Promise((r) => setTimeout(r, 0))
  })
}

const remote = (changed: Settings, from = 'another-device') => act(() => ws.handler!({ changed, from }))

describe('useSettings, live', () => {
  it("applies another device's change to a map setting as it arrives", async () => {
    const result = mount(isMap)
    await answer(0, { forceCenterStrength: '0.03', viewMode: 'map' })
    expect(ws.names.at(-1)).toEqual([SETTINGS_CHANGED_EVENT])
    remote({ forceCenterStrength: '0.12' })
    expect(result.current!.settings).toEqual({ forceCenterStrength: '0.12', viewMode: 'map' })
  })

  it('leaves settings that only change here on a reload', async () => {
    const result = mount(isMap)
    await answer(0, { viewMode: 'map' })
    remote({ viewMode: 'library', showTracks: 'false' })
    expect(result.current!.settings).toEqual({ viewMode: 'map', showTracks: 'false' })
  })

  it('skips the echo of its own writes, and says whose they are', async () => {
    const result = mount(isMap)
    await answer(0, {})
    act(() => void result.current!.updateSettings({ forceRepelStrength: '60' }))
    expect(pending[1].url).toContain(`?from=${SETTINGS_CLIENT_ID}`)
    // A drag on: this device is at 61 before the echo of 60 comes back.
    act(() => void result.current!.updateSettings({ forceRepelStrength: '61' }))
    remote({ forceRepelStrength: '60' }, SETTINGS_CLIENT_ID)
    expect(result.current!.settings.forceRepelStrength).toBe('61')
  })

  it("keeps another device's change that crossed a write of its own in flight", async () => {
    const result = mount(isMap)
    await answer(0, {})
    act(() => void result.current!.updateSettings({ showTracks: 'false' }))
    // The server answered this write before the other device's landed.
    remote({ forceCenterStrength: '0.10' })
    await answer(1, { showTracks: 'false' })
    expect(result.current!.settings).toEqual({ showTracks: 'false', forceCenterStrength: '0.10' })
  })

  it("keeps its own value for a setting both devices wrote at once, as the server's answer has it", async () => {
    const result = mount(isMap)
    await answer(0, {})
    act(() => void result.current!.updateSettings({ forceCenterStrength: '0.05' }))
    remote({ forceCenterStrength: '0.10' })
    await answer(1, { forceCenterStrength: '0.05' })
    expect(result.current!.settings.forceCenterStrength).toBe('0.05')
  })

  it('keeps a change that arrives while the first load is still out', async () => {
    const result = mount(isMap)
    remote({ forceLinkStrength: '0.40' })
    await answer(0, { forceLinkStrength: '0.15', viewMode: 'map' })
    expect(result.current!.settings).toEqual({ forceLinkStrength: '0.40', viewMode: 'map' })
  })

  it('rolls a failed write back to what the server and the other devices last said', async () => {
    const result = mount(isMap)
    await answer(0, { forceCenterStrength: '0.03' })
    remote({ forceLinkStrength: '0.40' })
    vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, status: 500 }) as Response)
    await act(async () => {
      await result.current!.updateSettings({ forceCenterStrength: '0.20' })
    })
    expect(result.current!.settings).toEqual({ forceCenterStrength: '0.03', forceLinkStrength: '0.40' })
  })

  it('ignores a change that carries no settings', async () => {
    const result = mount(isMap)
    await answer(0, { showTracks: 'true' })
    act(() => ws.handler!(undefined))
    act(() => ws.handler!({ changed: 'nonsense' }))
    act(() => ws.handler!({ changed: { showTracks: 7 } }))
    expect(result.current!.settings).toEqual({ showTracks: 'true' })
  })

  it('listens for nothing without settings to share', () => {
    mount()
    expect(ws.names.at(-1)).toEqual([])
  })
})
