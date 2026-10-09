import { useCallback, useEffect, useRef } from 'react'
import { useWsEvent } from './useWs'

/* How long a burst of server events has to go quiet before a view fetches
 * again: longer than the enrichment queue's own ~1/sec spacing, so a drain
 * of many nodes collapses into one fetch rather than one per node. */
export const COALESCE_QUIET_MS = 1500

/* The longest a fetch waits for the quiet. Without it, events that never
 * stop for 1.5 s (a long enrichment drain) push a fetch the view needs back
 * for as long as they last, which can be hours. */
export const COALESCE_MAX_WAIT_MS = 10_000

/** Calls `onSettle` once a burst of these events has gone quiet for
 * `quietMs`, or `maxWaitMs` after the burst's first event, whichever comes
 * first. `accept` leaves out an event whose payload changes nothing the
 * caller reads. One socket per caller, as useWsEvent opens. */
export function useCoalescedWsEvent(
  eventNames: string[],
  onSettle: () => void,
  {
    quietMs = COALESCE_QUIET_MS,
    maxWaitMs = COALESCE_MAX_WAIT_MS,
    accept,
  }: { quietMs?: number; maxWaitMs?: number; accept?: (payload: unknown) => boolean } = {},
): void {
  const onSettleRef = useRef(onSettle)
  onSettleRef.current = onSettle
  const acceptRef = useRef(accept)
  acceptRef.current = accept
  // One timer for the quiet, reset by every event, and one for the maximum
  // wait, set by a burst's first event. Whichever fires first settles it.
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (quietTimer.current != null) clearTimeout(quietTimer.current)
    if (maxTimer.current != null) clearTimeout(maxTimer.current)
    quietTimer.current = null
    maxTimer.current = null
  }, [])

  useWsEvent(eventNames, (payload) => {
    if (acceptRef.current && !acceptRef.current(payload)) return
    const settle = () => {
      clear()
      onSettleRef.current()
    }
    if (quietTimer.current != null) clearTimeout(quietTimer.current)
    quietTimer.current = setTimeout(settle, quietMs)
    maxTimer.current ??= setTimeout(settle, maxWaitMs)
  })

  useEffect(() => clear, [clear])
}
