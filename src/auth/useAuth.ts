import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '../config/serverHost'
import { AUTH_REQUIRED_EVENT, clearSession, readSession, storeSession } from './session'

export type AuthStatus = {
  ownerExists: boolean
  setupCodeRequired: boolean
  user: { role: 'owner' | 'legacy'; provider: string; displayName: string | null; email: string | null } | null
  oauth: { google: boolean; github: boolean }
}

export type AuthState =
  | { kind: 'checking' }
  | { kind: 'signed-in'; status: AuthStatus }
  | { kind: 'needs-owner'; status: AuthStatus }
  | { kind: 'needs-sign-in'; status: AuthStatus }
  | { kind: 'unreachable'; message: string }

export type SessionResponse = { token: string; mediaTicket: string }

function toState(status: AuthStatus): AuthState {
  if (status.user) return { kind: 'signed-in', status }
  return status.ownerExists ? { kind: 'needs-sign-in', status } : { kind: 'needs-owner', status }
}

/* Which of the three screens App.tsx shows once the server answers: create
 * the owner, sign in, or the app itself. Re-checks whenever a request
 * anywhere comes back 401 (session.ts fires AUTH_REQUIRED_EVENT), and on
 * window focus, which is how a Google/GitHub sign-in finished in its own
 * popup window gets noticed. */
export function useAuth() {
  const [state, setState] = useState<AuthState>({ kind: 'checking' })

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/status`)
      if (!res.ok) throw new Error(`auth status returned ${res.status}`)
      const status = (await res.json()) as AuthStatus
      // A token the server no longer recognizes (expired, signed out on
      // another device, a database restored from backup) is dropped here,
      // so the next request doesn't keep sending it.
      if (!status.user && readSession()) clearSession()
      setState(toState(status))
    } catch (err) {
      setState({ kind: 'unreachable', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  useEffect(() => {
    // Fetches sign-in status on mount; the state it sets comes from the server.
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh()
    const onAuthRequired = () => void refresh()
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    window.addEventListener('focus', onAuthRequired)
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
      window.removeEventListener('focus', onAuthRequired)
    }
  }, [refresh])

  const acceptSession = useCallback(
    (session: SessionResponse) => {
      storeSession({ token: session.token, mediaTicket: session.mediaTicket })
      void refresh()
    },
    [refresh],
  )

  return { state, refresh, acceptSession }
}

export async function signOut(): Promise<void> {
  await fetch(`${API_BASE}/auth/sign-out`, { method: 'POST' }).catch(() => undefined)
  clearSession()
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
}
