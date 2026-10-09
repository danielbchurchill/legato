// Issue #119: when this device last reached a server, by origin, so a
// launch that finds it gone can still say since when.
import { describe, expect, it } from 'vitest'
import { readLastSeen, rememberSeen } from './lastSeen'

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

describe('lastSeen', () => {
  it('remembers when each origin answered, and what it called itself', () => {
    const store = memoryStorage()
    rememberSeen('http://192.168.1.20:8899', 'musicbox', new Date('2026-10-09T14:02:00Z'), store)
    rememberSeen('http://100.101.102.103:8899', null, new Date('2026-10-08T09:00:00Z'), store)

    expect(readLastSeen('http://192.168.1.20:8899', store)).toEqual({ at: '2026-10-09T14:02:00.000Z', name: 'musicbox' })
    expect(readLastSeen('http://100.101.102.103:8899', store)).toEqual({ at: '2026-10-08T09:00:00.000Z', name: null })
    expect(readLastSeen('http://127.0.0.1:8899', store)).toBeNull()
  })

  it('keeps the name it had when a later answer gives none', () => {
    const store = memoryStorage()
    rememberSeen('http://192.168.1.20:8899', 'musicbox', new Date('2026-10-09T14:02:00Z'), store)
    rememberSeen('http://192.168.1.20:8899', null, new Date('2026-10-09T14:05:00Z'), store)

    expect(readLastSeen('http://192.168.1.20:8899', store)).toEqual({ at: '2026-10-09T14:05:00.000Z', name: 'musicbox' })
  })

  it('reads nothing from storage it never wrote, or that someone garbled', () => {
    const store = memoryStorage()
    store.setItem('legato:last-seen', 'not json')
    expect(readLastSeen('http://192.168.1.20:8899', store)).toBeNull()
    store.setItem('legato:last-seen', JSON.stringify({ 'http://192.168.1.20:8899': { name: 'musicbox' } }))
    expect(readLastSeen('http://192.168.1.20:8899', store)).toBeNull()
    expect(readLastSeen('http://192.168.1.20:8899', null)).toBeNull()
  })
})
