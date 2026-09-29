import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { enterOffset, useAnchoredPosition, type Align, type Placement } from './floating'
import { useMountFade } from './useMountFade'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

/* A click-to-open floating surface — gpui-kit's Popover (crates/component/
 * src/popover.rs), on Legato's glass recipe (DESIGN.md "Glass").
 *
 * C-1 introduced the original as the (i) affordance's container: a
 * sentence-length explanation a tooltip was never built for. The gpui-kit
 * port generalises it — any trigger, any content (the transport's volume
 * slider lives in one) — and brings gpui-kit's popup behaviour with it:
 *  - Portaled to document.body and positioned by floating.ts, so it flips
 *    to the other side when it doesn't fit and no panel's overflow clip can
 *    crop it. The old one rendered inside whichever scrolling column opened
 *    it, and #86 had to cap its width to keep the Inspector Panel's
 *    overflow-x-hidden from cutting its left side off.
 *  - Focus moves into the popup on open and back to the trigger on close;
 *    Escape and a press anywhere outside both close it.
 *  - Arrives sliding --distance-short out of its trigger as it fades, on
 *    --ease-enter — the same enter motion as Tooltip, since gpui-kit gives
 *    every popup one shared surface and one shared motion. */

type TriggerProps = {
  ref: RefObject<HTMLButtonElement | null>
  onClick: () => void
  'aria-expanded': boolean
  'aria-controls': string
  'aria-haspopup': 'dialog'
}

type PopoverProps = {
  /** Accessible name for the popup. */
  label: string
  /** Render the trigger, spreading the props onto a real <button>. */
  trigger: (props: TriggerProps & { open: boolean }) => ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  placement?: Placement
  align?: Align
  /** Popup padding and width. Defaults suit prose. */
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Popover({
  label,
  trigger,
  children,
  placement = 'bottom',
  align = 'end',
  className = 'w-[280px] p-[16px]',
  open: openProp,
  onOpenChange,
}: PopoverProps) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (next: boolean) => {
    if (openProp == null) setOpenState(next)
    onOpenChange?.(next)
  }

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const shown = useMountFade(open)
  const reduced = usePrefersReducedMotion()
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, floatingRef: popupRef, placement, align })

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!open) return
    // First focusable thing inside, or the popup itself — either way focus
    // is inside it, so Tab continues from there and Escape is heard.
    const popup = popupRef.current
    const first = popup?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    ;(first ?? popup)?.focus({ preventScroll: true })

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <>
      {trigger({
        ref: triggerRef,
        open,
        onClick: () => setOpen(!open),
        'aria-expanded': open,
        'aria-controls': id,
        'aria-haspopup': 'dialog',
      })}
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={id}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            className={`fixed z-40 rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-surface)] text-[length:var(--text-base)] text-[var(--color-muted)] outline-none backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)] transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--ease-enter)] ${className}`}
            style={{
              opacity: shown ? 1 : 0,
              transform: shown || reduced ? 'none' : enterOffset(position.placement),
              top: `${position.top}px`,
              left: `${position.left}px`,
            }}
          >
            {typeof children === 'function' ? children(close) : children}
          </div>,
          document.body,
        )}
    </>
  )
}

/* The (i) affordance: an info glyph opening a sentence of explanation —
 * C-1's original, and still the shape DatabaseInspector uses. */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover
      label={label}
      trigger={({ open: _open, ...props }) => (
        <button
          type="button"
          aria-label={label}
          {...props}
          className="text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)]"
        >
          <Icon name="info" size={24} />
        </button>
      )}
    >
      {children}
    </Popover>
  )
}
