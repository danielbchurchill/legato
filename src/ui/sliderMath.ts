/* Slider.tsx's value math, kept pure so it can be tested without a DOM —
 * the same split gpui-kit makes between base/src/slider.rs's SliderState
 * (values, steps, scale) and the element that draws it.
 *
 * "Fraction" throughout is a thumb's position along the track, 0 at the min
 * end and 1 at the max end, whatever the scale. */

export type SliderScale = 'linear' | 'logarithmic'

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/* Decimal places a step implies — 0.01 -> 2, 5 -> 0, 0.25 -> 2. Used both to
 * strip floating-point noise off a snapped value (0.1 + 0.2) and as the
 * default number of places the thumb's value bubble shows. */
export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  const text = String(step)
  const exponent = text.match(/e-(\d+)$/)
  if (exponent) return Number(exponent[1])
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/* Snaps to the step grid anchored at `min` (so min 20 step 5 lands on 20,
 * 25, 30 — not on multiples of 5 from zero that happen to differ), then
 * clamps. The max itself is always reachable even when (max - min) isn't a
 * whole number of steps. */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  if (value >= max) return max
  if (value <= min) return min
  if (!(step > 0)) return value
  const snapped = min + Math.round((value - min) / step) * step
  return clamp(Number(snapped.toFixed(stepDecimals(step))), min, max)
}

/* Logarithmic scale is gpui-kit's SliderScale::Logarithmic: equal distances
 * along the track multiply the value by equal ratios. It needs a strictly
 * positive range — log(0) has no position — so a min at or below zero falls
 * back to linear rather than producing NaN positions. */
function isLog(scale: SliderScale, min: number): boolean {
  return scale === 'logarithmic' && min > 0
}

export function valueToFraction(value: number, min: number, max: number, scale: SliderScale = 'linear'): number {
  if (max <= min) return 0
  const v = clamp(value, min, max)
  if (isLog(scale, min)) return Math.log(v / min) / Math.log(max / min)
  return (v - min) / (max - min)
}

export function fractionToValue(fraction: number, min: number, max: number, scale: SliderScale = 'linear'): number {
  const f = clamp(fraction, 0, 1)
  if (isLog(scale, min)) return min * Math.pow(max / min, f)
  return min + f * (max - min)
}

/* One keyboard step. On a log scale an arrow press moves the thumb by the
 * same fraction of the track a linear one would — one hundredth — rather
 * than by `step` in value terms, which would crawl at the bottom of a
 * 1-1000 range and leap at the top. Page keys move ten times that. */
export function nudge(
  value: number,
  direction: 1 | -1,
  big: boolean,
  { min, max, step, scale }: { min: number; max: number; step: number; scale: SliderScale },
): number {
  const multiplier = big ? 10 : 1
  if (isLog(scale, min)) {
    const fraction = valueToFraction(value, min, max, scale) + direction * multiplier * 0.01
    return snapToStep(fractionToValue(fraction, min, max, scale), min, max, step)
  }
  return snapToStep(value + direction * multiplier * step, min, max, step)
}

/* Which thumb of a range a press on the track should grab: the nearer one,
 * and on a tie (both thumbs stacked at one point) whichever side of them the
 * press landed on, so the pair can always be pulled apart. */
export function nearestThumb(fraction: number, start: number, end: number): 0 | 1 {
  const toStart = Math.abs(fraction - start)
  const toEnd = Math.abs(fraction - end)
  if (toStart === toEnd) return fraction < start ? 0 : 1
  return toStart < toEnd ? 0 : 1
}
