import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Button } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import { IS_TAURI } from '../config/runtime'
import { SettingsGroup } from './SettingsPrimitives'
import {
  clearRelaySession,
  fetchRelayMe,
  readRelaySession,
  RelaySignInError,
  relaySignOut,
  signInWithRelay,
  type RelayMe,
  type RelayProvider,
  type RelayUser,
} from '../auth/relaySession'

// Matches OPEN_FAILED_EVENT in src-tauri/src/relay_sign_in.rs.
const OPEN_FAILED_EVENT = 'relay-sign-in://open-failed'

const PROVIDER_LABELS: Record<RelayProvider, string> = { google: 'Google', github: 'GitHub' }

type RowState =
  | { kind: 'loading' }
  | { kind: 'signed-out'; configured: RelayMe['configured'] | null; notice: string | null }
  | { kind: 'waiting'; provider: RelayProvider; manualUrl: { message: string; url: string } | null }
  | { kind: 'signed-in'; user: RelayUser }

/* The desktop app's legato.fm account (issue #215), as distinct from the
 * home server's own account in the group above it: who this app is signed in
 * to legato.fm as, and the Google/GitHub sign-in that gets it there.
 * Signing in opens the system browser through the Rust loopback listener
 * (src-tauri/src/relay_sign_in.rs); see src/auth/relaySession.ts for the
 * flow. Nothing uses this session yet; #114 is what makes it reach a home
 * server. */
export function LegatoAccountRow() {
  const [state, setState] = useState<RowState>({ kind: 'loading' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!IS_TAURI) return
    let cancelled = false
    const token = readRelaySession()?.token ?? null
    fetchRelayMe(token)
      .then((me) => {
        if (cancelled) return
        if (me.user) return setState({ kind: 'signed-in', user: me.user })
        // A token the relay no longer recognizes (expired, signed out on
        // the web) is dropped here rather than sent again.
        if (token) clearRelaySession()
        setState({
          kind: 'signed-out',
          configured: me.configured,
          notice: token ? 'Your legato.fm session ended. Sign in again.' : null,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({ kind: 'signed-out', configured: null, notice: null })
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The Rust side keeps listening when the browser won't open, so the
  // address shown here still finishes the sign-in if pasted by hand.
  useEffect(() => {
    if (!IS_TAURI) return
    const unlisten = listen<{ message: string; url: string }>(OPEN_FAILED_EVENT, (event) => {
      setState((s) => (s.kind === 'waiting' ? { ...s, manualUrl: event.payload } : s))
    })
    return () => void unlisten.then((stop) => stop())
  }, [])

  const configured = state.kind === 'signed-out' ? state.configured : null

  const signIn = async (provider: RelayProvider) => {
    setError(null)
    setState({ kind: 'waiting', provider, manualUrl: null })
    try {
      const user = await signInWithRelay(provider, { invoke })
      setState({ kind: 'signed-in', user })
    } catch (err) {
      setState({ kind: 'signed-out', configured, notice: null })
      // Cancelling from this row is the user's own choice, not an error.
      if (err instanceof RelaySignInError && err.kind === 'cancelled') return
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const signOut = async () => {
    setError(null)
    await relaySignOut()
    setState({ kind: 'signed-out', configured: null, notice: null })
  }

  return (
    <SettingsGroup title="legato.fm account">
      {!IS_TAURI && (
        <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
          Sign in to legato.fm from the Legato desktop app.
        </p>
      )}

      {IS_TAURI && state.kind === 'loading' && <Skeleton className="h-[12px] w-[140px] rounded-full" />}

      {state.kind === 'signed-in' && (
        <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
          <div className="flex min-w-0 items-center gap-[var(--spacing-sm)]">
            {state.user.avatarUrl && <img src={state.user.avatarUrl} alt="" className="h-[24px] w-[24px] shrink-0 rounded-full" />}
            <div className="min-w-0">
              <p
                className="truncate text-[length:var(--text-sm)] text-[var(--color-ink)]"
                title={state.user.displayName ?? state.user.email ?? undefined}
              >
                {state.user.displayName ?? state.user.email ?? 'signed in'}
              </p>
              <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                signed in with {PROVIDER_LABELS[state.user.provider]}
              </p>
            </div>
          </div>
          <Button onClick={() => void signOut()}>sign out</Button>
        </div>
      )}

      {state.kind === 'waiting' && (
        <div className="flex flex-col gap-[var(--spacing-xs)]">
          <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
            <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
              Finish signing in with {PROVIDER_LABELS[state.provider]} in your browser.
            </p>
            <Button onClick={() => void invoke('relay_sign_in_cancel')}>cancel</Button>
          </div>
          {state.manualUrl && (
            <>
              <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{state.manualUrl.message}</p>
              <p className="break-all text-[length:var(--text-sm)] text-[var(--color-ink)] select-all">{state.manualUrl.url}</p>
            </>
          )}
        </div>
      )}

      {state.kind === 'signed-out' && (
        <>
          {state.notice && <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{state.notice}</p>}
          <div className="flex items-center gap-[var(--spacing-lg)]">
            {(['google', 'github'] as const).map((provider) => (
              <Button
                key={provider}
                disabled={state.configured?.[provider] === false}
                onClick={() => void signIn(provider)}
              >
                sign in with {PROVIDER_LABELS[provider]}
              </Button>
            ))}
          </div>
          {state.configured && (!state.configured.google || !state.configured.github) && (
            <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
              {(['google', 'github'] as const)
                .filter((p) => !state.configured![p])
                .map((p) => PROVIDER_LABELS[p])
                .join(' and ')}{' '}
              sign-in isn't set up on this legato.fm service.
            </p>
          )}
        </>
      )}

      {error && <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{error}</p>}
    </SettingsGroup>
  )
}
