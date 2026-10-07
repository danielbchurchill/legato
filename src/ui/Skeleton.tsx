import type { CSSProperties } from 'react'

/* Placeholders for content on its way — gpui-kit's Skeleton, Shimmer and
 * Spinner (crates/component/src/skeleton.rs, shimmer.rs, spinner.rs). These
 * are three of the loops DESIGN.md's Motion section admits since the
 * gpui-kit port; each is bounded the same way the older exceptions are:
 * index.css's reduced-motion rule freezes it on a readable frame, and none
 * of them is decoration — each stands in for something the user asked for
 * and is waiting on. */

/* A block the shape of what will load, breathing between full and half
 * opacity over --motion-skeleton. Size and shape come from className — a
 * square cover, a line of text. v2 draws the primary parts of a placeholder
 * (a cover, a title) in --color-wash-2 and the secondary ones (an artist
 * line) in the fainter --color-wash: `tone="faint"`. */
export function Skeleton({
  className = '',
  style,
  tone = 'default',
}: {
  className?: string
  style?: CSSProperties
  tone?: 'default' | 'faint'
}) {
  return (
    <div
      aria-hidden="true"
      className={`${tone === 'faint' ? 'bg-[var(--color-wash)]' : 'bg-[var(--color-wash-2)]'} animate-[skeleton-pulse_var(--motion-skeleton)_var(--ease-inout)_infinite] ${className}`}
      style={style}
    />
  )
}

/* Text that says work is under way — "rebuilding…", "scanning…" — with a
 * --color-ink band travelling through it. The gradient is three times the
 * text's width with the band in its middle third, so both ends of the
 * sweep (and the frame reduced motion freezes on) show the text in its own
 * colour with no band at all. That colour is `currentColor`: only the glyph
 * fill is made transparent, never `color` itself, so the gradient still
 * inherits whatever tone the caller set. Use it for the label, not a value. */
export function Shimmer({ children, className = '' }: { children: string; className?: string }) {
  return (
    <span
      className={`bg-[linear-gradient(90deg,currentColor_0%,currentColor_40%,var(--color-ink)_50%,currentColor_60%,currentColor_100%)] bg-[length:300%_100%] bg-clip-text animate-[shimmer-sweep_var(--motion-skeleton)_linear_infinite] ${className}`}
      style={{ WebkitTextFillColor: 'transparent' }}
    >
      {children}
    </span>
  )
}
