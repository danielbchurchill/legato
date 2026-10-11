import { useEffect, useRef } from 'react'
import { API_BASE, RELAY_SERVER_ID, WS_BASE } from '../config/serverHost'
import { withMediaTicket } from '../auth/session'
import { SERVER_BACK_EVENT } from '../connect/reconnect'

const WS_URL = `${WS_BASE}/ws`
const EVENTS_URL = `${API_BASE}/events`

// #119: a socket the server dropped (a restart, an outage) opens again,
// waiting a little longer after each failed try. The shell stays mounted
// through an outage now, so nothing else would reopen it.
//
// When an outage ends (connect/reconnect.ts), every socket is replaced,
// whatever state it reads. A host that slept, or a network that changed,
// leaves a half-open socket: it still reads OPEN, nothing ever arrives on
// it, and nothing tells the browser so until it sends. Replacing it costs
// one upgrade per outage and needs nothing from the server; a ping would
// need the server to answer it. A socket left half open with no outage
// (an idle connection a NAT forgot) isn't caught, which is a follow-up.
const RECONNECT_FIRST_MS = 1000
const RECONNECT_MAX_MS = 30_000

// First real consumer of the WS broadcaster (server/src/ws.ts) built back
// in M1 — scan/enrich/hygiene events all flow through the same
// {event, payload} shape it already emits. onEvent's payload param is
// optional so existing () => void callers (a plain "go refetch" signal)
// stay valid without change; a settings screen showing live scan progress
// is the first caller that actually reads it.
export function useWsEvent(eventNames: string[], onEvent: (payload?: unknown) => void): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const namesKey = eventNames.join(',')

  useEffect(() => {
    // Nothing to listen for, so no socket (healthData.ts's useFetched with
    // no events).
    if (!namesKey) return
    const names = namesKey.split(',')
    if (RELAY_SERVER_ID) {
      return listenThroughRelay((data) => {
        try {
          const { event, payload } = JSON.parse(data)
          if (names.includes(event)) onEventRef.current(payload)
        } catch {
          // ignore malformed messages
        }
      })
    }
    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryMs = RECONNECT_FIRST_MS
    let closed = false

    const open = () => {
      retryTimer = null
      // The upgrade request can't carry a header, so the media ticket rides
      // in the URL (issue #112).
      const socket = new WebSocket(withMediaTicket(WS_URL))
      ws = socket
      socket.onopen = () => {
        retryMs = RECONNECT_FIRST_MS
      }
      socket.onmessage = (msg) => {
        try {
          const { event, payload } = JSON.parse(msg.data as string)
          if (names.includes(event)) onEventRef.current(payload)
        } catch {
          // ignore malformed messages
        }
      }
      socket.onclose = () => {
        if (closed || ws !== socket) return
        retryTimer = setTimeout(open, retryMs)
        retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS)
      }
    }

    const onServerBack = () => {
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryMs = RECONNECT_FIRST_MS
      const old = ws
      open()
      // After open(), so its close can't schedule a retry of its own.
      old?.close()
    }

    open()
    window.addEventListener(SERVER_BACK_EVENT, onServerBack)
    return () => {
      closed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      window.removeEventListener(SERVER_BACK_EVENT, onServerBack)
      ws?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey])
}

// Through legato.fm's relay (#365) the server's events come as server-sent
// events (GET /events): the relay's tunnel carries HTTP, not WebSockets.
// One stream for every hook on the page, not one each as with the
// WebSocket: a stream holds its connection open for good, and a browser
// opens only six HTTP/1.1 connections to one host, so a stream per hook
// would leave none for anything else the page asks the relay.
//
// An EventSource retries by itself with the URL it started with, whose
// tickets may have run out by then, so on any error it's closed and opened
// again with fresh ones, waiting as the WebSocket's reconnects do. When an
// outage ends it's replaced, for the same reason the sockets are.
const relayListeners = new Set<(data: string) => void>()
let relayStream: EventSource | null = null
let relayRetryTimer: ReturnType<typeof setTimeout> | null = null
let relayRetryMs = RECONNECT_FIRST_MS

function openRelayStream(): void {
  relayRetryTimer = null
  const source = new EventSource(withMediaTicket(EVENTS_URL))
  relayStream = source
  source.onopen = () => {
    relayRetryMs = RECONNECT_FIRST_MS
  }
  source.onmessage = (msg) => {
    for (const listener of relayListeners) listener(msg.data as string)
  }
  source.onerror = () => {
    source.close()
    if (relayStream !== source) return
    relayStream = null
    relayRetryTimer = setTimeout(openRelayStream, relayRetryMs)
    relayRetryMs = Math.min(relayRetryMs * 2, RECONNECT_MAX_MS)
  }
}

function onRelayServerBack(): void {
  if (relayRetryTimer !== null) clearTimeout(relayRetryTimer)
  relayRetryMs = RECONNECT_FIRST_MS
  const old = relayStream
  openRelayStream()
  old?.close()
}

function listenThroughRelay(listener: (data: string) => void): () => void {
  relayListeners.add(listener)
  if (relayListeners.size === 1) {
    openRelayStream()
    window.addEventListener(SERVER_BACK_EVENT, onRelayServerBack)
  }
  return () => {
    relayListeners.delete(listener)
    if (relayListeners.size > 0) return
    window.removeEventListener(SERVER_BACK_EVENT, onRelayServerBack)
    if (relayRetryTimer !== null) clearTimeout(relayRetryTimer)
    relayRetryTimer = null
    relayStream?.close()
    relayStream = null
  }
}
