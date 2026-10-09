import { useEffect, useRef } from 'react'
import { WS_BASE } from '../config/serverHost'
import { withMediaTicket } from '../auth/session'
import { SERVER_BACK_EVENT } from '../connect/reconnect'

const WS_URL = `${WS_BASE}/ws`

// #119: a socket the server dropped (a restart, an outage) opens again,
// waiting a little longer after each failed try, and straight away once the
// server answers its health check again. The shell stays mounted through an
// outage now, so nothing else would reopen it.
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
      if (ws?.readyState !== WebSocket.CLOSED || retryTimer === null) return
      clearTimeout(retryTimer)
      retryMs = RECONNECT_FIRST_MS
      open()
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
