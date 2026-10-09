import { isLanHost } from './address'

/* The server-unreachable state (issue #119, plan 03's "Server unreachable"):
 * what happened, the likely why, and one action. Nothing tells a client why
 * a server stopped answering, so the why is inferred from what the client
 * can see for itself:
 *
 *   - the path it was using: this computer, the home network, or anywhere
 *     else (a Tailscale address, a domain behind a proxy);
 *   - how the health check failed: turned away at once, no answer at all,
 *     or an answer that wasn't Legato's;
 *   - when the server last answered, and whether this device's network
 *     dropped or changed since.
 *
 * #310's relay is a fourth path with failures of its own (legato.fm out of
 * reach, or the server's tunnel down). It adds a ServerPath and its own
 * branch in inferReason; the reasons below don't assume a direct
 * connection beyond the paths that name one. */

export type ServerPath =
  /** The desktop app's own server, which the app started (server_process.rs). */
  | 'embedded'
  /** Something else on this computer: a server run by hand, a dev setup. */
  | 'this-device'
  /** An address that only works on the local network (address.ts). */
  | 'home'
  /** Anything else: a Tailscale address, a domain. */
  | 'custom'

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\./.test(h)
}

/** Which path `origin` is. `embedded` says the desktop app started the
 * server at that origin itself. */
export function pathFor(origin: string, embedded: boolean): ServerPath {
  const host = new URL(origin).hostname
  if (isLoopback(host)) return embedded ? 'embedded' : 'this-device'
  return isLanHost(host) ? 'home' : 'custom'
}

/** How one health check failed. */
export type CheckFailure =
  /** Failed at once: the machine is there and nothing is listening, which
   * a browser can't tell apart from a name that didn't resolve. */
  | { kind: 'refused' }
  /** Nothing came back before HEALTH_TIMEOUT_MS, or the request gave up
   * slowly: a host that's asleep, switched off or out of reach. */
  | { kind: 'no-answer' }
  /** Something answered, but not with Legato's health: a reverse proxy's
   * 502 with Legato stopped behind it, or another program on the port. */
  | { kind: 'bad-status'; status: number }

export const HEALTH_TIMEOUT_MS = 4000

// A refused connection comes back within a round trip. A host that's gone
// takes seconds (an ARP or connect timeout), or never answers at all.
const REFUSED_WITHIN_MS = 1500

export function classifyFailure({ elapsedMs, timedOut }: { elapsedMs: number; timedOut: boolean }): CheckFailure {
  return timedOut || elapsedMs >= REFUSED_WITHIN_MS ? { kind: 'no-answer' } : { kind: 'refused' }
}

/** Fired on window when the server answers again after failing (#119), so
 * whatever the outage broke can pick up: the web player's source, the
 * WebSockets. */
export const SERVER_BACK_EVENT = 'legato:server-back'

export type OutageFacts = {
  path: ServerPath
  failure: CheckFailure
  /** When the server last answered this device, in ms. Null if it never has. */
  lastSeenAt: number | null
  /** When this device's network last dropped or changed, in ms. */
  networkChangedAt: number | null
  deviceOnline: boolean
}

export type UnreachableReason = 'device-offline' | 'network-changed' | 'stopped' | 'not-responding' | 'asleep' | 'offline'

// Silence from a server seen within this long reads as it having just gone
// to sleep; longer than this, it's been offline a while, and all that's
// worth saying is since when.
export const ASLEEP_WITHIN_MS = 60 * 60 * 1000

export function inferReason(facts: OutageFacts, now: number): UnreachableReason {
  const local = facts.path === 'embedded' || facts.path === 'this-device'
  // Loopback works without a network, so only a server elsewhere is cut
  // off by this device's own.
  if (!local && !facts.deviceOnline) return 'device-offline'
  // A change after the last answer, not before it: a server that answered
  // on the new network wasn't lost to the change.
  if (!local && facts.networkChangedAt != null && facts.lastSeenAt != null && facts.networkChangedAt > facts.lastSeenAt) {
    return 'network-changed'
  }
  if (facts.failure.kind !== 'no-answer') return 'stopped'
  // This computer can't be asleep while it's running this page.
  if (local) return 'not-responding'
  return facts.lastSeenAt != null && now - facts.lastSeenAt < ASLEEP_WITHIN_MS ? 'asleep' : 'offline'
}

