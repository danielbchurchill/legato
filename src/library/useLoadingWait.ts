import { useEffect, useState } from 'react'

/* DESIGN.md's indeterminate-progress rule, the same MO-11 timing as
 * useLyrics.ts: nothing for the first ~400ms (most local fetches never
 * reach it), so `visible` stays false; one non-looping change past ~800ms,
 * `long`. Both reset when loading ends, so the next load waits again. */
export function useLoadingWait(loading: boolean): { visible: boolean; long: boolean } {
  const [waitedShort, setWaitedShort] = useState(false)
  const [waitedLong, setWaitedLong] = useState(false)
  // Cleared during render, so each load starts both timers from scratch.
  if (!loading && (waitedShort || waitedLong)) {
    setWaitedShort(false)
    setWaitedLong(false)
  }
  useEffect(() => {
    if (!loading) return
    const shortTimer = setTimeout(() => setWaitedShort(true), 400)
    const longTimer = setTimeout(() => setWaitedLong(true), 800)
    return () => {
      clearTimeout(shortTimer)
      clearTimeout(longTimer)
    }
  }, [loading])
  return { visible: loading && waitedShort, long: loading && waitedLong }
}
