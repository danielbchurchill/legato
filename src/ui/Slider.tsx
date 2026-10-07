import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { TooltipBubble } from './Tooltip'
import {
  clamp,
  fractionToValue,
  nearestThumb,
  nudge,
  snapToStep,
  stepDecimals,
  valueToFraction,
  type SliderScale,
} from './sliderMath'

/* A hand port of gpui-kit's Slider (crates/component/src/slider.rs over
 * base/src/slider.rs), drawn in Legato's palette. Replaces v2's styled
 * <input type="range">. See DESIGN.md "Controls".
 *
 * What gpui-kit brought over the native range input:
 *  - Range selection (a [start, end] value, two thumbs that never cross),
 *    vertical orientation, a logarithmic scale, and `reverse` (fill from
 *    the thumb to the max end instead of from the min end).
 *  - A filled track. The bar is --color-ink at 20% (40% while pressed),
 *    the selected span full --color-ink — gpui-kit's slider.bar, which is
 *    its primary colour, which is ink here (Legato has no separate accent).
 *  - gpui-kit's thumb: 16px, a 1px rim of the bar colour at 50% around a
 *    --color-canvas core, and a ring that grows out of it on hover, press
 *    and keyboard focus.
 *  - The value in a tooltip on the thumb while it's hovered, dragged or
 *    focused, instead of the always-on readout v2 drew beside every track.
 *    The readout was the one reason a slider needed a fixed-width column
 *    next to it (issue #86's overflow was about exactly that column), and
 *    it's still Rubik: a control value, not library data.
 *  - Keyboard: arrows move one step, Page Up/Down ten, Home/End the ends.
 *    Up and Right both increase, whichever way the slider runs.
 *
 * Pointer handling mirrors base/src/slider.rs: a press anywhere on the
 * track jumps the nearest thumb there and keeps dragging it with the
 * pointer captured, so a drag that leaves the track (or the window) still
 * tracks. `onChange` fires on every move, `onCommit` once on release.
 *
 * Values never ease between positions — the thumb and fill track the
 * pointer exactly (DESIGN.md "Never animate live data" and "direct
 * manipulation must never be animated"). */

type SliderValue = number | [number, number]

type SliderProps<V extends SliderValue> = {
  value: V
  onChange: (value: V) => void
  /** Fires once when a drag or a key press finishes — for work too heavy
   * to repeat on every pixel of a drag. */
  onCommit?: (value: V) => void
  min?: number
  max?: number
  step?: number
  scale?: SliderScale
  orientation?: 'horizontal' | 'vertical'
  /** Fill from the thumb to the max end rather than from the min end. */
  reverse?: boolean
  disabled?: boolean
  /** Accessible name. For a range, "minimum"/"maximum" is appended per thumb. */
  label?: string
  /** What the thumb's tooltip and aria-valuetext say. Defaults to the value
   * at as many decimals as `step` has. */
  format?: (value: number) => string
  className?: string
}

function toPair(value: SliderValue): [number, number] {
  return Array.isArray(value) ? value : [value, value]
}

