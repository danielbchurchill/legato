import { describe, expect, it } from 'vitest'
import { currentLyricIndex, parseSyncedLyrics } from './lyrics'

describe('parseSyncedLyrics', () => {
  it('reads stamps, drops metadata tags, keeps blank pauses', () => {
    const lines = parseSyncedLyrics('[ar:Someone]\n[00:12.50] First line\n[00:15.05]\n[01:02.123] Third line')
    expect(lines).toEqual([
      { timeMs: 12_500, text: 'First line' },
      { timeMs: 15_050, text: '' },
      { timeMs: 62_123, text: 'Third line' },
    ])
  })

  it('expands a line with several stamps and sorts by time', () => {
    const lines = parseSyncedLyrics('[00:30.00][00:10.00] Chorus\n[00:20.00] Verse')
    expect(lines.map((l) => [l.timeMs, l.text])).toEqual([
      [10_000, 'Chorus'],
      [20_000, 'Verse'],
      [30_000, 'Chorus'],
    ])
  })
})

describe('currentLyricIndex', () => {
  const lines = parseSyncedLyrics('[00:10.00] a\n[00:20.00] b\n[00:30.00] c')

  it('is -1 before the first line', () => {
    expect(currentLyricIndex(lines, 5_000)).toBe(-1)
  })

  it('holds a line until the next one starts', () => {
    expect(currentLyricIndex(lines, 10_000)).toBe(0)
    expect(currentLyricIndex(lines, 19_999)).toBe(0)
    expect(currentLyricIndex(lines, 25_000)).toBe(1)
    expect(currentLyricIndex(lines, 99_000)).toBe(2)
  })
})
