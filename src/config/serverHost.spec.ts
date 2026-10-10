import { describe, expect, it } from 'vitest'
import { resolveServerOrigin } from './serverHost'

describe('resolveServerOrigin', () => {
  it('uses the page origin when a Legato server served the page', () => {
    const page = { servedByServer: true, origin: 'http://musicbox:8899' }
    expect(resolveServerOrigin(page, {})).toBe('http://musicbox:8899')
  })

  it('ignores a baked-in VITE_SERVER_HOST when a server served the page', () => {
    const page = { servedByServer: true, origin: 'https://music.example.net' }
    expect(resolveServerOrigin(page, { VITE_SERVER_HOST: '100.100.20.30', VITE_SERVER_PORT: '8901' })).toBe(
      'https://music.example.net',
    )
  })

  it('falls back to the loopback default for the desktop app and plain vite', () => {
    const page = { servedByServer: false, origin: 'http://127.0.0.1:5173' }
    expect(resolveServerOrigin(page, {})).toBe('http://127.0.0.1:8899')
    expect(resolveServerOrigin(null, {})).toBe('http://127.0.0.1:8899')
  })

  it('honours VITE_SERVER_HOST and VITE_SERVER_PORT as dev overrides', () => {
    const page = { servedByServer: false, origin: 'http://127.0.0.1:5182' }
    expect(resolveServerOrigin(page, { VITE_SERVER_HOST: '100.100.40.50', VITE_SERVER_PORT: '8902' })).toBe(
      'http://100.100.40.50:8902',
    )
  })

  // Issue #117: a server picked on the connect screen.
  it('takes a chosen server ahead of the default and the env overrides', () => {
    const page = { servedByServer: false, origin: 'tauri://localhost' }
    expect(resolveServerOrigin(page, { VITE_SERVER_HOST: '100.100.40.50' }, 'http://192.168.1.20:8899')).toBe(
      'http://192.168.1.20:8899',
    )
  })

  it('never lets a chosen server override the server that served the page', () => {
    const page = { servedByServer: true, origin: 'http://musicbox:8899' }
    expect(resolveServerOrigin(page, {}, 'http://192.168.1.20:8899')).toBe('http://musicbox:8899')
  })

  it('treats empty overrides as unset', () => {
    expect(resolveServerOrigin(null, { VITE_SERVER_HOST: '', VITE_SERVER_PORT: '' })).toBe('http://127.0.0.1:8899')
  })
})

// Issue #118: "never use the relay", checked where the base resolves.
describe('resolveServerOrigin with the relay pinned off', () => {
  const page = { servedByServer: false, origin: 'tauri://localhost' }
  const relayed = 'https://auth.legato.fm/relay/k3Jt9QxZ'
  const pin = (home: Record<string, string> = {}) => ({
    relayOrigin: 'https://auth.legato.fm',
    homeOrigin: (id: string) => home[id] ?? null,
  })

  it('takes a route through the relay while the pin is off', () => {
    expect(resolveServerOrigin(page, {}, relayed)).toBe(relayed)
  })

  it('reaches the same server at its home address instead', () => {
    expect(resolveServerOrigin(page, {}, relayed, pin({ k3Jt9QxZ: 'http://192.168.1.20:8899' }))).toBe('http://192.168.1.20:8899')
  })

  it('falls back to the default for a server never reached at home', () => {
    expect(resolveServerOrigin(page, {}, relayed, pin())).toBe('http://127.0.0.1:8899')
  })

  it('leaves every other pick alone', () => {
    expect(resolveServerOrigin(page, {}, 'http://192.168.1.20:8899', pin())).toBe('http://192.168.1.20:8899')
    expect(resolveServerOrigin(page, {}, 'https://music.example.com', pin())).toBe('https://music.example.com')
    // legato.fm's own origin, with no server in the path, isn't a route.
    expect(resolveServerOrigin(page, {}, 'https://auth.legato.fm', pin())).toBe('https://auth.legato.fm')
  })

  it('still lets the server that served the page win', () => {
    const served = { servedByServer: true, origin: 'http://musicbox:8899' }
    expect(resolveServerOrigin(served, {}, relayed, pin())).toBe('http://musicbox:8899')
  })
})
