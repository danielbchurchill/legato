import { describe, expect, it } from 'vitest'
import { overflowPx, revealTitle } from './overflow'

describe('overflowPx', () => {
  it('is 0 when the text fits or only sub-pixel rounding separates them', () => {
    expect(overflowPx(120, 200)).toBe(0)
    expect(overflowPx(200, 200)).toBe(0)
    expect(overflowPx(200.4, 200)).toBe(0)
    expect(overflowPx(201, 200)).toBe(0)
  })

  it('rounds real overflow up to whole pixels', () => {
    expect(overflowPx(202, 200)).toBe(2)
    expect(overflowPx(1051.2, 165)).toBe(887) // the long library-root path from #86's repro
  })
})

describe('revealTitle', () => {
  const title = 'The Unreasonably Long Opening Track Title That Refuses To End Politely'

  it('carries the full text only while some of it is hidden', () => {
    expect(revealTitle(title, 640)).toBe(title)
    expect(revealTitle(title, 0)).toBeUndefined()
  })
})