export function Slider<V extends SliderValue>({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 1,
  step = 0.01,
  scale = 'linear',
  orientation = 'horizontal',
  reverse = false,
  disabled = false,
  label,
  format,
  className = '',
}: SliderProps<V>) {
  const isRange = Array.isArray(value)
  const vertical = orientation === 'vertical'
  const [start, end] = toPair(value)
  const startFraction = valueToFraction(start, min, max, scale)
  const endFraction = valueToFraction(end, min, max, scale)

  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const [dragging, setDragging] = useState<0 | 1 | null>(null)
  const [hovered, setHovered] = useState<0 | 1 | null>(null)
  const [focused, setFocused] = useState<0 | 1 | null>(null)
  // The latest value, readable from pointer handlers without waiting on a
  // re-render — a fast drag produces several moves per frame.
  const latest = useRef(value)
  latest.current = value

  const formatValue = format ?? ((v: number) => v.toFixed(stepDecimals(step)))

  const emit = (thumb: 0 | 1, next: number): V => {
    if (!isRange) return next as V
    const [s, e] = toPair(latest.current)
    // Thumbs stop at each other rather than swapping: dragging the start
    // thumb past the end one pins it there.
    return (thumb === 0 ? [Math.min(next, e), e] : [s, Math.max(next, s)]) as V
  }

  const fractionAt = (clientX: number, clientY: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return vertical
      ? clamp((rect.bottom - clientY) / rect.height, 0, 1)
      : clamp((clientX - rect.left) / rect.width, 0, 1)
  }

  const valueAt = (clientX: number, clientY: number) =>
    snapToStep(fractionToValue(fractionAt(clientX, clientY), min, max, scale), min, max, step)

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    const fraction = fractionAt(e.clientX, e.clientY)
    const thumb = isRange ? nearestThumb(fraction, startFraction, endFraction) : 1
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(thumb)
    thumbRefs[thumb].current?.focus({ preventScroll: true })
    const next = emit(thumb, valueAt(e.clientX, e.clientY))
    latest.current = next
    onChange(next)
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging == null) return
    const next = emit(dragging, valueAt(e.clientX, e.clientY))
    latest.current = next
    onChange(next)
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging == null) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(null)
    onCommit?.(latest.current)
  }

  const handleKeyDown = (thumb: 0 | 1) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const current = toPair(latest.current)[thumb]
    let next: number | null = null
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = nudge(current, 1, false, { min, max, step, scale })
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        next = nudge(current, -1, false, { min, max, step, scale })
        break
      case 'PageUp':
        next = nudge(current, 1, true, { min, max, step, scale })
        break
      case 'PageDown':
        next = nudge(current, -1, true, { min, max, step, scale })
        break
      case 'Home':
        next = min
        break
      case 'End':
        next = max
        break
    }
    if (next == null) return
    e.preventDefault()
    const value = emit(thumb, next)
    latest.current = value
    onChange(value)
    onCommit?.(value)
  }

  // The filled span. A single-value slider fills min -> thumb, or with
  // `reverse` thumb -> max; a range fills between its two thumbs.
  const [fillFrom, fillTo] = isRange ? [startFraction, endFraction] : reverse ? [endFraction, 1] : [0, endFraction]
  const fillStyle = vertical
    ? { bottom: `${fillFrom * 100}%`, top: `${(1 - fillTo) * 100}%` }
    : { left: `${fillFrom * 100}%`, right: `${(1 - fillTo) * 100}%` }

  const thumbs: (0 | 1)[] = isRange ? [0, 1] : [1]

  return (
    <div
      className={`flex touch-none select-none ${
        vertical ? 'h-[120px] w-[24px] justify-center' : 'h-[24px] w-full min-w-0 flex-1 items-center'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}
    >
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`relative flex ${vertical ? 'h-full w-[24px] justify-center' : 'h-[24px] w-full items-center'}`}
      >
        {/* v2: a 4px --color-wash-2 track with an ink fill — the slider is
         * a quantity, not an on/off, so it stays out of the accent. */}
        <div
          className={`relative rounded-full transition-colors duration-[var(--motion-fast)] ${
            vertical ? 'h-full w-[4px]' : 'h-[4px] w-full'
          } ${dragging != null ? 'bg-[var(--color-line-strong)]' : 'bg-[var(--color-wash-2)]'}`}
        >
          <div
            className={`absolute rounded-full bg-[var(--color-ink)] ${vertical ? 'inset-x-0' : 'inset-y-0'}`}
            style={fillStyle}
          />
        </div>

        {thumbs.map((thumb) => {
          const thumbValue = thumb === 0 ? start : end
          const fraction = thumb === 0 ? startFraction : endFraction
          const active = dragging === thumb || hovered === thumb || focused === thumb
          const thumbLabel = isRange ? `${label ?? 'value'} ${thumb === 0 ? 'minimum' : 'maximum'}` : label
          // The single-value slider's one thumb is index 1 so it shares the
          // range's `end` path above; its ref is the second one too.
          const ref = thumbRefs[thumb]
          return (
            <div
              key={thumb}
              ref={ref}
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={thumbLabel}
              aria-valuemin={isRange && thumb === 1 ? start : min}
              aria-valuemax={isRange && thumb === 0 ? end : max}
              aria-valuenow={thumbValue}
              aria-valuetext={formatValue(thumbValue)}
              aria-orientation={orientation}
              aria-disabled={disabled || undefined}
              data-focus-ring="part"
              onKeyDown={handleKeyDown(thumb)}
              onPointerEnter={() => setHovered(thumb)}
              onPointerLeave={() => setHovered((h) => (h === thumb ? null : h))}
              onFocus={(e) => {
                // Only a keyboard-driven focus opens the bubble on its own;
                // a pointer press already has hover/drag showing it.
                if (e.currentTarget.matches(':focus-visible')) setFocused(thumb)
              }}
              onBlur={() => setFocused((f) => (f === thumb ? null : f))}
              className="absolute size-[14px] rounded-full"
              style={
                vertical
                  ? { bottom: `${fraction * 100}%`, left: '50%', transform: 'translate(-50%, 50%)' }
                  : { left: `${fraction * 100}%`, top: '50%', transform: 'translate(-50%, -50%)' }
              }
            >
              {/* The ring: grows out of the thumb's edge on hover/press/
               * focus, gpui-kit's ThumbRing. Outline rather than a bordered
               * overlay so it never changes the thumb's own box. */}
              <span
                className={`focus-ring-part block size-full rounded-full bg-[var(--color-ink)] shadow-[0_1px_3px_rgb(0_0_0/0.35)] transition-[outline-width] duration-[var(--motion-fast)] ease-[var(--ease-out)] ${
                  active && !disabled
                    ? 'outline-[3px] outline-solid outline-[color-mix(in_srgb,var(--color-ring)_50%,transparent)]'
                    : 'outline-0 outline-solid outline-transparent'
                }`}
              />
              <TooltipBubble
                open={active && !disabled}
                anchorRef={ref}
                label={formatValue(thumbValue)}
                placement={vertical ? 'right' : 'top'}
                trackDeps={[thumbValue]}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
