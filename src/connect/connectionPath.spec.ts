// Issue #118: the connection-path store the rail's indicator, the quality
// ladder and the unreachable state read, and this device's "never use the
// relay".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

const ID = 'k3Jt9QxZ'
let storage: Storage

// Fresh modules per test: serverHost.ts reads this device's storage once,
// as it loads, and tells the store the path then.
async function load() {
  vi.resetModules()
  const store = await import('./connectionPath')
  const host = await import('../config/serverHost')
  return { ...store, SERVER_ORIGIN: host.SERVER_ORIGIN }
}

beforeEach(() => {
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connection path', () => {
  it('is the path of the server this page loaded with', async () => {
    // No server picked, outside the desktop app: the env default, here.
    expect((await load()).getConnectionPath()).toBe('this-computer')

    storage.setItem('legato:server-choice', 'http://192.168.1.20:8899')
    expect((await load()).getConnectionPath()).toBe('home')

    storage.setItem('legato:server-choice', 'https://music.example.com')
    expect((await load()).getConnectionPath()).toBe('custom')

    storage.setItem('legato:server-choice', `https://auth.legato.fm/relay/${ID}`)
    const relayed = await load()
    expect(relayed.SERVER_ORIGIN).toBe(`https://auth.legato.fm/relay/${ID}`)
    expect(relayed.getConnectionPath()).toBe('relay')
  })

  it('tells subscribers when it changes, and only then', async () => {
    const { getConnectionPath, setConnectionPath, subscribeConnectionPath } = await load()
    const heard = vi.fn()
    const stop = subscribeConnectionPath(heard)
    setConnectionPath('relay')
    expect(getConnectionPath()).toBe('relay')
    setConnectionPath('relay')
    expect(heard).toHaveBeenCalledOnce()
    stop()
    setConnectionPath('home')
    expect(heard).toHaveBeenCalledOnce()
  })
})

describe('never use the relay', () => {
  it('is off until this device turns it on, and stays per device', async () => {
    const { neverUseRelay, setNeverUseRelay, NEVER_RELAY_KEY } = await load()
    expect(NEVER_RELAY_KEY).toBe('legato:never-relay')
    expect(neverUseRelay()).toBe(false)
    setNeverUseRelay(true, { reload: () => undefined })
    expect(storage.getItem(NEVER_RELAY_KEY)).toBe('true')
    expect(neverUseRelay()).toBe(true)
    setNeverUseRelay(false)
    expect(neverUseRelay()).toBe(false)
    expect(storage.length).toBe(0)
  })

  it('keeps a route through the relay from resolving, for the home address or the default', async () => {
    storage.setItem('legato:server-choice', `https://auth.legato.fm/relay/${ID}`)
    storage.setItem('legato:never-relay', 'true')
    storage.setItem(
      'legato:known-servers',
      JSON.stringify({ [ID]: { name: 'musicbox', lanOrigin: 'http://192.168.1.20:8899', lastReachedAt: '' } }),
    )
    const home = await load()
    expect(home.SERVER_ORIGIN).toBe('http://192.168.1.20:8899')
    expect(home.getConnectionPath()).toBe('home')

    storage.removeItem('legato:known-servers')
    const fallback = await load()
    expect(fallback.SERVER_ORIGIN).toBe('http://127.0.0.1:8899')
    expect(fallback.getConnectionPath()).toBe('this-computer')
  })

  it('reloads when turned on through the relay, so the base resolves again', async () => {
    const { setConnectionPath, setNeverUseRelay } = await load()
    const reload = vi.fn()
    setNeverUseRelay(true, { reload })
    // Already direct: nothing to leave.
    expect(reload).not.toHaveBeenCalled()

    setNeverUseRelay(false, { reload })
    setConnectionPath('relay')
    setNeverUseRelay(true, { reload })
    expect(reload).toHaveBeenCalledOnce()
  })
})
