import { useEffect, useRef } from 'react'

const WS_URL = 'ws://127.0.0.1:8899/api/v1/ws'

// First real consumer of the WS broadcaster (server/src/ws.ts) built back
// in M1 — scan/enrich/hygiene events all flow through the same
// {event, payload} shape it already emits.
export function useWsEvent(eventNames: string[], onEvent: () => void): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const namesKey = eventNames.join(',')

  useEffect(() => {
    const names = namesKey.split(',')
    const ws = new WebSocket(WS_URL)
    ws.onmessage = (msg) => {
      try {
        const { event } = JSON.parse(msg.data as string)
        if (names.includes(event)) onEventRef.current()
      } catch {
        // ignore malformed messages
      }
    }
    return () => ws.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey])
}
