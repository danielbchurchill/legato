import { describe, expect, it } from 'vitest'
import { formatCountdown } from './useSetupCode'
import { qrPath } from './qrPath'

describe('formatCountdown', () => {
  it('shows minutes and zero-padded seconds', () => {
    expect(formatCountdown(10 * 60 * 1000)).toBe('10:00')
    expect(formatCountdown(9 * 60 * 1000 + 5_000)).toBe('9:05')
  })

  it('rounds a part-second up, so 0:00 only shows once the code is really gone', () => {
    expect(formatCountdown(59_001)).toBe('1:00')
    expect(formatCountdown(1)).toBe('0:01')
    expect(formatCountdown(0)).toBe('0:00')
  })

  it('never counts below zero', () => {
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})

describe('qrPath', () => {
  it('draws the claim URL with a four-module quiet zone on every side', () => {
    const { path, size } = qrPath('https://legato.fm/claim?code=K7QM-4XRD')
    // Version 3 (29 modules) is the smallest that holds this URL at level M.
    expect(size).toBe(29 + 8)
    // The top-left finder pattern starts right after the quiet zone.
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true)
    const coordinates = [...path.matchAll(/M(\d+) (\d+)/g)].flatMap((match) => [Number(match[1]), Number(match[2])])
    expect(Math.min(...coordinates)).toBe(4)
    expect(Math.max(...coordinates)).toBe(size - 5)
  })
})
