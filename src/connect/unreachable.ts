import { isLanHost } from './address'
import { formatSince } from './lastSeen'
import type { ServerPath } from './serverPath'

/* The server-unreachable state (issue #119, plan 03's "Server unreachable"):
 * what happened, the likely why, and one action. Nothing tells a client why
 * a server stopped answering, so the why is inferred from what the client
 * can see for itself:
 *
 *   - the path it was using (serverPath.ts): this computer, the home
 *     network, or anywhere else (a domain behind a proxy). The home network
 *     takes in a Tailscale address and a dotless name there, so where the
 *     words depend on whether the address works away from home, they ask
 *     the address itself;
 *   - how the health check failed: turned away at once, no answer at all,
 *     or an answer that wasn't Legato's;
 *   - when the server last answered, and whether this device's network
 *     dropped or changed since.
 *
 * The relay is a path with failures of its own (legato.fm out of reach, or
 * the server's tunnel down). #118 named it as a ServerPath; no client
 * connects through it yet, and the one that does adds its own branch in
 * inferReason. Until then the reasons below treat it like any path that
 * isn't this computer, and don't assume a direct connection beyond the
 * paths that name one. */

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

// How long one health check waits for an answer. Longer than the slowest
// working answer seen, a Pi whose loop a recompute blocked for nine seconds,
// so a slow server's answer still counts as one. Whether the server is out
// of reach doesn't rest on one check anyway (useServerReady.ts).
export const HEALTH_TIMEOUT_MS = 10_000

// A refused connection comes back within a round trip. A host that's gone
// takes seconds (an ARP or connect timeout), or never answers at all.
const REFUSED_WITHIN_MS = 1500

export function classifyFailure({ elapsedMs, timedOut }: { elapsedMs: number; timedOut: boolean }): CheckFailure {
  return timedOut || elapsedMs >= REFUSED_WITHIN_MS ? { kind: 'no-answer' } : { kind: 'refused' }
}

const FAILURE_RANK: Record<CheckFailure['kind'], number> = { refused: 0, 'bad-status': 1, 'no-answer': 2 }

/** How the server has failed over the outage so far, given how it had
 * failed before and how the latest check failed. The reason is worked out
 * from this, not from the last check alone: a LAN host that's asleep goes
 * unanswered on one check and is turned away at once on the next, by this
 * computer's own network stack, and the words shouldn't swap between
 * "asleep" and "stopped" every second. Silence outranks an answer from
 * something else, which outranks a refusal, and an outage keeps the
 * highest it has seen. */
export function outageFailure(sofar: CheckFailure | null, latest: CheckFailure): CheckFailure {
  return sofar && FAILURE_RANK[sofar.kind] >= FAILURE_RANK[latest.kind] ? sofar : latest
}

export type OutageFacts = {
  path: ServerPath
  failure: CheckFailure
  /** When the server last answered this device, in ms. Null if it never has. */
  lastSeenAt: number | null
  /** When this device's network last changed, in ms: back online after
   * being offline, or a different kind of network. */
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

/** What the state says: what happened as the title, the likely why, and a
 * hint where there's something the person can do beyond trying again. */
export function describeOutage(
  reason: UnreachableReason,
  ctx: { path: ServerPath; name: string | null; host: string; lastSeenAt: number | null; everConnected: boolean; now: number },
): OutageCopy {
  const label = ctx.path === 'embedded' ? "this computer's server" : (ctx.name ?? ctx.host)
  const title = `Can't reach ${label}`
  const seen = ctx.lastSeenAt != null ? formatSince(ctx.lastSeenAt, ctx.now) : null
  const keepAwake = `If ${label} runs the Legato desktop app, Settings → serving → awake there keeps it from sleeping while you listen.`

  switch (reason) {
    case 'device-offline':
      return { title, why: "This device isn't connected to a network.", hint: null }
    case 'network-changed':
      // Only an address that works nowhere else is lost to a change of
      // network. A tailnet's works anywhere Tailscale is connected.
      return ctx.path === 'home' && isLanHost(new URL(`http://${ctx.host}`).hostname)
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
 * which is why the state needs no spinner, and a "try again" that found
 * nothing says it ran. */
export function outageFooter({ everConnected, triedAt }: { everConnected: boolean; triedAt: number | null }): string {
  const tried = triedAt != null ? `Tried again at ${new Date(triedAt).toLocaleTimeString()}. ` : ''
  return everConnected
    ? `${tried}Legato keeps trying, and carries on where you left off once it's back.`
    : `${tried}Legato keeps trying, and opens once it's back.`
}
