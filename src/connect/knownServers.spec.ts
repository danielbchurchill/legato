import { describe, expect, it, vi } from 'vitest'

// A dev relay on this computer, whose host counts as a LAN one.
vi.mock('../config/relayHost', () => ({ RELAY_ORIGIN: 'http://127.0.0.1:8915' }))

import { readKnownServers, rememberServer } from './knownServers'

const ID = '0123456789abcdef0123456789abcdef'

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

// Issue #365: "never use the relay" sends a client to the server's LAN
// address, so a route through the relay must never become that address.
describe('rememberServer through the relay', () => {
  it("records the visit but keeps the LAN address, even from a relay on a LAN host", () => {
    const store = memoryStorage()
    rememberServer(ID, { origin: 'http://192.168.1.20:8899' }, new Date('2026-10-10T00:00:00.000Z'), store)
    rememberServer(ID, { origin: `http://127.0.0.1:8915/relay/${ID}`, name: 'musicbox' }, new Date('2026-10-10T01:00:00.000Z'), store)
    expect(readKnownServers(store)[ID]).toEqual({
      name: 'musicbox',
      lanOrigin: 'http://192.168.1.20:8899',
      lastReachedAt: '2026-10-10T01:00:00.000Z',
    })
  })
})
