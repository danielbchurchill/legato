import { useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import whiteWordmarkSrc from '../assets/brand/white-wordmark.svg'
import blackWordmarkSrc from '../assets/brand/black-wordmark.svg'
import { storeSession, type StoredSession } from '../auth/session'
import {
  clearRelaySession,
  fetchRelayMe,
  readRelaySession,
  RelaySignInError,
  signInWithRelay,
  type RelayProvider,
} from '../auth/relaySession'
import { IS_TAURI } from '../config/runtime'
import { DEFAULT_SERVER_ORIGIN, SERVED_BY_SERVER, SERVER_ORIGIN } from '../config/serverHost'
import type { ResolvedTheme } from '../hooks/useTheme'
import { Button } from '../ui/Button'
import { SectionLabel } from '../ui/SectionLabel'
import { Spinner } from '../ui/Spinner'
import { StatusDot, type Status } from '../ui/StatusDot'
import { TextField } from '../ui/TextField'
import { originFor } from './address'
import { useDiscoveredServers, useYourServers, type Discovery, type YourServers } from './hooks'
import { verifyServerIdentity } from './identity'
import { rememberServer } from './knownServers'
import { formatSince } from './lastSeen'
import { describeLegatoFailure, signInWithLegato } from './legatoSignIn'
import type { ConnectReason } from './openConnect'
import { probeAddress, type NativeProbe } from './probe'
import { clearServerChoice, storeServerChoice } from './serverChoice'
import type { FoundServer, Reach } from './yourServers'

/* The connect screen (issue #117, plan 03's "Connecting a client"): which
 * Legato server this client talks to. Three ways to pick one, top to
 * bottom from least typing to most:
 *   1. on this network: servers advertising _legato._tcp, which the desktop
 *      app browses natively (src-tauri/src/discovery.rs). A browser can't,
 *      and says so rather than showing an empty list;
 *   2. your servers: the legato.fm account's linked servers, each marked at
 *      home or offline since … (yourServers.ts). legato.fm sign-in lives
 *      in the desktop app, so a browser says that too;
 *   3. an address: anything typed, checked first, with an error that says
 *      what's wrong (probe.ts).
 *
 * It takes over the window like the sign-in screens (OwnerGate.tsx), on the
 * bare canvas, from src/ui's controls. Connecting stores the choice and
 * reloads (serverChoice.ts); a page a server served opens the other
 * server's own page instead. Before a legato.fm access token goes to any
 * server, the server proves it holds its id's key (identity.ts). */

type Row = {
  key: string
  name: string
  detail: ReactNode
  status: Status
  action?: { label: string; onClick: () => void; busy?: boolean; disabled?: boolean }
  error?: string | null
}

export type RelayAccount =
  | { kind: 'unsupported' }
  | { kind: 'checking' }
  | { kind: 'signed-out'; configured: Record<RelayProvider, boolean> | null; waiting: RelayProvider | null; error?: string | null }
  | { kind: 'signed-in'; name: string }

export type ConnectScreenViewProps = {
  theme: ResolvedTheme
  reason: ConnectReason
  currentLabel: string
  network: Discovery
  networkRows: Row[]
  account: RelayAccount
  yours: YourServers
  yourRows: Row[]
  address: string
  addressBusy: boolean
  addressError: string | null
  onAddressChange: (value: string) => void
  onConnectAddress: () => void
  onRelaySignIn: (provider: RelayProvider) => void
  onRelayCancel: () => void
  onRetryYours: () => void
  onUseDefault: (() => void) | null
  onClose: (() => void) | null
}

const PROVIDER_LABELS: Record<RelayProvider, string> = { google: 'Google', github: 'GitHub' }

function ServerRow({ row }: { row: Row }) {
  return (
    <li className="flex flex-col gap-[6px] rounded-[var(--radius-card)] bg-[var(--color-wash)] px-[14px] py-[10px]">
      <div className="flex items-center gap-[12px]">
        <StatusDot status={row.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--text-body)] text-[var(--color-ink)]" title={row.name}>
            {row.name}
          </p>
          <p className="truncate text-small text-[var(--color-ink-2)]">{row.detail}</p>
        </div>
        {row.action && (
          <Button variant="secondary" size="sm" onClick={row.action.onClick} disabled={row.action.disabled || row.action.busy}>
            {row.action.busy ? 'connecting…' : row.action.label}
          </Button>
        )}
      </div>
      {row.error && (
        <p role="alert" className="pl-[20px] text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">
          {row.error}
        </p>
      )}
    </li>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[length:var(--text-secondary)] [text-wrap:pretty] text-[var(--color-ink-2)]">{children}</p>
}

const MAC = typeof navigator !== 'undefined' && /Macintosh/.test(navigator.userAgent)

function NetworkSection({ network, rows }: { network: Discovery; rows: Row[] }) {
  let body: ReactNode
  if (!network.supported) {
    body = (
      <Note>
        A browser can't look for servers on the network. The Legato desktop app finds them by itself; here, type the
        server's address below.
      </Note>
    )
  } else if (network.error) {
    body = <Note>{network.error}</Note>
  } else if (rows.length > 0) {
    body = (
      <ul className="flex flex-col gap-[8px]">
        {rows.map((row) => (
          <ServerRow key={row.key} row={row} />
        ))}
      </ul>
    )
  } else if (network.servers === null) {
    body = (
      <div className="flex items-center gap-[8px] text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">
        <Spinner size={14} />
        Looking for Legato servers on this network…
      </div>
    )
  } else {
    body = (
      <Note>
        No Legato server has answered on this network yet. A server appears here once it's running on the same network
        as this computer.
        {MAC && ' If you turned down Legato’s request to find devices, allow it in System Settings → Privacy & Security → Local Network.'}
      </Note>
    )
  }
  return (
    <section className="flex flex-col gap-[12px]">
      <SectionLabel>on this network</SectionLabel>
      {body}
    </section>
  )
}

function YoursSection(props: {
  account: RelayAccount
  yours: YourServers
  rows: Row[]
  onRelaySignIn: (provider: RelayProvider) => void
  onRelayCancel: () => void
  onRetry: () => void
}) {
  const { account, yours, rows } = props
  let body: ReactNode
  if (account.kind === 'unsupported' || yours.kind === 'unsupported') {
    body = (
      <Note>
        Signing in to legato.fm is in the Legato desktop app for now, so a browser can't list your account's servers. Type
        a server's address below instead.
      </Note>
    )
  } else if (account.kind === 'checking' || (account.kind === 'signed-in' && yours.kind === 'loading')) {
    body = (
      <div className="flex items-center gap-[8px] text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">
        <Spinner size={14} />
        Asking legato.fm for your servers…
      </div>
    )
  } else if (account.kind === 'signed-out' || yours.kind === 'signed-out') {
    const configured = account.kind === 'signed-out' ? account.configured : null
    const waiting = account.kind === 'signed-out' ? account.waiting : null
    const error = account.kind === 'signed-out' ? account.error : null
    body = (
      <>
        {waiting ? (
          <div className="flex items-center justify-between gap-[12px]">
            <Note>Finish signing in with {PROVIDER_LABELS[waiting]} in your browser.</Note>
            <Button onClick={props.onRelayCancel}>cancel</Button>
          </div>
        ) : (
          <Note>Sign in to legato.fm to see the servers linked to your account, and open them without a password.</Note>
        )}
        {!waiting && (
          <div className="flex items-center gap-[var(--spacing-lg)]">
            {(['google', 'github'] as const).map((provider) => (
              <Button key={provider} disabled={configured?.[provider] === false} onClick={() => props.onRelaySignIn(provider)}>
                sign in with {PROVIDER_LABELS[provider]}
              </Button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">
            {error}
          </p>
        )}
      </>
    )
  } else if (yours.kind === 'error') {
    body = (
      <div className="flex items-center justify-between gap-[12px]">
        <Note>{yours.message}</Note>
        <Button onClick={props.onRetry}>try again</Button>
      </div>
    )
  } else if (rows.length === 0) {
    body = (
      <Note>
        No servers are linked to your legato.fm account yet. A server's owner links it in Legato's Settings, under
        legato.fm account.
      </Note>
    )
  } else {
    body = (
      <ul className="flex flex-col gap-[8px]">
        {rows.map((row) => (
          <ServerRow key={row.key} row={row} />
        ))}
      </ul>
    )
  }
  return (
    <section className="flex flex-col gap-[12px]">
      <SectionLabel action={account.kind === 'signed-in' ? <span className="text-small text-[var(--color-ink-3)]">{account.name}</span> : undefined}>
        your servers
      </SectionLabel>
      {body}
    </section>
  )
}

export function ConnectScreenView(props: ConnectScreenViewProps) {
  const heading =
    props.reason === 'unreachable'
      ? `Can't reach ${props.currentLabel}`
      : props.reason === 'signed-out'
        ? 'Connect to a different server'
        : 'Connect to a server'
  return (
    <div className="fixed inset-0 overflow-y-auto bg-[var(--color-canvas)] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-full max-w-[480px] flex-col gap-[28px] px-[24px] py-[56px]">
        <div className="flex flex-col items-center gap-[14px] text-center">
          <img
            src={props.theme === 'light' ? blackWordmarkSrc : whiteWordmarkSrc}
            alt="legato"
            className="h-[var(--text-wordmark)] w-auto select-none"
          />
          <h1 className="text-title text-[var(--color-ink)]">{heading}</h1>
          <p className="text-[15px] leading-[22px] [text-wrap:pretty] text-[var(--color-ink-2)]">
            {props.reason === 'unreachable'
              ? 'Pick another server, or check that this one is running and on your network.'
              : `Now using ${props.currentLabel}. Pick a server on this network, one of yours, or type its address.`}
          </p>
        </div>

        <NetworkSection network={props.network} rows={props.networkRows} />
        <YoursSection
          account={props.account}
          yours={props.yours}
          rows={props.yourRows}
          onRelaySignIn={props.onRelaySignIn}
          onRelayCancel={props.onRelayCancel}
          onRetry={props.onRetryYours}
        />

        <section className="flex flex-col gap-[12px]">
          <SectionLabel>an address</SectionLabel>
          <form
            className="flex items-center gap-[10px]"
            onSubmit={(e) => {
              e.preventDefault()
              props.onConnectAddress()
            }}
          >
            <TextField
              value={props.address}
              onChange={props.onAddressChange}
              label="Server address"
              placeholder="192.168.1.20, musicbox.local or https://…"
              className="flex-1"
            />
            <Button type="submit" variant="primary" disabled={props.addressBusy || !props.address.trim()}>
              {props.addressBusy ? 'checking…' : 'connect'}
            </Button>
          </form>
          {props.addressError ? (
            <p role="alert" className="text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">
              {props.addressError}
            </p>
          ) : (
            <span className="text-small text-[var(--color-ink-3)]">
              An IP address, a name on your network, or your own domain. Without a port, Legato tries 8899.
            </span>
          )}
        </section>

        {(props.onUseDefault || props.onClose) && (
          <div className="flex items-center justify-center gap-[var(--spacing-lg)] pt-[4px]">
            {props.onUseDefault && <Button onClick={props.onUseDefault}>use this computer's server</Button>}
            {props.onClose && <Button onClick={props.onClose}>back</Button>}
          </div>
        )}
      </div>
    </div>
  )
}

function hostOf(origin: string): string {
  return new URL(origin).host
}

function reachRow(reach: Reach): { status: Status; detail: ReactNode } {
  switch (reach.kind) {
    case 'checking':
      return { status: 'idle', detail: 'checking…' }
    case 'home':
      return {
        status: 'ok',
        detail: (
          <>
            at home · <span className="mono">{hostOf(reach.origin)}</span>
          </>
        ),
      }
    case 'offline':
      return {
        status: 'idle',
        detail: reach.since ? `offline since ${formatSince(reach.since)}` : 'offline · not reached from this device yet',
      }
  }
}

/** Where connecting goes: the chosen server is stored and the page reloads
 * onto it, with a legato.fm session already in place when there is one. */
function goTo(origin: string, session?: StoredSession): void {
  if (session) storeSession(session, localStorage, origin)
  if (SERVED_BY_SERVER) {
    window.location.assign(`${origin}/`)
    return
  }
  if (origin === DEFAULT_SERVER_ORIGIN) clearServerChoice()
  else storeServerChoice(origin)
  window.location.reload()
}

const nativeProbe = IS_TAURI ? (origin: string) => invoke<NativeProbe>('probe_server', { origin }) : null

export function ConnectScreen({ theme, reason, onClose }: { theme: ResolvedTheme; reason: ConnectReason; onClose: (() => void) | null }) {
  const network = useDiscoveredServers()
  const [account, setAccount] = useState<RelayAccount>(() =>
    !IS_TAURI ? { kind: 'unsupported' } : readRelaySession() ? { kind: 'checking' } : { kind: 'signed-out', configured: null, waiting: null },
  )
  const { state: yours, reload: reloadYours } = useYourServers(network, account.kind === 'signed-in')
  const [address, setAddress] = useState('')
  const [addressBusy, setAddressBusy] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!IS_TAURI) return
    let cancelled = false
    const token = readRelaySession()?.token ?? null
    fetchRelayMe(token)
      .then((me) => {
        if (cancelled) return
        if (me.user) setAccount({ kind: 'signed-in', name: me.user.displayName ?? me.user.email ?? 'legato.fm' })
        else {
          if (token) clearRelaySession()
          setAccount({ kind: 'signed-out', configured: me.configured, waiting: null })
        }
      })
      .catch(() => {
        if (!cancelled) setAccount({ kind: 'signed-out', configured: null, waiting: null })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const linkedIds = new Set(yours.kind === 'listed' ? yours.servers.map((s) => s.serverId) : [])
  const signedIn = account.kind === 'signed-in'

  // Connect to a server that just proved its id: with legato.fm when it's
  // one of the account's, otherwise straight to its own sign-in screen.
  const connectVerified = async (key: string, origin: string, serverId: string, name: string) => {
    rememberServer(serverId, { origin, name })
    if (!signedIn || !linkedIds.has(serverId)) return goTo(origin)
    const result = await signInWithLegato(origin, serverId)
    if (result.ok) return goTo(origin, result.session)
    setRowErrors((e) => ({ ...e, [key]: describeLegatoFailure(result.failure, name) }))
  }

  const connectFound = async (server: FoundServer) => {
    setBusyKey(server.instance)
    setRowErrors((e) => ({ ...e, [server.instance]: '' }))
    try {
      const origins = server.addresses.map((a) => originFor(a, server.port))
      if (!server.id) {
        // A server too old to advertise its id: nothing to check it against,
        // and nothing but its own sign-in screen to send it.
        if (origins[0]) goTo(origins[0])
        return
      }
      for (const origin of origins) {
        if ((await verifyServerIdentity(origin, server.id)).ok) return await connectVerified(server.instance, origin, server.id, server.name)
      }
      setRowErrors((e) => ({
        ...e,
        [server.instance]: `${server.name} didn't prove it's the server it advertises, at any of its addresses, so Legato didn't connect.`,
      }))
    } finally {
      setBusyKey(null)
    }
  }

  const connectYours = async (serverId: string, name: string, origin: string) => {
    setBusyKey(serverId)
    setRowErrors((e) => ({ ...e, [serverId]: '' }))
    try {
      const result = await signInWithLegato(origin, serverId)
      if (result.ok) return goTo(origin, result.session)
      setRowErrors((e) => ({ ...e, [serverId]: describeLegatoFailure(result.failure, name) }))
    } finally {
      setBusyKey(null)
    }
  }

  const connectAddress = async () => {
    setAddressBusy(true)
    setAddressError(null)
    try {
      const outcome = await probeAddress(address, { native: nativeProbe })
      if (!outcome.ok) return setAddressError(outcome.message)
      const status = (await fetch(`${outcome.origin}/api/v1/auth/status`, { credentials: 'omit' })
        .then((r) => r.json())
        .catch(() => null)) as { legato?: { serverId?: string } } | null
      const serverId = status?.legato?.serverId
      if (!serverId) return goTo(outcome.origin)
      const identity = await verifyServerIdentity(outcome.origin, serverId)
      if (!identity.ok) {
        return setAddressError(
          `${hostOf(outcome.origin)} answered as a Legato server but couldn't prove which one, so Legato didn't connect.`,
        )
      }
      rememberServer(serverId, { origin: outcome.origin, name: outcome.name })
      if (!signedIn || !linkedIds.has(serverId)) return goTo(outcome.origin)
      const result = await signInWithLegato(outcome.origin, serverId)
      if (result.ok) return goTo(outcome.origin, result.session)
      setAddressError(describeLegatoFailure(result.failure, outcome.name ?? hostOf(outcome.origin)))
    } finally {
      setAddressBusy(false)
    }
  }

  const relaySignIn = async (provider: RelayProvider) => {
    const configured = account.kind === 'signed-out' ? account.configured : null
    setAccount({ kind: 'signed-out', configured, waiting: provider })
    try {
      const user = await signInWithRelay(provider, { invoke })
      setAccount({ kind: 'signed-in', name: user.displayName ?? user.email ?? 'legato.fm' })
      reloadYours()
    } catch (err) {
      // Cancelling is the user's own choice, not an error.
      const cancelled = err instanceof RelaySignInError && err.kind === 'cancelled'
      setAccount({ kind: 'signed-out', configured, waiting: null, error: cancelled ? null : err instanceof Error ? err.message : String(err) })
    }
  }

  const found = network.supported ? (network.servers ?? []) : []
  const networkRows: Row[] = found.map((server) => {
    const here = server.addresses.some((a) => originFor(a, server.port) === SERVER_ORIGIN)
    return {
      key: server.instance,
      name: server.name,
      status: here ? 'accent' : 'ok',
      detail: (
        <>
          <span className="mono">{server.addresses[0] ? hostOf(originFor(server.addresses[0], server.port)) : server.instance}</span>
          {server.version && (
            <>
              {' · '}
              <span className="mono">{server.version}</span>
            </>
          )}
          {here && ' · in use'}
        </>
      ),
      action: here ? undefined : { label: 'connect', onClick: () => void connectFound(server), busy: busyKey === server.instance },
      error: rowErrors[server.instance] || null,
    }
  })

  const yourRows: Row[] =
    yours.kind === 'listed'
      ? yours.servers.map(({ serverId, name, reach }) => {
          const { status, detail } = reachRow(reach)
          const here = reach.kind === 'home' && reach.origin === SERVER_ORIGIN
          return {
            key: serverId,
            name,
            status: here ? 'accent' : status,
            detail: here ? <>{detail} · in use</> : detail,
            action:
              reach.kind === 'home' && !here
                ? { label: 'connect', onClick: () => void connectYours(serverId, name, reach.origin), busy: busyKey === serverId }
                : undefined,
            error: rowErrors[serverId] || null,
          }
        })
      : []

  const usingDefault = SERVER_ORIGIN === DEFAULT_SERVER_ORIGIN
  return (
    <ConnectScreenView
      theme={theme}
      reason={reason}
      currentLabel={IS_TAURI && usingDefault ? "this computer's server" : hostOf(SERVER_ORIGIN)}
      network={network}
      networkRows={networkRows}
      account={account}
      yours={yours}
      yourRows={yourRows}
      address={address}
      addressBusy={addressBusy}
      addressError={addressError}
      onAddressChange={setAddress}
      onConnectAddress={() => void connectAddress()}
      onRelaySignIn={(provider) => void relaySignIn(provider)}
      onRelayCancel={() => void invoke('relay_sign_in_cancel')}
      onRetryYours={reloadYours}
      onUseDefault={!SERVED_BY_SERVER && !usingDefault ? () => goTo(DEFAULT_SERVER_ORIGIN) : null}
      onClose={onClose}
    />
  )
}
