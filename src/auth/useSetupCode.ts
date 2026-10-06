import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config/serverHost'

/* The /setup page's live setup code (issue #113): what GET /auth/setup
 * returns, a countdown to its expiry, and a fresh fetch the moment it runs
 * out, so the page swaps in the server's new code without a reload (H9). */

export type SetupCodeState =
  | { kind: 'loading' }
  // replaced: the code on screen took over from one that expired while
  // this page was open, so the page says so instead of silently changing.
  | { kind: 'shown'; code: string; claimUrl: string; remainingMs: number; replaced: boolean }
  // The server won't show the code to this page (another network, behind a
  // proxy); message says where to find it instead.
  | { kind: 'hidden'; message: string }

type SetupCodeBody = { code?: string; expiresInMs?: number; claimUrl?: string; error?: string }

const TICK_MS = 1000

/** 9:58, for a countdown that never needs hours. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(Math.ceil(remainingMs / 1000), 0)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function useSetupCode(enabled: boolean) {
  const [state, setState] = useState<SetupCodeState>({ kind: 'loading' })
  // Deadline on this browser's own clock, made from the server's
  // expiresInMs when the answer arrived. A browser clock that's hours off
  // still counts down the right ten minutes.
  const deadline = useRef(0)
  const shownCode = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/setup`)
      const body = (await res.json().catch(() => ({}))) as SetupCodeBody
      if (!res.ok || !body.code || body.expiresInMs === undefined || !body.claimUrl) {
        setState({ kind: 'hidden', message: body.error ?? `The server returned ${res.status} for its setup code.` })
        return
      }
      const replaced = shownCode.current !== null && shownCode.current !== body.code
      shownCode.current = body.code
      deadline.current = Date.now() + body.expiresInMs
      setState({ kind: 'shown', code: body.code, claimUrl: body.claimUrl, remainingMs: body.expiresInMs, replaced })
    } catch {
      setState({ kind: 'hidden', message: "Couldn't ask the server for its setup code. It's also in the server's log." })
    }
  }, [])

  useEffect(() => {
    // Loads the setup code from the server once enabled.
    // oxlint-disable-next-line react/set-state-in-effect
    if (enabled) void load()
  }, [enabled, load])

  const shown = state.kind === 'shown'
  useEffect(() => {
    if (!shown) return
    const timer = window.setInterval(() => {
      const remainingMs = Math.max(deadline.current - Date.now(), 0)
      setState((current) => (current.kind === 'shown' ? { ...current, remainingMs } : current))
      // Past zero, and only once per code: the server replaces it on the
      // first read after expiry, so this fetch gets the new one. Pushing
      // the deadline out stops the next ticks refetching while it's in
      // flight.
      if (remainingMs === 0) {
        deadline.current = Date.now() + TICK_MS * 5
        void load()
      }
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [shown, load])

  return { state, reload: load }
}
