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
        <div
          role="dialog"
          aria-label={label}
          className="absolute top-full right-0 z-30 mt-[6px] w-[280px] rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-[16px] text-[length:var(--text-base)] text-[var(--color-muted)] backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)]"
        >
          {children}
        </div>
      )}
    </div>
  )
}
