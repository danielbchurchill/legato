import { useEffect, useRef } from 'react'
import { WS_BASE } from '../config/serverHost'

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
    const names = namesKey.split(',')
    const ws = new WebSocket(WS_URL)
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
