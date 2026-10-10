// Issue #118: the path a client takes to its server, read off the base its
// requests go to.
import { describe, expect, it } from 'vitest'
import { connectionPathOf, isHomeHost, pathFor, relayBase, relayedServerId, serverPathOf } from './serverPath'
import { isLanHost } from './address'
import { clearServerChoice, readServerChoice, storeServerChoice } from './serverChoice'

const RELAY = 'https://auth.legato.fm'
const ID = 'k3Jt9QxZ-abc_123'

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

describe('pathFor', () => {
  it('tells this computer, the home network and anywhere else apart', () => {
    expect(pathFor('http://127.0.0.1:8899', true, RELAY)).toBe('embedded')
    expect(pathFor('http://127.0.0.1:8905', false, RELAY)).toBe('this-device')
    expect(pathFor('http://localhost:8899', false, RELAY)).toBe('this-device')
    expect(pathFor('http://[::1]:8899', false, RELAY)).toBe('this-device')
    expect(pathFor('http://192.168.1.20:8899', false, RELAY)).toBe('home')
    expect(pathFor('http://musicbox.local:8899', false, RELAY)).toBe('home')
    expect(pathFor('http://[fd12:3456::1]:8899', false, RELAY)).toBe('home')
    expect(pathFor('https://music.example.com', false, RELAY)).toBe('custom')
    expect(pathFor('http://203.0.113.7:8899', false, RELAY)).toBe('custom')
  })

  // What reaches a server at home from anywhere counts as home, so it
  // streams the original (quality.ts).
  it('counts a dotless name as the home network', () => {
    expect(pathFor('http://musicbox:8899', false, RELAY)).toBe('home')
    expect(pathFor('http://MusicBox:8899', false, RELAY)).toBe('home')
  })

  it('counts a Tailscale address as the home network', () => {
    expect(pathFor('http://100.64.0.1:8899', false, RELAY)).toBe('home')
    expect(pathFor('http://100.101.102.103:8899', false, RELAY)).toBe('home')
    expect(pathFor('http://100.127.255.254:8899', false, RELAY)).toBe('home')
    // Tailscale's IPv6 range is unique-local, which was home already.
    expect(pathFor('http://[fd7a:115c:a1e0::1]:8899', false, RELAY)).toBe('home')
    // Either side of 100.64.0.0/10 is an ordinary public address.
    expect(pathFor('http://100.63.255.255:8899', false, RELAY)).toBe('custom')
    expect(pathFor('http://100.128.0.1:8899', false, RELAY)).toBe('custom')
  })

  it('counts a Tailscale MagicDNS name as the home network', () => {
    expect(pathFor('http://musicbox.tail1234.ts.net:8899', false, RELAY)).toBe('home')
    expect(pathFor('https://musicbox.tail1234.ts.net', false, RELAY)).toBe('home')
    // Only the real suffix.
    expect(pathFor('https://musicbox.ts.network', false, RELAY)).toBe('custom')
    expect(pathFor('https://notts.net', false, RELAY)).toBe('custom')
  })

  it("only calls a loopback server the desktop app's own when the app started it", () => {
    // The desktop app's default can point at another machine (a .env.local
    // baked into the build); that's still a server elsewhere.
    expect(pathFor('http://192.168.1.20:8899', true, RELAY)).toBe('home')
  })

  it('knows a route through the relay by its origin and its /relay/<id> path', () => {
    expect(pathFor(`${RELAY}/relay/${ID}`, false, RELAY)).toBe('relay')
    expect(pathFor(`${RELAY}/relay/${ID}/`, false, RELAY)).toBe('relay')
    // legato.fm itself, or another relay's route, isn't this one.
    expect(pathFor(RELAY, false, RELAY)).toBe('custom')
    expect(pathFor(`https://relay.example.com/relay/${ID}`, false, RELAY)).toBe('custom')
  })

  it('calls a dev relay on this computer the relay, not this computer', () => {
    expect(pathFor(`http://127.0.0.1:8912/relay/${ID}`, true, 'http://127.0.0.1:8912')).toBe('relay')
    expect(pathFor('http://127.0.0.1:8905', false, 'http://127.0.0.1:8912')).toBe('this-device')
  })
})

describe('relay routes', () => {
  it('round-trips a server id through a relay base', () => {
    expect(relayBase(ID, RELAY)).toBe(`${RELAY}/relay/${ID}`)
    expect(relayedServerId(relayBase(ID, RELAY), RELAY)).toBe(ID)
    // A trailing slash or path on the relay's own address doesn't leak in.
    expect(relayBase(ID, `${RELAY}/`)).toBe(`${RELAY}/relay/${ID}`)
  })

  it("isn't fooled by a longer path, a query or a broken escape", () => {
    expect(relayedServerId(`${RELAY}/relay/${ID}/api/v1/health`, RELAY)).toBeNull()
    expect(relayedServerId(`${RELAY}/relay/${ID}?x=1`, RELAY)).toBeNull()
    expect(relayedServerId(`${RELAY}/relay/%E0%A4%A`, RELAY)).toBeNull()
    expect(relayedServerId('not a url', RELAY)).toBeNull()
  })
})

describe('isHomeHost', () => {
  it("leaves isLanHost alone: knownServers.ts still remembers only an address that works nowhere else", () => {
    for (const host of ['musicbox', '100.101.102.103', 'musicbox.tail1234.ts.net']) {
      expect(isHomeHost(host)).toBe(true)
      expect(isLanHost(host)).toBe(false)
    }
  })

  it("doesn't take an IPv6 address for a dotless name", () => {
    expect(isHomeHost('[2001:db8::1]')).toBe(false)
    expect(isHomeHost('2001:db8::1')).toBe(false)
    expect(isHomeHost('')).toBe(false)
  })
})

describe("the store's path", () => {
  it('folds both kinds of this computer into one, and splits it back by who started the server', () => {
    expect(connectionPathOf('embedded')).toBe('this-computer')
    expect(connectionPathOf('this-device')).toBe('this-computer')
    expect(connectionPathOf('home')).toBe('home')
    expect(connectionPathOf('relay')).toBe('relay')
    expect(connectionPathOf('custom')).toBe('custom')
    expect(serverPathOf('this-computer', true)).toBe('embedded')
    expect(serverPathOf('this-computer', false)).toBe('this-device')
    expect(serverPathOf('relay', true)).toBe('relay')
    expect(serverPathOf('home', false)).toBe('home')
  })
})

describe('server choice', () => {
  it('keeps an origin, as before', () => {
    const storage = memoryStorage()
    storeServerChoice('http://192.168.1.20:8899/some/path', storage, RELAY)
    expect(readServerChoice(storage, RELAY)).toBe('http://192.168.1.20:8899')
    clearServerChoice(storage)
    expect(readServerChoice(storage, RELAY)).toBeNull()
  })

  // #118: the path is what picks the server on the relay, so a route
  // through it can't be cut back to legato.fm's origin.
  it('keeps a route through the relay whole', () => {
    const storage = memoryStorage()
    storeServerChoice(`${RELAY}/relay/${ID}/`, storage, RELAY)
    expect(readServerChoice(storage, RELAY)).toBe(`${RELAY}/relay/${ID}`)
  })

  it('ignores anything that is no server address', () => {
    const storage = memoryStorage()
    storage.setItem('legato:server-choice', 'javascript:alert(1)')
    expect(readServerChoice(storage, RELAY)).toBeNull()
    storeServerChoice('ftp://example.com', storage, RELAY)
    expect(readServerChoice(storage, RELAY)).toBeNull()
  })
})
