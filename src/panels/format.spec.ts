import { describe, expect, it } from 'vitest'
import { formatBytes, formatDurationHours } from './format'

describe('formatBytes', () => {
  it('formats zero and negative as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-100)).toBe('0 B')
  })

  it('picks the right unit and precision at each scale', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1_500_000)).toBe('1.4 MB')
    expect(formatBytes(13_075_832_553)).toBe('12.2 GB') // real /mnt/music library size
  })
})

describe('formatDurationHours', () => {
  it('shows minutes under an hour', () => {
    expect(formatDurationHours(45 * 60_000)).toBe('45m')
  })

  it('shows one decimal of hours at an hour or more, with a tilde', () => {
    expect(formatDurationHours(90 * 60_000)).toBe('~1.5h')
    expect(formatDurationHours(63_967_054)).toBe('~17.8h') // real /mnt/music library duration
  })
})
