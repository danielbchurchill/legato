import { useCallback, useEffect, useState } from 'react'
import { API_BASE, SERVER_ORIGIN } from '../config/serverHost'
import { rememberServer } from '../connect/knownServers'
import { renewLegatoSession } from '../connect/legatoSignIn'
import { AUTH_REQUIRED_EVENT, clearSession, readSession, storeSession } from './session'

export type AuthStatus = {
  ownerExists: boolean
  setupCodeRequired: boolean
  user: { role: 'owner' | 'legacy'; provider: string; displayName: string | null; email: string | null } | null
  oauth: { google: boolean; github: boolean }
  legato?: { serverId: string } | null
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

// What /auth/status says, as the screen to show.
async function loadAuthState(mayRenew: boolean): Promise<AuthState> {
  try {
    const res = await fetch(`${API_BASE}/auth/status`)
    if (!res.ok) throw new Error(`auth status returned ${res.status}`)
    const status = (await res.json()) as AuthStatus
    // A legato.fm session that ran out (the device slept through its
    // renewal, #117) gets one more try through legato.fm before the
    // sign-in screen.
    if (!status.user && mayRenew && readSession()?.legato && (await renewLegatoSession(SERVER_ORIGIN))) {
      return loadAuthState(false)
    }
    // A token the server no longer recognizes (expired, signed out on
    // another device, a database restored from backup) is dropped here,
    // so the next request doesn't keep sending it.
    if (!status.user && readSession()) clearSession()
    // #117: when and where this device last reached this server, for the
    // connect screen's "your servers".
    if (status.legato?.serverId) {
      const serverId = status.legato.serverId
      void fetch(`${API_BASE}/health`)
        .then((r) => r.json() as Promise<{ name?: string }>)
        .then((health) => rememberServer(serverId, { origin: SERVER_ORIGIN, name: health.name ?? null }))
        .catch(() => rememberServer(serverId, { origin: SERVER_ORIGIN }))
    }
    return toState(status)
  } catch (err) {
    return { kind: 'unreachable', message: err instanceof Error ? err.message : String(err) }
  }
}

/* Which of the three screens App.tsx shows once the server answers: create
 * the owner, sign in, or the app itself. Re-checks whenever a request
 * anywhere comes back 401 (session.ts fires AUTH_REQUIRED_EVENT), and on
 * window focus, which is how a Google/GitHub sign-in finished in its own
 * popup window gets noticed. */
export function useAuth() {
  const [state, setState] = useState<AuthState>({ kind: 'checking' })

  const refresh = useCallback(async () => {
    setState(await loadAuthState(true))
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
