import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { ToastContext, type ToastApi, type ToastInput } from './toastContext'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

/* Toasts — a hand port of gpui-kit's Notification stack (crates/component/
 * src/notification.rs) on Legato's glass. See DESIGN.md "Controls".
 *
 * A transient sentence about something that just happened, stacked at the
 * top right under the right-hand header, newest on top. Rubik throughout:
 * a toast is the app talking, not library data. No success/warning/error
 * colours — the palette has no semantic hues (DESIGN.md "Controls" on why
 * there's no danger token), and gpui-kit's per-kind icon is a colour cue
 * first, so the neutral kind is the only one ported.
 *
 * Each dismisses itself after DEFAULT_DURATION unless told otherwise, and
 * the countdown pauses while the pointer is over the stack, so a toast
 * someone is reading doesn't vanish mid-sentence. Enters sliding in from
 * the right --distance-medium over --motion-slow on --ease-enter; leaves
 * fading over --motion-exit. The slide is a transform, so reduced motion
 * keeps only the fades. role="status" makes a screen reader announce each
 * one politely rather than interrupting. */

const DEFAULT_DURATION = 5000
// --motion-exit, mirrored for the unmount timeout.
const EXIT_MS = 120
const MAX_VISIBLE = 4

type ToastEntry = ToastInput & { id: number; leaving: boolean }

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: number) => void }) {
  const [shown, setShown] = useState(false)
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const visible = shown && !toast.leaving
  return (
    <div
      role="status"
      className={`pointer-events-auto flex w-[320px] items-start gap-[var(--spacing-sm)] rounded-[var(--radius-card)] glass p-[14px] transition-[opacity,transform] ${
        toast.leaving ? 'duration-[var(--motion-exit)] ease-[var(--ease-exit)]' : 'duration-[var(--motion-slow)] ease-[var(--ease-enter)]'
      }`}
      style={{ opacity: visible ? 1 : 0, transform: shown || reduced ? 'none' : 'translateX(var(--distance-medium))' }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--spacing-xs)]">
        <p className="text-[length:var(--text-sm)] text-[var(--color-ink)]">{toast.title}</p>
        {toast.description && (
          <div className="text-[length:var(--text-sm)] text-[color:var(--color-muted)]">{toast.description}</div>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick()
              onDismiss(toast.id)
            }}
            className="self-start text-[length:var(--text-sm)] text-[var(--color-ink)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)]"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)]"
      >
        <Icon name="cancel" size={16} />
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, { remaining: number; startedAt: number; handle: ReturnType<typeof setTimeout> | null }>())
  const paused = useRef(false)

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer?.handle) clearTimeout(timer.handle)
    timers.current.delete(id)
    setToasts((all) => all.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), EXIT_MS)
  }, [])

  const arm = useCallback(
    (id: number) => {
      const timer = timers.current.get(id)
      if (!timer || paused.current) return
      timer.startedAt = Date.now()
      timer.handle = setTimeout(() => remove(id), timer.remaining)
    },
    [remove],
  )

  const show = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++
      setToasts((all) => [{ ...input, id, leaving: false }, ...all])
      const duration = input.duration === undefined ? DEFAULT_DURATION : input.duration
      if (duration != null) {
        timers.current.set(id, { remaining: duration, startedAt: Date.now(), handle: null })
        arm(id)
      }
      return id
    },
    [arm],
  )

  const pause = () => {
    paused.current = true
    for (const timer of timers.current.values()) {
      if (timer.handle == null) continue
      clearTimeout(timer.handle)
      timer.handle = null
      timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt))
    }
  }

  const resume = () => {
    paused.current = false
    for (const id of timers.current.keys()) arm(id)
  }

  useEffect(() => {
    const all = timers.current
    return () => {
      for (const timer of all.values()) if (timer.handle) clearTimeout(timer.handle)
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({ show, dismiss: remove }), [show, remove])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          onPointerEnter={pause}
          onPointerLeave={resume}
          className="pointer-events-none fixed top-[calc(var(--header-height)+var(--spacing-lg))] right-[var(--spacing-lg)] z-50 flex flex-col gap-[var(--spacing-sm)]"
        >
          {toasts.slice(0, MAX_VISIBLE).map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={remove} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}
