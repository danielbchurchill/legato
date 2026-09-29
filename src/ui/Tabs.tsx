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

type TabsProps<T extends string> = {
  options: readonly TabOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name for the tab list. */
  label: string
  variant?: 'segmented' | 'underline'
  /** `segmented` only: skip the inset well, for a caller drawing its own. */
  bare?: boolean
  /** --text-sm for control chrome (default), --text-base for shell chrome. */
  size?: 'sm' | 'base'
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
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )

  useLayoutEffect(() => {
    const tab = tabRefs.current[activeIndex]
    const list = listRef.current
    if (!tab || !list) return
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
    if (e.key === 'ArrowRight') next = activeIndex === last ? 0 : activeIndex + 1
    else if (e.key === 'ArrowLeft') next = activeIndex === 0 ? last : activeIndex - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next == null) return
    e.preventDefault()
    select(next)
  }

  const segmented = variant === 'segmented'
  const textSize = size === 'base' ? 'text-[length:var(--text-base)]' : 'text-[length:var(--text-sm)]'
  const iconSize = size === 'base' ? 18 : 14

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={`relative inline-flex items-center ${
        segmented
          ? bare
            ? 'gap-[2px] p-[2px]'
            : 'gap-[2px] rounded-full border border-[var(--color-hairline)] bg-[var(--color-inset)] p-[2px]'
          : 'gap-[var(--spacing-lg)]'
      } ${className}`}
    >
      {indicator && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-0 ${
            settled && !reduced ? 'transition-[transform,width] duration-[var(--motion-spring)] ease-[var(--ease-spring)]' : ''
          } ${
            segmented
              ? 'inset-y-[2px] rounded-full border border-[var(--color-hairline)] bg-[var(--color-surface-flat)] shadow-[var(--shadow-surface)]'
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
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={handleKeyDown}
            className={`relative z-[1] flex items-center gap-[var(--spacing-xs)] leading-none transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] ${textSize} ${
              segmented ? (size === 'base' ? 'h-[31px] rounded-full px-[14px]' : 'h-[24px] rounded-full px-[10px]') : 'pb-[6px]'
            } ${active ? 'text-[var(--color-ink)]' : 'text-[color:var(--color-control)] hover:text-[var(--color-muted-hi)]'}`}
          >
            {option.icon && <Icon name={option.icon} size={iconSize} />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
