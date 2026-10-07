import { SERVER_HOST } from '../config/serverHost'
import type { ServerVersion } from '../hooks/useServerReady'

const PILL =
  'fixed top-[var(--spacing-panel)] left-1/2 z-20 -translate-x-1/2 rounded-full glass px-[16px] py-[6px] text-[length:var(--text-base)] whitespace-nowrap text-[var(--color-muted)]'

/* The one line that says this client needs a newer server (issue #193),
 * or that a newer release is out (issue #110). Both share this one spot
 * rather than stacking two banners.
 *
 * A client newer than its server calls routes and reads fields that aren't
 * there yet, which otherwise just looks like a bug somewhere in the app. So
 * this names the server, says what it's running, and says what to do —
 * H9's recognise/diagnose/recover in one sentence — then stays out of the
 * way: muted Rubik (it's the app talking, not library data), a small glass
 * pill in the open strip of canvas between the two header regions, and
 * pointer-events off so it never sits on top of a click meant for the
 * graph. It stays up for as long as the heartbeat keeps reporting an old
 * server, and goes away by itself once the server is updated.
 *
 * Out of date wins over update available: a server too old for this
 * client needs updating either way, and that sentence says why. The update
 * line takes pointer events, unlike the out-of-date one, because its
 * command is there to be selected and copied, and its link to be clicked. */
export function ServerUpdateNotice({ server }: { server: ServerVersion | null }) {
  if (server?.outOfDate) {
    // A pre-#193 server reports no version at all; leaving the parenthetical
    // out is more honest than a placeholder, and still points at the same fix.
    const running = server.version ? ` (${server.version}${server.gitSha ? `, ${server.gitSha}` : ''})` : ''

    return (
      <div role="status" className={`pointer-events-none ${PILL}`}>
        legato-server on {SERVER_HOST}{running} is out of date — update the server
      </div>
    )
  }

  const update = server?.update
  if (!update) return null

  return (
    <div role="status" className={`select-text ${PILL}`}>
      Legato {update.latestVersion} is available —{' '}
      {update.action.kind === 'command' ? (
        <>
          {/* Rubik, not <code>'s default mono: DESIGN.md keeps Sometype Mono
           * for data off a disk file, and this is the app talking. */}
          run <code className="font-[family-name:var(--font-ui)] text-[var(--color-muted-hi)]">{update.action.command}</code>
        </>
      ) : (
        <a
          href={update.action.url}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-muted-hi)] underline underline-offset-2"
        >
          download the latest release
        </a>
      )}
    </div>
  )
}
