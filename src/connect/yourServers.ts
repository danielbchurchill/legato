import { RELAY_ORIGIN } from '../config/relayHost'
import { originFor } from './address'
import { verifyServerIdentity, type IdentityResult } from './identity'
import type { KnownServers } from './knownServers'

/* The connect screen's "your servers" (issue #117): every server the
 * signed-in legato.fm account has linked, and whether this device can
 * reach it.
 *
 *   - At home: it answered directly, at an address mDNS found for its id or
 *     at the last LAN address this device reached it on, and proved it
 *     holds its id's key (identity.ts). An advertisement alone isn't enough:
 *     anything on the LAN can claim an id.
 *   - Offline since …: neither worked. The time is when this device last
 *     reached it (knownServers.ts); a server never reached from here says
 *     so instead.
 *
 * "Through the relay" isn't here yet. No home server opens the relay's
 * tunnel, and the tunnel registry is keyed by account rather than server;
 * #310 adds both, and the per-server state this list will read. */

export type LinkedServer = { serverId: string; linkedAt: string }

export type FoundServer = {
  instance: string
  name: string
  id: string | null
  version: string | null
  port: number
  addresses: string[]
}

export type Reach =
  | { kind: 'checking' }
  | { kind: 'home'; origin: string; via: 'mdns' | 'lan' }
  | { kind: 'offline'; since: string | null }

export class LinkedServersError extends Error {
  signedOut: boolean
  constructor(message: string, signedOut = false) {
    super(message)
    this.signedOut = signedOut
  }
}

export async function fetchLinkedServers(
  relayToken: string,
  origin: string = RELAY_ORIGIN,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedServer[]> {
  let res: Response
  try {
    res = await fetchImpl(`${origin}/linked-servers`, { headers: { Authorization: `Bearer ${relayToken}` }, credentials: 'omit' })
  } catch {
    throw new LinkedServersError(`Couldn't reach legato.fm at ${new URL(origin).host}. Check your internet connection.`)
  }
  if (res.status === 401) throw new LinkedServersError('Your legato.fm session ended. Sign in again.', true)
  const body = (await res.json().catch(() => null)) as { servers?: LinkedServer[] } | null
  if (!res.ok || !Array.isArray(body?.servers)) throw new LinkedServersError(`legato.fm answered ${res.status} for your servers.`)
  return body.servers
}

/** Where to look for a server, in order: every address mDNS found for its
 * id, then the LAN address this device last reached it on. */
export function candidateOrigins(
  serverId: string,
  found: FoundServer[] | null,
  known: KnownServers,
): { origin: string; via: 'mdns' | 'lan' }[] {
  const out: { origin: string; via: 'mdns' | 'lan' }[] = []
  for (const server of found ?? []) {
    if (server.id !== serverId) continue
    for (const address of server.addresses) out.push({ origin: originFor(address, server.port), via: 'mdns' })
  }
  const lan = known[serverId]?.lanOrigin
  if (lan && !out.some((c) => c.origin === lan)) out.push({ origin: lan, via: 'lan' })
  return out
}

/** The first candidate that proves it's `serverId`, or offline. */
export async function reachServer(
  serverId: string,
  candidates: { origin: string; via: 'mdns' | 'lan' }[],
  known: KnownServers,
  verify: (origin: string, serverId: string) => Promise<IdentityResult> = verifyServerIdentity,
): Promise<Reach> {
  for (const candidate of candidates) {
    if ((await verify(candidate.origin, serverId)).ok) return { kind: 'home', ...candidate }
  }
  return { kind: 'offline', since: known[serverId]?.lastReachedAt ?? null }
}

/** A name for a server this device may never have seen: what mDNS or a past
 * visit called it, else the start of its id. */
export function serverName(serverId: string, found: FoundServer[] | null, known: KnownServers): string {
  return found?.find((s) => s.id === serverId)?.name ?? known[serverId]?.name ?? `Server ${serverId.slice(0, 8)}`
}
