import { describe, expect, it } from 'vitest'
import { formatClock, formatCount, formatHoursMinutes, plural } from './format'

describe('formatClock', () => {
  it('reads a record as m:ss under the hour', () => {
    expect(formatClock(51 * 60_000 + 26_000)).toBe('51:26')
    expect(formatClock(6_000)).toBe('0:06')
  })

  it('adds hours past the hour, padding the minutes', () => {
    expect(formatClock(67 * 60_000 + 30_000)).toBe('1:07:30')
  })

  it('shows the em dash for a missing length', () => {
    expect(formatClock(null)).toBe('—')
  })
})

describe('formatHoursMinutes', () => {
  it('drops seconds and spells the units', () => {
    expect(formatHoursMinutes(171 * 60_000)).toBe('2 h 51 m')
    expect(formatHoursMinutes(42 * 60_000)).toBe('42 m')
  })
})

describe('counts', () => {
  it('groups thousands', () => {
    expect(formatCount(13946)).toBe('13,946')
  })

  it('pluralises on the count', () => {
    expect(plural(1, 'track')).toBe('1 track')
    expect(plural(1082, 'album')).toBe('1,082 albums')
    expect(plural(2, 'match', 'matches')).toBe('2 matches')
  })
})
