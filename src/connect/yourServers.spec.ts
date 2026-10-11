import { describe, expect, it, vi } from 'vitest'
import { readKnownServers, rememberServer } from './knownServers'
import { candidateOrigins, fetchLinkedServers, LinkedServersError, reachServer, serverName, type FoundServer } from './yourServers'

/* Issue #117: "your servers", each at home or offline since … . */

const ID = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'

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

const found: FoundServer[] = [
  { instance: 'musicbox', name: 'musicbox', id: ID, version: '0.4.0', port: 8899, addresses: ['192.168.1.20', 'fd00::20'] },
  { instance: 'kitchen', name: 'kitchen', id: OTHER, version: '0.4.0', port: 8899, addresses: ['192.168.1.30'] },
]

describe('knownServers', () => {

  it('remembers when and where this device reached a server, keeping only LAN addresses as one to look at', () => {
    const store = memoryStorage()
    rememberServer(ID, { origin: 'http://192.168.1.20:8899', name: 'musicbox' }, new Date('2026-10-08T10:00:00Z'), store)
    rememberServer(ID, { origin: 'http://100.88.83.70:8899' }, new Date('2026-10-08T11:00:00Z'), store)
    expect(readKnownServers(store)[ID]).toEqual({
      name: 'musicbox',
      lanOrigin: 'http://192.168.1.20:8899',
      lastReachedAt: '2026-10-08T11:00:00.000Z',
    })
    store.setItem('legato:known-servers', 'not json')
    expect(readKnownServers(store)).toEqual({})
  })
})

describe('candidateOrigins', () => {
  it("tries mDNS's addresses for this id, then the last LAN address, once each", () => {
    const known = { [ID]: { name: 'musicbox', lanOrigin: 'http://192.168.1.21:8899', lastReachedAt: '2026-10-07T20:00:00Z' } }
    expect(candidateOrigins(ID, found, known)).toEqual([
      { origin: 'http://192.168.1.20:8899', via: 'mdns' },
      { origin: 'http://[fd00::20]:8899', via: 'mdns' },
      { origin: 'http://192.168.1.21:8899', via: 'lan' },
    ])
    const same = { [ID]: { ...known[ID]!, lanOrigin: 'http://192.168.1.20:8899' } }
    expect(candidateOrigins(ID, found, same)).toHaveLength(2)
    expect(candidateOrigins(ID, null, {})).toEqual([])
  })
})

describe('reachServer', () => {
  const known = { [ID]: { name: 'musicbox', lanOrigin: 'http://192.168.1.21:8899', lastReachedAt: '2026-10-07T20:00:00.000Z' } }

  it('is at home at the first address that proves the id', async () => {
    const verify = vi.fn(async (origin: string) =>
      origin === 'http://192.168.1.21:8899' ? { ok: true as const, serverId: ID, publicKey: 'k' } : { ok: false as const, reason: 'unreachable' as const },
    )
    expect(await reachServer(ID, candidateOrigins(ID, found, known), known, verify)).toEqual({
      kind: 'home',
      origin: 'http://192.168.1.21:8899',
      via: 'lan',
    })
    expect(verify).toHaveBeenCalledTimes(3)
  })

  it("isn't at home because something advertised the id: it has to prove it", async () => {
    const verify = vi.fn(async () => ({ ok: false as const, reason: 'wrong-key' as const }))
    expect(await reachServer(ID, candidateOrigins(ID, found, known), known, verify)).toEqual({
      kind: 'offline',
      since: '2026-10-07T20:00:00.000Z',
    })
  })

  it('is offline with no time for a server this device never reached', async () => {
    expect(await reachServer(OTHER, [], {})).toEqual({ kind: 'offline', since: null })
  })

  // Issue #365.
  it('is through legato.fm when not at home but its tunnel is up, unless the relay is pinned off', async () => {
    const unreachable = vi.fn(async () => ({ ok: false as const, reason: 'unreachable' as const }))
    const candidates = candidateOrigins(ID, found, known)
    expect(await reachServer(ID, candidates, known, unreachable, { tunnelUp: true, allowed: true })).toEqual({ kind: 'relay' })
    expect(await reachServer(ID, candidates, known, unreachable, { tunnelUp: true, allowed: false })).toMatchObject({ kind: 'offline' })
    expect(await reachServer(ID, candidates, known, unreachable, { tunnelUp: false, allowed: true })).toMatchObject({ kind: 'offline' })
    // At home still comes first.
    const home = vi.fn(async () => ({ ok: true as const, serverId: ID, publicKey: 'k' }))
    expect(await reachServer(ID, candidates, known, home, { tunnelUp: true, allowed: true })).toMatchObject({ kind: 'home' })
  })
})

describe('serverName', () => {
  it("uses what mDNS or a past visit called it, else the start of the id", () => {
    expect(serverName(ID, found, {})).toBe('musicbox')
    expect(serverName(ID, null, { [ID]: { name: 'Living room', lanOrigin: null, lastReachedAt: '' } })).toBe('Living room')
    expect(serverName('abcdef0123456789abcdef0123456789', null, {})).toBe('Server abcdef01')
  })
})

describe('fetchLinkedServers', () => {
  it("reads the account's list with its session", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ servers: [{ serverId: ID, linkedAt: '2026-10-08T09:00:00.000Z' }] }))
    expect(await fetchLinkedServers('relay-token', 'http://127.0.0.1:8913', fetchImpl as unknown as typeof fetch)).toEqual([
      { serverId: ID, linkedAt: '2026-10-08T09:00:00.000Z' },
    ])
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8913/linked-servers', {
      headers: { Authorization: 'Bearer relay-token' },
      credentials: 'omit',
    })
  })

  it('says when the legato.fm session ended, and when legato.fm is out of reach', async () => {
    const ended = (async () => new Response('{}', { status: 401 })) as typeof fetch
    await expect(fetchLinkedServers('t', 'http://127.0.0.1:8913', ended)).rejects.toMatchObject({ signedOut: true })
    const down = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(fetchLinkedServers('t', 'http://127.0.0.1:8913', down)).rejects.toBeInstanceOf(LinkedServersError)
  })
})
