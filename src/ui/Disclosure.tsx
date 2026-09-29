import { useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

/* v2's collapsible now-playing sections (track metadata / lyrics /
 * connections / notes) — Figma's "Section Collapse" icon, one glyph that
 * rotates between states rather than two glyphs swapped. Content height
 * animates via a CSS grid-rows trick (0fr <-> 1fr) instead of measuring in
 * JS. --motion-base is the token tokens.css's own comment already names
 * for "disclosure". See DESIGN.md "Controls" -> "The gpui-kit control set"
 * and the Now Playing panel restructure this drives.
 *
 * The chevron's rotation rides Tailwind's transition-transform utility, so
 * index.css's shared reduced-motion block zeroes it for free. The row-size
 * transition isn't a transform, so it isn't covered by that block —
 * index.css's own comment already calls out "the disclosure" as one of the
 * few things expected to handle reduced motion itself.
 *
 * `open`/`onOpenChange` make this dual controlled/uncontrolled, same shape
 * as any standard disclosure primitive — added for the track-metadata
 * disclosure's play/edit icons (a header action, same slot SectionHeader
 * already has) and for lyrics, which needs its host to observe open state
 * to gate the lazy fetch. Uncontrolled `defaultOpen` still works unchanged
 * for every section that doesn't care. The action lives as a flex sibling
 * of the toggle button rather than inside it — nesting real buttons (play,
 * edit) inside the disclosure's own button would be invalid HTML and steal
 * its click target, the same reason SectionHeader's `action` is a sibling
 * of its own header row rather than nested in anything clickable. */

type DisclosureProps = {
  title: string
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  action?: ReactNode
  children: ReactNode
}

export function Disclosure({ title, defaultOpen = false, open: openProp, onOpenChange, action, children }: DisclosureProps) {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = openProp ?? openState
  const reducedMotion = usePrefersReducedMotion()

  const toggle = () => {
    const next = !open
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }

  return (
    <div>
      <div className="flex h-[24px] w-full items-center gap-[10px]">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-[10px]">
          <Icon
            name="chevron-down"
            className={`shrink-0 text-[var(--color-muted)] transition-transform duration-[var(--motion-base)] ease-[var(--ease-out)] ${
              open ? '' : '-rotate-90'
            }`}
          />
          <span className="truncate text-[length:var(--text-base)] text-[var(--color-muted)]" title={title}>
            {title}
          </span>
        </button>
        {action}
      </div>
      <div
        className="grid transition-[grid-template-rows] ease-[var(--ease-out)]"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          transitionDuration: reducedMotion ? '0ms' : 'var(--motion-base)',
        }}
      >
        <div className="overflow-hidden">
          <div className="pt-[var(--spacing-rule-body)]">{children}</div>
        </div>
      </div>
    </div>
  )
}
