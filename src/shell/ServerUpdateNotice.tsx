import { SERVER_HOST } from '../config/serverHost'
import type { ServerVersion } from '../hooks/useServerReady'

/* The one line that says this client needs a newer server (issue #193).
 *
 * A client newer than its server calls routes and reads fields that aren't
 * there yet, which otherwise just looks like a bug somewhere in the app. So
 * this names the server, says what it's running, and says what to do —
 * H9's recognise/diagnose/recover in one sentence — then stays out of the
 * way: muted Rubik (it's the app talking, not library data), a small glass
 * pill in the open strip of canvas between the two header regions, and
 * pointer-events off so it never sits on top of a click meant for the
 * graph. It stays up for as long as the heartbeat keeps reporting an old
 * server, and goes away by itself once the server is updated. */
export function ServerUpdateNotice({ server }: { server: ServerVersion | null }) {
  if (!server?.outOfDate) return null

  // A pre-#193 server reports no version at all; leaving the parenthetical
  // out is more honest than a placeholder, and still points at the same fix.
  const running = server.version ? ` (${server.version}${server.gitSha ? `, ${server.gitSha}` : ''})` : ''

  return (
    <div
      role="status"
      className="pointer-events-none fixed top-[var(--spacing-panel)] left-1/2 z-20 -translate-x-1/2 rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-[16px] py-[6px] text-[length:var(--text-base)] whitespace-nowrap text-[var(--color-muted)] backdrop-blur-[var(--blur-glass)] shadow-[var(--shadow-surface)]"
    >
      legato-server on {SERVER_HOST}{running} is out of date — update the server
    </div>
  )
}
