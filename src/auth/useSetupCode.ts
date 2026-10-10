import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config/serverHost'

/* The /setup page's live setup code (issue #113): what GET /auth/setup
 * returns, a countdown to its expiry, and a fresh fetch the moment it runs
 * out, so the page swaps in the server's new code without a reload (H9).
 *
 * Issue #237: while the code is on screen and legato.fm is on, the page
 * asks again every few seconds. Those check-ins are what let the server ask
 * legato.fm whether someone has claimed the code (server/src/auth/claim.ts),
 * so it stops asking when this page closes; each answer says where the
 * claim stands. */

// The server's ClaimView. email is masked by the server (r•••@example.com).
// busy (issue #324): legato.fm asked the server to wait before asking again.
// A server from before then doesn't send it.
export type ClaimAccount = { id: string; name: string | null; email: string | null }
export type ClaimView =
  | { state: 'waiting'; unreachable: boolean; busy?: boolean }
  | { state: 'claimed'; account: ClaimAccount; expiresInMs: number }
  | { state: 'lapsed'; account: ClaimAccount }
  | { state: 'used' }
  | { state: 'expired' }
  | { state: 'refused'; message: string }

export type SetupCodeState =
  | { kind: 'loading' }
  // replaced: the code on screen took over from one that expired while
  // this page was open, so the page says so instead of silently changing.
  // claimUrl and claim are null when the server has legato.fm turned off.
  | {
      kind: 'shown'
      code: string
      claimUrl: string | null
      remainingMs: number
      replaced: boolean
      claim: ClaimView | null
    }
  // The server won't show the code to this page (another network, behind a
  // proxy); message says where to find it instead.
  | { kind: 'hidden'; message: string }

type SetupCodeBody = {
  code?: string
  expiresInMs?: number
  claimUrl?: string | null
  claim?: ClaimView | null
  error?: string
}

const TICK_MS = 1000
const CHECK_IN_MS = 3000

/** 9:58, for a countdown that never needs hours. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(Math.ceil(remainingMs / 1000), 0)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function useSetupCode(enabled: boolean) {
  const [state, setState] = useState<SetupCodeState>({ kind: 'loading' })
  // Deadlines on this browser's own clock, made from the server's
  // expiresInMs when the answer arrived. A browser clock that's hours off
  // still counts down the right ten minutes.
  const deadline = useRef(0)
  const claimDeadline = useRef(0)
  const shownCode = useRef<string | null>(null)
  const replaced = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/setup`)
      const body = (await res.json().catch(() => ({}))) as SetupCodeBody
      if (!res.ok || !body.code || body.expiresInMs === undefined) {
        setState({ kind: 'hidden', message: body.error ?? `The server returned ${res.status} for its setup code.` })
        return
      }
      if (shownCode.current !== null && shownCode.current !== body.code) replaced.current = true
      shownCode.current = body.code
      deadline.current = Date.now() + body.expiresInMs
      const claim = body.claim ?? null
      if (claim?.state === 'claimed') claimDeadline.current = Date.now() + claim.expiresInMs
      setState({
        kind: 'shown',
        code: body.code,
        claimUrl: body.claimUrl ?? null,
        remainingMs: body.expiresInMs,
        replaced: replaced.current,
        claim,
      })
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
  const claiming = shown && state.claimUrl !== null
  useEffect(() => {
    if (!shown) return
    const timer = window.setInterval(() => {
      const remainingMs = Math.max(deadline.current - Date.now(), 0)
      setState((current) => {
        if (current.kind !== 'shown') return current
        const claim =
          current.claim?.state === 'claimed'
            ? { ...current.claim, expiresInMs: Math.max(claimDeadline.current - Date.now(), 0) }
            : current.claim
        return { ...current, remainingMs, claim }
      })
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

  useEffect(() => {
    if (!claiming) return
    const timer = window.setInterval(() => void load(), CHECK_IN_MS)
    return () => window.clearInterval(timer)
  }, [claiming, load])

  return { state, reload: load }
}
