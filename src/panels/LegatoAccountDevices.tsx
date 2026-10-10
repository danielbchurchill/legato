import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { AlertDialog } from '../ui/Dialog'
import { Shimmer, Skeleton } from '../ui/Skeleton'
import { formatSince } from '../connect/lastSeen'
import { LINK_CHANGED_EVENT } from '../connect/legatoLink'
import { readKnownServers } from '../connect/knownServers'
import {
  AccountRequestError,
  fetchAccountLists,
  removeServer,
  signOutSession,
  type AccountServer,
  type AccountSession,
} from '../auth/legatoAccount'
import { SettingsRow } from './SettingsPrimitives'

type Lists = { sessions: AccountSession[]; servers: AccountServer[] }

/* Issue #115: where the desktop app's legato.fm account is signed in, and
 * the servers it has linked, in Settings' legato.fm account group. Any other
 * session can be signed out here; this device's own signs out with the
 * account row's `sign out`. Removing a server takes the account's link to it
 * and its tunnel credential: the server shows it's disconnected from
 * legato.fm, and its owner links it again from its own Settings.
 *
 * A server's name is what this device remembers it calling itself
 * (knownServers.ts): legato.fm keeps no names. One this device has never
 * reached shows the start of its id. */
export function LegatoAccountDevices({ token, onSignedOut }: { token: string; onSignedOut: (notice: string) => void }) {
  const [lists, setLists] = useState<Lists | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<{ serverId: string; name: string } | null>(null)

  const failed = useCallback(
    (err: unknown) => {
      if (err instanceof AccountRequestError && err.signedOut) return onSignedOut(err.message)
      setError(err instanceof Error ? err.message : String(err))
    },
    [onSignedOut],
  )

  const load = useCallback(
    () =>
      fetchAccountLists(token).then((next) => {
        setLists(next)
        setError(null)
      }, failed),
    [token, failed],
  )

  // Linking this server again brings it back to the account's servers.
  useEffect(() => {
    void load()
    const reload = () => void load()
    window.addEventListener(LINK_CHANGED_EVENT, reload)
    return () => window.removeEventListener(LINK_CHANGED_EVENT, reload)
  }, [load])

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key)
    try {
      await run()
      await load()
    } catch (err) {
      failed(err)
    } finally {
      setBusy(null)
    }
  }

  if (!lists) {
    return error ? (
      <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
        <p className="min-w-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">{error}</p>
        <Button onClick={() => void load()}>try again</Button>
      </div>
    ) : (
      <Skeleton className="h-[12px] w-[180px] rounded-full" />
    )
  }

  const known = readKnownServers()

  return (
    <>
      <SettingsRow label="Signed in on" align="start">
        <ul className="flex flex-col gap-[var(--spacing-sm)]">
          {lists.sessions.map((session) => (
            <Item
              key={session.id}
              title={session.client ?? 'An earlier sign-in'}
              detail={
                session.current
                  ? 'this device'
                  : session.lastSeenAt
                    ? `last seen ${formatSince(session.lastSeenAt)}`
                    : `signed in ${formatSince(session.createdAt)}`
              }
              action={
                session.current ? null : (
                  <Button
                    disabled={busy !== null}
                    onClick={() => void act(`session:${session.id}`, () => signOutSession(token, session.id))}
                  >
                    {busy === `session:${session.id}` ? <Shimmer>signing out…</Shimmer> : 'sign out'}
                  </Button>
                )
              }
            />
          ))}
        </ul>
      </SettingsRow>

      <SettingsRow label="Servers" align="start">
        {lists.servers.length === 0 ? (
          <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
            No servers are linked to this account. A server's owner links it in its Settings, here.
          </p>
        ) : (
          <ul className="flex flex-col gap-[var(--spacing-sm)]">
            {lists.servers.map((server) => {
              const name = known[server.serverId]?.name ?? null
              return (
                <Item
                  key={server.serverId}
                  title={name ?? <span className="mono">{server.serverId.slice(0, 8)}…</span>}
                  detail={serverDetail(server)}
                  action={
                    <Button
                      disabled={busy !== null}
                      onClick={() => setRemoving({ serverId: server.serverId, name: name ?? 'This server' })}
                    >
                      {busy === `server:${server.serverId}` ? <Shimmer>removing…</Shimmer> : 'remove'}
                    </Button>
                  }
                />
              )
            })}
          </ul>
        )}
      </SettingsRow>

      {error && <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{error}</p>}

      <AlertDialog
        open={removing !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing!
          setRemoving(null)
          void act(`server:${target.serverId}`, () => removeServer(token, target.serverId))
        }}
        title="remove this server"
        description={
          <p>
            {removing?.name} won't open from this legato.fm account any more, and its connection to legato.fm closes. Its owner can link it
            again from its Settings.
          </p>
        }
        confirmLabel="remove"
        destructive
      />
    </>
  )
}

// Two lines, so neither is cut short in Settings' width: how legato.fm
// last heard from the server, then the day its credential was minted.
function serverDetail(server: AccountServer): string[] {
  const reach = server.tunnel.connected
    ? 'connected'
    : server.tunnel.lastSeenAt
      ? `last seen ${formatSince(server.tunnel.lastSeenAt)}`
      : 'never connected'
  const credential = server.credentialIssuedAt
    ? `credential from ${new Date(server.credentialIssuedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    : 'no credential'
  return [reach, credential]
}

function Item({ title, detail, action }: { title: ReactNode; detail: string | string[]; action: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-[var(--spacing-sm)]">
      <div className="min-w-0">
        <p className="truncate text-[length:var(--text-sm)] text-[var(--color-ink)]">{title}</p>
        {[detail].flat().map((line) => (
          <p key={line} className="truncate text-[length:var(--text-sm)] text-[color:var(--color-control)]">
            {line}
          </p>
        ))}
      </div>
      {action}
    </li>
  )
}
