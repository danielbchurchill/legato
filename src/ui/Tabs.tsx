import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon, type IconName } from './Icon'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

/* A hand port of gpui-kit's TabBar (crates/component/src/tab/), drawn in
 * Legato's palette. Replaces three hand-rolled tablists — the map/library
 * switch, the library's albums/tracks toggle, Legato Settings' three-way
 * SegmentedControl — none of which answered an arrow key.
 *
 * Two of gpui-kit's variants:
 *  - `segmented`: the options sit in an inset well (--color-inset, a hole
 *    in the glass per DESIGN.md "Raised and inset") and the active one is a
 *    raised thumb — --color-surface-flat with a hairline edge — that slides
 *    to whichever option is chosen. `bare` drops the well for a caller that
 *    already provides one, the way ViewSwitch's glass pill does.
 *  - `underline`: plain labels over a 2px --color-ink rule that slides under
 *    the active one.
 * Either way the active label is --color-ink and the rest --color-control
 * stepping to --color-muted-hi on hover — DESIGN.md's rule that ink means
 * genuinely active state, unchanged.
 *
 * The indicator slides on --ease-spring over --motion-spring, gpui-kit's
 * spring_move. It animates width as well as transform, which index.css's
 * transform-only reduced-motion rule wouldn't catch, so reduced motion is
 * handled here: the indicator jumps. It's measured from the active tab's own box, so a
 * label changing width, or the whole bar resizing, keeps it fitted.
 *
 * Keyboard is WAI-ARIA's tabs pattern with automatic activation: the bar
 * is one tab stop, Left/Right move to and choose the neighbouring tab
 * (wrapping), Home/End the ends. Every caller switches something cheap (a view, a sort, a setting),
 * so choosing on focus costs nothing and saves a keypress. */

export type TabOption<T extends string> = { value: T; label: string; icon?: IconName }

export type TabsSize = 'xs' | 'sm' | 'md' | 'lg'

const SEGMENT_HEIGHT: Record<TabsSize, string> = {
  xs: 'h-[20px] px-[8px]',
  sm: 'h-[24px] px-[10px]',
  // The library header's albums/artists/tracks, measured from
  // LibraryStageV2: 30px segments in the 2px well, 34px overall, level with
  // the sort pill beside it.
  md: 'h-[30px] px-[12px]',
  lg: 'h-[32px] px-[14px]',
}

type TabsProps<T extends string> = {
  options: readonly TabOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name for the tab list. */
  label: string
  variant?: 'segmented' | 'underline'
  /** `segmented` only: skip the inset well, for a caller drawing its own. */
  bare?: boolean
  /** Segmented heights, overall: 24 (xs), 28 (sm, default), 34 (md — the
   * library header), 36 (lg — the capsule's map/library switch). Underline
   * tabs ignore it. */
  size?: TabsSize
  className?: string
}

export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = 'segmented',
  bare = false,
  size = 'sm',
  className = '',
}: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)
  // The first measurement places the indicator without sliding it in from
  // zero; only a change of tab after that animates.
  const [settled, setSettled] = useState(false)
  const reduced = usePrefersReducedMotion()
  // -1 when the value matches no option — the map's layout control after
  // the sliders have moved off every preset. Nothing is drawn as active, and
  // the first tab takes keyboard focus.
  const activeIndex = options.findIndex((o) => o.value === value)
  const focusIndex = Math.max(0, activeIndex)

  useLayoutEffect(() => {
    const tab = tabRefs.current[activeIndex]
    const list = listRef.current
    if (!tab || !list) {
      setIndicator(null)
      return
    }
    const measure = () => setIndicator({ left: tab.offsetLeft, width: tab.offsetWidth })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    observer.observe(tab)
    return () => observer.disconnect()
  }, [activeIndex, options])

  useLayoutEffect(() => {
    if (indicator && !settled) {
      const raf = requestAnimationFrame(() => setSettled(true))
      return () => cancelAnimationFrame(raf)
    }
  }, [indicator, settled])

  const select = (index: number) => {
    onChange(options[index].value)
    tabRefs.current[index]?.focus()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1
    let next: number | null = null
    if (e.key === 'ArrowRight') next = focusIndex === last ? 0 : focusIndex + 1
    else if (e.key === 'ArrowLeft') next = focusIndex === 0 ? last : focusIndex - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next == null) return
    e.preventDefault()
    select(next)
  }

  const segmented = variant === 'segmented'
  const iconSize = size === 'lg' ? 18 : 14

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={`relative inline-flex shrink-0 items-center ${
        segmented ? (bare ? 'gap-[2px] p-[2px]' : 'gap-[2px] rounded-full bg-[var(--color-sunken)] p-[2px]') : 'gap-[20px]'
      } ${className}`}
    >
      {indicator && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-0 ${
            settled && !reduced ? 'transition-[transform,width] duration-[var(--motion-spring)] ease-[var(--ease-spring)]' : ''
          } ${
            segmented
              ? 'inset-y-[2px] rounded-full bg-[var(--color-raised)] shadow-[var(--shadow-sm)]'
              : 'bottom-0 h-[2px] rounded-full bg-[var(--color-ink)]'
          }`}
          style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }}
        />
      )}
      {options.map((option, index) => {
        const active = index === activeIndex
        return (
          <button
            key={option.value}
            ref={(el) => {
              tabRefs.current[index] = el
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={handleKeyDown}
            className={`relative z-[1] flex items-center gap-[6px] text-[length:var(--text-secondary)] leading-none font-medium whitespace-nowrap transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] ${
              segmented ? `rounded-full ${SEGMENT_HEIGHT[size]}` : 'pb-[9px]'
            } ${active ? 'text-[var(--color-ink)]' : 'text-[color:var(--color-ink-2)] hover:text-[var(--color-ink)]'}`}
          >
            {option.icon && <Icon name={option.icon} size={iconSize} />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
