import { useMemo, type ReactNode } from 'react'
import { RELAY_SERVER_ID, SERVED_SERVER_ID, SERVER_HOST } from '../config/serverHost'
import type { ServerVersion } from '../hooks/useServerReady'
import { IconButton } from '../ui/IconButton'
import { INSET, useShellLayout } from './layout'
import { dismissUpdate, UpdateOfferContext, useUpdateOffer, type UpdateOffer } from './serverUpdate'

const PILL = 'rounded-full glass px-[16px] py-[6px] text-[length:var(--text-base)] text-[var(--color-muted)]'

/* The line that says this client needs a newer server (issue #193).
 *
 * A client newer than its server calls routes and reads fields that aren't
 * there yet, which otherwise just looks like a bug somewhere in the app. So
 * this names the server, says what it's running, and says what to do —
 * H9's recognise/diagnose/recover in one sentence — then stays out of the
 * way: muted Rubik (it's the app talking, not library data), a small glass
 * pill at the top of the window, and pointer-events off so it never sits
 * on top of a click meant for the graph. It stays up for as long as the
 * heartbeat keeps reporting an old server, and goes away by itself once the
 * server is updated. It can't be dismissed, since the app misbehaves
 * against a server that old. App.tsx mounts it over every layout, the sign-in
 * screen included. */
export function ServerUpdateNotice({ server }: { server: ServerVersion | null }) {
  if (!server?.outOfDate) return null

  // A pre-#193 server reports no version at all; leaving the parenthetical
  // out is more honest than a placeholder, and still points at the same fix.
  const running = server.version ? ` (${server.version}${server.gitSha ? `, ${server.gitSha}` : ''})` : ''

  return (
    <div
      role="status"
      className={`pointer-events-none fixed top-[var(--spacing-panel)] left-1/2 z-20 -translate-x-1/2 whitespace-nowrap ${PILL}`}
    >
      legato-server on {SERVER_HOST}
      {running} is out of date — update the server
    </div>
  )
}

/* That a newer release is out (issue #110), on the desktop shell: a pill
 * hanging under the capsule (Capsule.tsx renders it), on its axis, so it
 * covers neither the map/library switch nor search (#405). It floats over
 * the stage and takes no room, so the library's header keeps its inset; at
 * most it covers part of the header until it's dismissed. It's no wider
 * than the palette, and wraps rather than leave the window.
 *
 * It names the server it's for, and dismissing it hides that release on
 * this device until the server offers a newer one. It takes pointer events,
 * unlike the out-of-date line, because its command is there to be selected
 * and copied, and its link to be clicked. The phone shell has no capsule;
 * a row in its Settings says the same (src/phone/SettingsPage.tsx). Out of
 * date wins over update available: there's no offer while the server is too
 * old for this client (serverUpdate.tsx). */
export function ServerUpdatePill({ hidden }: { hidden: boolean }) {
  const offer = useUpdateOffer()
  const layout = useShellLayout()
  if (!offer) return null

  return (
    <div
      role="status"
      className={`absolute top-[calc(var(--inset)+var(--capsule-height)+var(--spacing-sm))] z-20 flex w-max -translate-x-1/2 items-center gap-[8px] pr-[6px] transition-opacity duration-[var(--motion-fast)] ${PILL} ${
        hidden ? 'pointer-events-none opacity-0' : ''
      }`}
      // Centred on the capsule, and no wider than fits around that centre
      // inside the window, or than the palette.
      style={{
        left: layout.capsuleCx,
        maxWidth: Math.min(layout.paletteWidth, 2 * (Math.min(layout.capsuleCx, layout.width - layout.capsuleCx) - INSET)),
      }}
    >
      <span className="min-w-0 select-text">
        <UpdateWording offer={offer} /> —{' '}
        {offer.action.kind === 'command' ? (
          <>
            {/* Rubik, not <code>'s default mono: DESIGN.md keeps Sometype Mono
             * for data off a disk file, and this is the app talking. */}
            run <code className="font-[family-name:var(--font-ui)] text-[var(--color-muted-hi)]">{offer.action.command}</code>
          </>
        ) : (
          <a href={offer.action.url} target="_blank" rel="noreferrer" className="text-[var(--color-muted-hi)] underline underline-offset-2">
            download the latest release
          </a>
        )}
      </span>
      <IconButton
        icon="cancel"
        label="Dismiss until a newer release"
        size={24}
        tone="ink-3"
        round
        className="-my-[2px]"
        onClick={() => dismissUpdate(offer.latestVersion)}
      />
    </div>
  )
}

/* The offer the heartbeat brings (serverUpdate.ts), for the pill and the
 * phone's Settings row inside the app. */
export function UpdateOfferProvider({
  server,
  name,
  children,
}: {
  server: ServerVersion | null
  name: string | null
  children?: ReactNode
}) {
  // Out of date wins: that notice says to update the server, and why.
  const update = server && !server.outOfDate ? server.update : null
  const offer = useMemo(() => (update ? { ...update, serverName: name } : null), [update, name])
  return <UpdateOfferContext.Provider value={offer}>{children}</UpdateOfferContext.Provider>
}

/** "legato-server 0.1.0 is available for raspberrypi". A server that gave
 * no name goes by its short id, as the account's server list names one, or
 * by its address where this page doesn't know the id. */
export function UpdateWording({ offer }: { offer: UpdateOffer }) {
  const id = SERVED_SERVER_ID ?? RELAY_SERVER_ID
  return (
    <>
      legato-server {offer.latestVersion} is available for{' '}
      {offer.serverName ?? <span className="mono">{id ? `${id.slice(0, 8)}…` : SERVER_HOST}</span>}
    </>
  )
}
