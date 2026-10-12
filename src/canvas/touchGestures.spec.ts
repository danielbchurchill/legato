import { describe, expect, it } from 'vitest'
import { TAP_TOLERANCE_PX, TapGuard, isTouchEvent, midpoint, pinchCameraState, type CameraState, type Point } from './touchGestures'

/* A stand-in for sigma's viewport → framed-graph conversion on a 400×800
 * viewport: the camera's x/y sits at the centre, y grows upwards, and one
 * framed unit spans 400px / ratio. */
const toFramed = (p: Point, camera: CameraState): Point => ({
  x: camera.x + ((p.x - 200) * camera.ratio) / 400,
  y: camera.y - ((p.y - 400) * camera.ratio) / 400,
})
const unbounded = (ratio: number) => ratio
const start: CameraState = { x: 0.5, y: 0.5, ratio: 1, angle: 0 }

const around = (centre: Point, spread: number): [Point, Point] => [
  { x: centre.x - spread / 2, y: centre.y },
  { x: centre.x + spread / 2, y: centre.y },
]

describe('pinchCameraState', () => {
  it('zooms in by how far the fingers spread', () => {
    const next = pinchCameraState(start, around({ x: 200, y: 400 }, 100), around({ x: 200, y: 400 }, 200), toFramed, unbounded)
    expect(next.ratio).toBeCloseTo(0.5)
  })

  it('keeps the point between the fingers under them, off centre', () => {
    const from = around({ x: 90, y: 620 }, 120)
    const to = around({ x: 90, y: 620 }, 300)
    const anchor = toFramed(midpoint(...from), start)
    const next = pinchCameraState(start, from, to, toFramed, unbounded)
    const after = toFramed(midpoint(...to), next)
    expect(after.x).toBeCloseTo(anchor.x)
    expect(after.y).toBeCloseTo(anchor.y)
  })

  it('pans with the fingers when they move together', () => {
    const from = around({ x: 200, y: 400 }, 150)
    const to = around({ x: 260, y: 340 }, 150)
    const next = pinchCameraState(start, from, to, toFramed, unbounded)
    expect(next.ratio).toBeCloseTo(1)
    const after = toFramed(midpoint(...to), next)
    const anchor = toFramed(midpoint(...from), start)
    expect(after.x).toBeCloseTo(anchor.x)
    expect(after.y).toBeCloseTo(anchor.y)
  })

  it('never rotates, however the fingers turn', () => {
    const from: [Point, Point] = [{ x: 100, y: 400 }, { x: 300, y: 400 }]
    const to: [Point, Point] = [{ x: 200, y: 300 }, { x: 200, y: 500 }]
    expect(pinchCameraState({ ...start, angle: 0.3 }, from, to, toFramed, unbounded).angle).toBe(0.3)
  })

  it("holds the zoom at the camera's bound and still keeps the midpoint fixed", () => {
    const from = around({ x: 120, y: 300 }, 100)
    const to = around({ x: 120, y: 300 }, 1000)
    const next = pinchCameraState(start, from, to, toFramed, (r) => Math.max(0.25, r))
    expect(next.ratio).toBe(0.25)
    const after = toFramed(midpoint(...to), next)
    const anchor = toFramed(midpoint(...from), start)
    expect(after.x).toBeCloseTo(anchor.x)
    expect(after.y).toBeCloseTo(anchor.y)
  })

  it('leaves the zoom alone when two touches land on the same point', () => {
    const same: [Point, Point] = [{ x: 200, y: 400 }, { x: 200, y: 400 }]
    expect(pinchCameraState(start, same, around({ x: 200, y: 400 }, 100), toFramed, unbounded).ratio).toBe(1)
  })
})

describe('TapGuard', () => {
  it('lets a still finger tap', () => {
    const guard = new TapGuard()
    guard.down([{ x: 10, y: 10 }], true)
    guard.move([{ x: 13, y: 14 }])
    expect(guard.allowsTap()).toBe(true)
  })

  it('spoils the tap once the finger travels past the tolerance, even if it comes back', () => {
    const guard = new TapGuard()
    guard.down([{ x: 10, y: 10 }], true)
    guard.move([{ x: 10 + TAP_TOLERANCE_PX + 1, y: 10 }])
    guard.move([{ x: 10, y: 10 }])
    expect(guard.allowsTap()).toBe(false)
  })

  it('spoils the tap for the finger left on the glass after a pinch', () => {
    const guard = new TapGuard()
    guard.down([{ x: 10, y: 10 }], true)
    guard.down([{ x: 10, y: 10 }, { x: 90, y: 90 }], false)
    // One finger lifts: sigma restarts from the one left.
    guard.down([{ x: 10, y: 10 }], false)
    expect(guard.allowsTap()).toBe(false)
  })

  it('starts over with the next fresh touch', () => {
    const guard = new TapGuard()
    guard.down([{ x: 0, y: 0 }, { x: 50, y: 50 }], true)
    expect(guard.allowsTap()).toBe(false)
    guard.down([{ x: 200, y: 200 }], true)
    expect(guard.allowsTap()).toBe(true)
  })
})

describe('isTouchEvent', () => {
  it('tells a touch from a mouse event', () => {
    expect(isTouchEvent(new Event('mousedown'))).toBe(false)
    expect(isTouchEvent(Object.assign(new Event('touchstart'), { touches: [] }))).toBe(true)
  })
})
