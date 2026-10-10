import { describe, expect, it } from 'vitest'
import { isLanHost, isLoopbackHost, normalizeAddress, originFor } from './address'
import { clearServerChoice, readServerChoice, storeServerChoice } from './serverChoice'

describe('normalizeAddress', () => {
  it("assumes http on Legato's port when nothing else is typed", () => {
    expect(normalizeAddress('192.168.1.20')).toEqual({ ok: true, origin: 'http://192.168.1.20:8899', host: '192.168.1.20', port: '8899' })
    expect(normalizeAddress(' musicbox.local ')).toMatchObject({ origin: 'http://musicbox.local:8899' })
    expect(normalizeAddress('100.88.83.70:8901/')).toMatchObject({ origin: 'http://100.88.83.70:8901', port: '8901' })
    expect(normalizeAddress('fd00::20')).toEqual({ ok: false })
    expect(normalizeAddress('[fd00::20]')).toMatchObject({ origin: 'http://[fd00::20]:8899' })
  })

  it('takes a typed scheme at its word, default port included', () => {
    expect(normalizeAddress('https://music.example.com')).toEqual({
      ok: true,
      origin: 'https://music.example.com',
      host: 'music.example.com',
      port: '443',
    })
    expect(normalizeAddress('http://musicbox')).toMatchObject({ origin: 'http://musicbox', port: '80' })
  })

  it("refuses what isn't an address", () => {
    for (const input of ['', '   ', 'ftp://musicbox', 'two words', 'http://user:pw@musicbox', 'http://']) {
      expect(normalizeAddress(input)).toEqual({ ok: false })
    }
  })
})

describe('isLanHost', () => {
  it('is true for addresses that only work at home', () => {
    for (const host of ['192.168.1.20', '10.0.0.4', '172.16.5.1', '127.0.0.1', 'localhost', 'musicbox.local', '[fd12:3456::1]', '169.254.3.3']) {
      expect(isLanHost(host)).toBe(true)
    }
  })

  it('is false for Tailscale, public names and public addresses', () => {
    for (const host of ['100.88.83.70', 'music.example.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]']) {
      expect(isLanHost(host)).toBe(false)
    }
  })
})

describe('isLoopbackHost', () => {
  it('knows the whole 127/8 block, not just 127.0.0.1', () => {
    expect(isLoopbackHost('127.0.1.1')).toBe(true)
  })

  it("doesn't mistake a name that only starts like one", () => {
    expect(isLoopbackHost('127.0.0.1.example.com')).toBe(false)
    expect(isLoopbackHost('localhost.lan')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })
})

describe('originFor', () => {
  it('brackets IPv6', () => {
    expect(originFor('192.168.1.20', 8899)).toBe('http://192.168.1.20:8899')
    expect(originFor('fd00::20', 8899)).toBe('http://[fd00::20]:8899')
  })
})

describe('serverChoice', () => {
  it('keeps an origin, and ignores anything else stored there', () => {
    const data = new Map<string, string>()
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as Storage
    expect(readServerChoice(store)).toBeNull()
    storeServerChoice('http://192.168.1.20:8899/some/path', store)
    expect(readServerChoice(store)).toBe('http://192.168.1.20:8899')
    data.set('legato:server-choice', 'javascript:alert(1)')
    expect(readServerChoice(store)).toBeNull()
    clearServerChoice(store)
    expect(readServerChoice(store)).toBeNull()
  })
})
