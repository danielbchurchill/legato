import { describe, expect, it } from 'vitest'
import { EDGE_MAX_PX, EDGE_MIN_PX, EDGE_PX_AT_OVERVIEW, edgeWidthPx } from './edgeWidth'

describe('edgeWidthPx', () => {
  it('draws the overview at its own width', () => {
    expect(edgeWidthPx(1)).toBe(EDGE_PX_AT_OVERVIEW)
  })

  it('stays under v1, which drew every edge at 1.7px', () => {
    for (const ratio of [0.01, 0.25, 1, 4, 100]) expect(edgeWidthPx(ratio)).toBeLessThan(1.7)
  })

  it('narrows steadily as the camera zooms in, down to the floor', () => {
    const ratios = [1.5, 1, 0.75, 0.5, 0.35]
    const widths = ratios.map(edgeWidthPx)
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThan(widths[i - 1])
  })

  it('keeps a visible line at a deep zoom and stops widening past the overview', () => {
    expect(edgeWidthPx(0.01)).toBe(EDGE_MIN_PX)
    expect(edgeWidthPx(10)).toBe(EDGE_MAX_PX)
  })

  it('falls back to the overview width for a ratio sigma never reports', () => {
    expect(edgeWidthPx(0)).toBe(EDGE_PX_AT_OVERVIEW)
    expect(edgeWidthPx(Number.NaN)).toBe(EDGE_PX_AT_OVERVIEW)
  })
})