export type OutageCopy = { title: string; why: string; hint: string | null }

/** Same shape as the connect screen's "offline since …": a time today, a
 * date and time before that. */
export function formatSeen(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date(now).toDateString()) return time
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

/** What the state says: what happened as the title, the likely why, and a
 * hint where there's something the person can do beyond trying again. */
export function describeOutage(
  reason: UnreachableReason,
  ctx: { path: ServerPath; name: string | null; host: string; lastSeenAt: number | null; everConnected: boolean; now: number },
): OutageCopy {
  const label = ctx.path === 'embedded' ? "this computer's server" : (ctx.name ?? ctx.host)
  const title = `Can't reach ${label}`
  const seen = ctx.lastSeenAt != null ? formatSeen(ctx.lastSeenAt, ctx.now) : null
  const keepAwake = `If ${label} runs the Legato desktop app, Settings → serving → awake there keeps it from sleeping while you listen.`

  switch (reason) {
    case 'device-offline':
      return { title, why: "This device isn't connected to a network.", hint: null }
    case 'network-changed':
      return ctx.path === 'home'
        ? {
            title,
            why: `This device changed networks after it last reached ${label}${seen ? ` at ${seen}` : ''}, and that address only works on your home network.`,
            hint: null,
          }
        : {
            title,
            why: `This device changed networks after it last reached ${label}${seen ? ` at ${seen}` : ''}.`,
            hint: "If you reach it through Tailscale or another VPN, check that it's connected here too.",
          }
    case 'stopped':
      if (ctx.path === 'embedded') {
        // The tray's toggle (src-tauri/src/tray.rs) starts a fresh server,
        // whether serving was paused there or the server fell over.
        return ctx.everConnected
          ? {
              title,
              why: "Legato's server on this computer stopped.",
              hint: "If you paused serving, resume it from Legato's icon in the menu bar or system tray. Otherwise, quit and reopen Legato.",
            }
          : {
              title,
              why: "Legato's server on this computer hasn't started.",
              hint: "After an update it can take a minute or two. If it's longer than that, quit and reopen Legato.",
            }
      }
      if (ctx.path === 'this-device') {
        return { title, why: "The Legato server on this computer isn't running.", hint: 'Start it again, and Legato reconnects by itself.' }
      }
      return {
        title,
        why: `${label} is up, but Legato isn't answering on it. It's probably restarting, or it stopped.`,
        hint: `If it doesn't come back in a minute or two, restart Legato on ${label}.`,
      }
    case 'not-responding':
      return {
        title,
        why: `Legato's server on this computer stopped responding${seen ? ` at ${seen}` : ''}. It may be busy, or stuck.`,
        hint: ctx.path === 'embedded' ? "If it doesn't recover, quit and reopen Legato." : "If it doesn't recover, restart it.",
      }
    case 'asleep':
      return {
        title,
        why: `${label} stopped answering${seen ? ` at ${seen}` : ''}. It's probably asleep, or it lost its network.`,
        hint: keepAwake,
      }
    case 'offline':
      return seen
        ? {
            title,
            why: `${label} has been offline since ${seen}. It may be switched off, asleep, or away from this network.`,
            hint: keepAwake,
          }
        : { title, why: `${label} hasn't answered this device yet. Check that it's switched on and on this network.`, hint: null }
  }
}

/** The line under the action. The client keeps checking whatever happens,
 * which is why the state needs no spinner, and a "Try again" that found
 * nothing says it ran. */
export function outageFooter({ everConnected, triedAt }: { everConnected: boolean; triedAt: number | null }): string {
  const tried = triedAt != null ? `Tried again at ${new Date(triedAt).toLocaleTimeString()}. ` : ''
  return everConnected
    ? `${tried}Legato keeps trying, and carries on where you left off once it's back.`
    : `${tried}Legato keeps trying, and opens once it's back.`
}
