import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

/* C-1: the (i) affordance's job is to explain something in a full sentence
 * — 130 characters, in the overview's case — which a tooltip (built for two
 * or three words) was never the right mechanism for. A click-to-open,
 * click-or-Escape-to-dismiss popover on the same glass recipe instead. */

export function Popover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        className="text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)]"
      >
        <Icon name="info" size={24} />
      </button>
      {open && (
        // #86: unlike Tooltip.tsx (portaled to document.body, so it never
        // touches an ancestor's overflow), this renders as a normal DOM
        // child of whichever scrolling column opened it — today that's
        // always the Inspector Panel's content div, which clips its x-axis
        // (InspectorPanel.tsx's `overflow-x-hidden`, load-bearing per that
        // file's own comment). A bare `w-[280px]` doesn't fit the panel's
        // narrower widths (--panel-width floors at 300px, minus two
        // --spacing-panel of padding is 252px) — right-0 anchors this to the
        // trigger's own right edge, so the excess used to get clipped off
        // the *left* side with nothing to scroll to, not just hidden behind
        // a scrollbar: a real "hidden/cropped content" case, not merely
        // "still shows a scrollbar." `max-w` caps it at the same available
        // width DataRow/ScrollingText already respect, so it wraps onto more
        // lines instead — 280px stays the preferred width wherever the panel
        // has scaled wide enough (--panel-width grows past 1440px viewport
        // width) to actually offer it.
        <div
          role="dialog"
          aria-label={label}
          className="absolute top-full right-0 z-30 mt-[6px] w-[280px] max-w-[calc(var(--panel-width)-var(--spacing-panel)*2)] rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-[16px] text-[length:var(--text-base)] text-[var(--color-muted)] backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)]"
        >
          {children}
        </div>
      )}
    </div>
  )
}
