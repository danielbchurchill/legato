import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { readRelaySession } from '../auth/relaySession'
import { readSession } from '../auth/session'
import { IS_TAURI } from '../config/runtime'
import { SERVER_ORIGIN } from '../config/serverHost'
import { readKnownServers, rememberServer, type KnownServers } from './knownServers'
import { renewDelayMs, renewLegatoSession, RENEW_RETRY_MS } from './legatoSignIn'
import {
  candidateOrigins,
  fetchLinkedServers,
  LinkedServersError,
  reachServer,
  serverName,
  type FoundServer,
  type LinkedServer,
  type Reach,
} from './yourServers'

/* The connect screen's live state (issue #117). Kept out of the component so
 * ConnectScreen.tsx can be drawn from fixed props for screenshots. */

// Often enough that a server switched on while the screen is open shows up
// within a few seconds; the browse itself runs in Rust (discovery.rs).
const DISCOVERY_POLL_MS = 2500

export type Discovery = { supported: false } | { supported: true; servers: FoundServer[] | null; error: string | null }

export function useDiscoveredServers(): Discovery {
  const [servers, setServers] = useState<FoundServer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!IS_TAURI) return
    let cancelled = false
    const poll = () =>
      invoke<FoundServer[]>('discovered_servers')
        .then((list) => {
          if (!cancelled) setServers(list)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(String(err))
        })
    void poll()
    const timer = setInterval(() => void poll(), DISCOVERY_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
  return IS_TAURI ? { supported: true, servers, error } : { supported: false }
}

export type YourServers =
  | { kind: 'unsupported' }
  | { kind: 'signed-out' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'listed'; servers: { serverId: string; name: string; reach: Reach }[] }

/** The account's linked servers, each checked for a way to reach it. Waits
 * for the first discovery poll, so a server that's right here doesn't
 * flash "offline" first. */
export function useYourServers(discovery: Discovery, relaySignedIn: boolean): { state: YourServers; reload: () => void } {
  const [linked, setLinked] = useState<LinkedServer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [reach, setReach] = useState<Record<string, Reach>>({})
  const [known, setKnown] = useState<KnownServers>(() => readKnownServers())
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!IS_TAURI || !relaySignedIn) return
    const token = readRelaySession()?.token
    if (!token) return
    let cancelled = false
    fetchLinkedServers(token)
      .then((list) => {
        if (cancelled) return
        setLinked(list)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof LinkedServersError && err.signedOut) setSignedOut(true)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [relaySignedIn, attempt])

  const found = discovery.supported ? discovery.servers : null
  const discoveryReady = !discovery.supported || discovery.servers !== null || discovery.error !== null
  const foundKey = JSON.stringify(found?.map((s) => [s.id, s.addresses, s.port]) ?? null)

  useEffect(() => {
    if (!linked || !discoveryReady) return
    let cancelled = false
    for (const { serverId } of linked) {
      const candidates = candidateOrigins(serverId, found, known)
      void reachServer(serverId, candidates, known).then((result) => {
        if (cancelled) return
        if (result.kind === 'home') {
          setKnown(rememberServer(serverId, { origin: result.origin, name: serverName(serverId, found, known) }))
        }
        setReach((r) => ({ ...r, [serverId]: result }))
      })
    }
    return () => {
      cancelled = true
    }
    // `found` and `known` are read through foundKey and attempt; re-running on
    // every remembered visit would loop.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, discoveryReady, foundKey, attempt])

  const reload = useCallback(() => {
    setReach({})
    setAttempt((n) => n + 1)
  }, [])

  let state: YourServers
  if (!IS_TAURI) state = { kind: 'unsupported' }
  else if (!relaySignedIn || signedOut) state = { kind: 'signed-out' }
  else if (error) state = { kind: 'error', message: error }
  else if (!linked) state = { kind: 'loading' }
  else
    state = {
      kind: 'listed',
      servers: linked.map(({ serverId }) => ({
        serverId,
        name: serverName(serverId, found, known),
        reach: reach[serverId] ?? { kind: 'checking' },
      })),
    }
  return { state, reload }
}

/** Renews a legato.fm session on this device before it ends (#117). A
 * password session has nothing to renew. */
export function useLegatoRenewal(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const schedule = (delay?: number) => {
      const legato = readSession()?.legato
      if (!legato) return
      timer = setTimeout(() => {
        void renewLegatoSession(SERVER_ORIGIN).then((renewed) => {
          if (!cancelled) schedule(renewed ? undefined : RENEW_RETRY_MS)
        })
      }, delay ?? renewDelayMs(legato.expiresAt))
    }
    schedule()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [signedIn])
}
