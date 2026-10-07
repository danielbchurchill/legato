import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

/* A hand port of gpui-kit's Dialog and AlertDialog (crates/component/src/
 * dialog.rs, alert_dialog.rs) on Legato's glass. See DESIGN.md "Controls".
 *
 * The overlay is a --color-canvas wash at 60%, not black: the graph stays
 * visible and blurred through both it and the glass above it, which is the
 * design's one non-negotiable (DESIGN.md "Panels never become opaque").
 *
 * gpui-kit's modal behaviour, all of it:
 *  - Focus moves in on open (to the first control, or `initialFocus`),
 *    Tab and Shift-Tab cycle inside and can't escape, and focus returns to
 *    whatever had it before on close.
 *  - Escape closes. A press on the overlay closes a Dialog but not an
 *    AlertDialog — an alert asks a question, and dismissing it by missing
 *    the box would answer it by accident.
 *  - Enters over --motion-base on --ease-enter, fading and rising
 *    --distance-medium into place; leaves over --motion-exit on
 *    --ease-exit. The rise is a transform, so reduced motion keeps the
 *    fade alone.
 *
 * `open` drives it; the component holds itself mounted through its own exit
 * so a caller can use a plain boolean. */

// --motion-exit, mirrored: a JS timeout can't read a CSS custom property.
const EXIT_MS = 120

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type DialogProps = {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  /** Buttons, right-aligned under the content. */
  footer?: ReactNode
  /** Overlay presses close it. AlertDialog turns this off. */
  dismissible?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  className?: string
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  initialFocus,
  className = 'w-[420px]',
}: DialogProps) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const reduced = usePrefersReducedMotion()

  // What the dialog last showed while open. A caller typically derives its
  // content from the same state that closes it ("remove {folder}?" with the
  // folder cleared on cancel), so rendering live props through the exit
  // would flash "remove undefined?" for its last 120ms.
  const content = useRef({ title, description, children, footer })
  if (open) content.current = { title, description, children, footer }

  // Mount -> next frame shown (so the enter transition has a from-state);
  // close -> hide, then unmount once the exit has played.
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null
      // Mount, then shown on the next frame, then hidden and unmounted after the exit: the animation needs these steps in order.
      // oxlint-disable-next-line react/set-state-in-effect
      setMounted(true)
      const raf = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(raf)
    }
    setShown(false)
    const timer = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!mounted || !open) return
    const surface = surfaceRef.current
    const target = initialFocus?.current ?? surface?.querySelector<HTMLElement>(FOCUSABLE) ?? surface
    target?.focus({ preventScroll: true })
    return () => restoreRef.current?.focus({ preventScroll: true })
  }, [mounted, open, initialFocus])

  useEffect(() => {
    if (!mounted || !open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = Array.from(surfaceRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    // Capture phase, so Escape here wins over the app's own global Escape
    // (deselect / close panel) rather than doing both.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [mounted, open, onClose])

  if (!mounted) return null

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--color-canvas)_60%,transparent)] transition-opacity ${
        shown ? 'duration-[var(--motion-base)] ease-[var(--ease-enter)]' : 'duration-[var(--motion-exit)] ease-[var(--ease-exit)]'
      }`}
      style={{ opacity: shown ? 1 : 0 }}
      onPointerDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={surfaceRef}
        role={dismissible ? 'dialog' : 'alertdialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`flex max-h-[calc(100vh-var(--spacing-lg)*4)] flex-col gap-[var(--spacing-lg)] rounded-[var(--radius-panel)] glass p-[var(--spacing-panel)] outline-none transition-transform ${
          shown ? 'duration-[var(--motion-base)] ease-[var(--ease-enter)]' : 'duration-[var(--motion-exit)] ease-[var(--ease-exit)]'
        } ${className}`}
        style={{ transform: shown || reduced ? 'none' : 'translateY(var(--distance-medium))' }}
      >
        <div className="flex flex-col gap-[var(--spacing-sm)]">
          <h2 id={titleId} className="text-heading text-[var(--color-ink)]">
            {content.current.title}
          </h2>
          {content.current.description && (
            <div id={descriptionId} className="text-[length:var(--text-base)] text-[var(--color-muted)]">
              {content.current.description}
            </div>
          )}
        </div>
        {content.current.children && <div className="min-h-0 overflow-y-auto">{content.current.children}</div>}
        {content.current.footer && (
          <div className="flex items-center justify-end gap-[var(--spacing-lg)]">{content.current.footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}

type AlertDialogProps = {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  title: string
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** The confirm action can't be undone — it takes Button's `destructive`
   * pill, the app's one mark of an irreversible action (DESIGN.md
   * "Controls"). */
  destructive?: boolean
  busy?: boolean
}

/* A Dialog that asks one question. Focus opens on cancel, not confirm —
 * gpui-kit's default for an alert, and the safe one: a reflexive Enter
 * backs out instead of committing. */
export function AlertDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = 'cancel',
  destructive = false,
  busy = false,
}: AlertDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      dismissible={false}
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'destructive' : 'primary'} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  )
}
