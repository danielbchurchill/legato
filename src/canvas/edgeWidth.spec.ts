import { describe, expect, it } from 'vitest'
import { EDGE_MIN_PX, EDGE_PX_AT_OVERVIEW, EDGE_WIDTH_SCALE_KEY, edgeWidthPx, resolveEdgeWidthScale } from './edgeWidth'

describe('edgeWidthPx', () => {
  it('draws the overview at its own width', () => {
    expect(edgeWidthPx(1)).toBe(EDGE_PX_AT_OVERVIEW)
  })

  it('stays under v1, which drew every edge at 1.7px', () => {
    for (const ratio of [0.001, 0.01, 0.25, 1, 4, 100]) expect(edgeWidthPx(ratio)).toBeLessThan(1.7)
  })

  it('holds the overview width all the way in', () => {
    for (const ratio of [0.75, 0.5, 0.1, 0.01, 0.001]) expect(edgeWidthPx(ratio)).toBe(EDGE_PX_AT_OVERVIEW)
  })

  it('thins by the fourth root of the zoom going out, down to the floor', () => {
    const ratios = [1, 1.5, 2.25, 3.375, 5]
    const widths = ratios.map((ratio) => edgeWidthPx(ratio))
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThan(widths[i - 1])
    expect(edgeWidthPx(4)).toBeCloseTo(EDGE_PX_AT_OVERVIEW / Math.SQRT2)
    expect(edgeWidthPx(100)).toBe(EDGE_MIN_PX)
    expect(edgeWidthPx(1e6)).toBe(EDGE_MIN_PX)
  })

  it('draws thicker up close and thinner far out than the old curve (0.7px and 1.6px)', () => {
    expect(edgeWidthPx(0.01)).toBeGreaterThan(0.7)
    expect(edgeWidthPx(10)).toBeLessThan(1.6)
  })

  it('never jumps between neighbouring zooms', () => {
    let previous = edgeWidthPx(0.001)
    for (let ratio = 0.001 * 1.01; ratio < 1000; ratio *= 1.01) {
      const width = edgeWidthPx(ratio)
      expect(Math.abs(width - previous)).toBeLessThan(0.02)
      previous = width
    }
  })

  it('falls back to the overview width for a ratio sigma never reports', () => {
    expect(edgeWidthPx(0)).toBe(EDGE_PX_AT_OVERVIEW)
    expect(edgeWidthPx(Number.NaN)).toBe(EDGE_PX_AT_OVERVIEW)
  })
})

// #467: the map options' line width scales the whole rule.
describe('edgeWidthPx with a line width', () => {
  it('scales every zoom by the same factor, floor included', () => {
    for (const ratio of [0.01, 1, 4, 100, 1e6]) expect(edgeWidthPx(ratio, 2)).toBeCloseTo(edgeWidthPx(ratio) * 2)
    expect(edgeWidthPx(1e6, 0.5)).toBe(EDGE_MIN_PX * 0.5)
  })

  it("reads the setting, falling back to 1 for anything that isn't a positive number", () => {
    expect(resolveEdgeWidthScale({ [EDGE_WIDTH_SCALE_KEY]: '1.75' })).toBe(1.75)
    for (const raw of [undefined, '', 'wide', '0', '-1']) {
      expect(resolveEdgeWidthScale(raw == null ? {} : { [EDGE_WIDTH_SCALE_KEY]: raw })).toBe(1)
    }
  })

  it("doesn't read the shipped panel's edge thickness, which nothing has set since v2", () => {
    expect(resolveEdgeWidthScale({ edgeThicknessMultiplier: '0.2' })).toBe(1)
  })
})
