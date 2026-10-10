import { useEffect, useRef } from 'react'
import { WS_BASE } from '../config/serverHost'
import { withMediaTicket } from '../auth/session'

const WS_URL = `${WS_BASE}/ws`

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
    // The upgrade request can't carry a header, so the media ticket rides
    // in the URL (issue #112).
    const ws = new WebSocket(withMediaTicket(WS_URL))
    ws.onmessage = (msg) => {
      try {
        const { event, payload } = JSON.parse(msg.data as string)
        if (names.includes(event)) onEventRef.current(payload)
      } catch {
        // ignore malformed messages
      }
    }
    return () => ws.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey])
}
