import { useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

/* v2's collapsible now-playing sections (track metadata / lyrics /
 * connections / notes) — Figma's "Section Collapse" icon, one glyph that
 * rotates between states rather than two glyphs swapped. Content height
 * animates via a CSS grid-rows trick (0fr <-> 1fr) instead of measuring in
 * JS. --motion-base is the token tokens.css's own comment already names
 * for "disclosure". See DESIGN.md "Controls" -> "v2: settings primitives"
 * and the Now Playing panel restructure this drives.
 *
 * The chevron's rotation rides Tailwind's transition-transform utility, so
 * index.css's shared reduced-motion block zeroes it for free. The row-size
 * transition isn't a transform, so it isn't covered by that block —
 * index.css's own comment already calls out "the disclosure" as one of the
 * few things expected to handle reduced motion itself. */

type DisclosureProps = {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}

export function Disclosure({ title, defaultOpen = false, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)
  const reducedMotion = usePrefersReducedMotion()

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex h-[24px] w-full items-center gap-[10px]"
      >
        <Icon
          name="chevron-down"
          className={`shrink-0 text-[var(--color-muted)] transition-transform duration-[var(--motion-base)] ease-[var(--ease-out)] ${
            open ? '' : '-rotate-90'
          }`}
        />
        <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">{title}</span>
      </button>
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
