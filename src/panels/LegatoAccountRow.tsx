import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Button } from '../ui/Button'
import { Shimmer, Skeleton } from '../ui/Skeleton'
import { IS_TAURI } from '../config/runtime'
import { API_BASE } from '../config/serverHost'
import { useAccount } from '../auth/accountContext'
import type { AuthStatus } from '../auth/useAuth'
import { describeLinkFailure, LINK_CHANGED_EVENT, linkWithLegato } from '../connect/legatoLink'
import { startBrowserLink } from '../connect/legatoLinkReturn'
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
 * flow.
 *
 * Under it, in the desktop app and the web client alike, whether this server
 * is linked to legato.fm and the way for its owner to link it (issue #325,
 * ServerLink below). */
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

      <ServerLink relaySignedIn={state.kind === 'signed-in'} />
    </SettingsGroup>
  )
}

type LinkStatus = { serverId: string; issuer: string | null; linked: boolean }

/** This server's id, which legato.fm it trusts, and whether the signed-in
 * user is linked there; again whenever a link finishes elsewhere. */
function useLinkStatus(): { status: LinkStatus | null | 'unavailable'; reload: () => void } {
  const [status, setStatus] = useState<LinkStatus | null | 'unavailable'>(null)
  const reload = useCallback(() => {
    fetch(`${API_BASE}/auth/status`)
      .then((r) => r.json() as Promise<AuthStatus>)
      .then(({ legato }) =>
        setStatus(legato ? { serverId: legato.serverId, issuer: legato.issuer ?? null, linked: legato.linked === true } : 'unavailable'),
      )
      .catch(() => setStatus('unavailable'))
  }, [])
  useEffect(() => {
    reload()
    window.addEventListener(LINK_CHANGED_EVENT, reload)
    return () => window.removeEventListener(LINK_CHANGED_EVENT, reload)
  }, [reload])
  return { status, reload }
}

/* Issue #325: linking this server to legato.fm from Settings, for a server
 * whose owner was created without a claim, or whose first link failed, or
 * that legato.fm stopped vouching for ("link again"). Both clients end at the
 * server's own link endpoint (src/connect/legatoLink.ts). The desktop app
 * asks legato.fm with the session above; the web client can't hold one, so
 * it goes to legato.fm's /link page and comes back (legatoLinkReturn.ts). */
function ServerLink({ relaySignedIn }: { relaySignedIn: boolean }) {
  const account = useAccount()
  const { status, reload } = useLinkStatus()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Back from legato.fm with the browser's back button, the page can come
  // back from the back-forward cache exactly as it left: still linking.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false)
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  if (status === null) return <Skeleton className="h-[12px] w-[200px] rounded-full" />
  // A server from before #114 has no legato.fm identity to link.
  if (status === 'unavailable') return null

  const owner = account?.role === 'owner'
  const { issuer } = status
  const said =
    issuer === null
      ? "legato.fm is turned off on this server, so it can't be linked."
      : status.linked
        ? 'This server is linked to legato.fm.'
        : "This server isn't linked to a legato.fm account yet."
  const hint =
    issuer === null ? null : !owner ? "Only this server's owner can link it." : IS_TAURI && !relaySignedIn ? 'Sign in to legato.fm to link it.' : null
  const canLink = issuer !== null && owner && (!IS_TAURI || relaySignedIn)

  const link = async () => {
    setNotice(null)
    setBusy(true)
    // The web client leaves for legato.fm here and comes back to the app.
    if (!IS_TAURI) return startBrowserLink(status.serverId, issuer!)
    const result = await linkWithLegato(status.serverId)
    setBusy(false)
    if (!result.ok) return setNotice(describeLinkFailure(result.failure))
    setNotice(`Linked to ${result.linked.name ?? result.linked.email ?? 'your legato.fm account'}.`)
    reload()
  }

  return (
    <>
      <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
        <p className="min-w-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">
          {said}
          {hint && ` ${hint}`}
        </p>
        {canLink && (
          <Button onClick={() => void link()} disabled={busy}>
            {busy ? <Shimmer>linking…</Shimmer> : status.linked ? 'link again' : 'link to legato.fm'}
          </Button>
        )}
      </div>
      {notice && <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{notice}</p>}
    </>
  )
}
