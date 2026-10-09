import { useEffect, useRef, useState } from 'react'
import { useReconnectEpoch } from '../connect/reconnect'
import { API, type LyricsData } from './useNodeDetail'

/* Lyrics fetch and its MO-11 wait-timing, lifted out of NodeDetailPages so
 * both the paginated inspector (enabled = "this is the visible page") and
 * the persistent panel's lyrics disclosure (enabled = "this disclosure is
 * open") can drive the exact same lazy-fetch-on-first-view behavior from
 * different definitions of "visible". GET /nodes/:id/lyrics is a real round
 * trip to LRCLIB on a cache miss (migration 0017), so `enabled` gates the
 * fetch rather than firing it the moment a node is selected — a section
 * that's never opened must never trigger the call. */
export function useLyrics(nodeId: number, enabled: boolean) {
  // What the server answered, and for which track: a lyrics view left open
  // (paged to, or disclosed) on the last track must not keep showing the
  // last track's lyrics over a different one.
  const [answer, setAnswer] = useState<{ nodeId: number; lyrics: LyricsData | null } | null>(null)

  // Asked once per track, and again after an outage (#119), keeping what's
  // shown until it answers. It used to ask again whenever the answer was
  // null, which a track with no lyrics (a 404) and a server that's down
  // both give, so it asked in a tight loop.
  const reconnects = useReconnectEpoch()
  const asked = useRef<{ nodeId: number; reconnects: number } | null>(null)
  useEffect(() => {
    if (!enabled) return
    if (asked.current?.nodeId === nodeId && asked.current.reconnects === reconnects) return
    asked.current = { nodeId, reconnects }
    let done = false
    fetch(`${API}/nodes/${nodeId}/lyrics`)
      .then((r) => (r.ok ? (r.json() as Promise<LyricsData>) : null))
      .catch(() => null)
      .then((lyrics) => {
        if (done) return
        done = true
        setAnswer({ nodeId, lyrics })
      })
    return () => {
      // Left before it answered (another track, or closed): ask again next
      // time rather than wait on an answer that will be dropped.
      if (!done) asked.current = null
      done = true
    }
  }, [nodeId, enabled, reconnects])

  const lyrics: LyricsData | 'loading' | null = answer?.nodeId === nodeId ? answer.lyrics : enabled ? 'loading' : null

  // MO-11: a single LRCLIB round trip has no measurable length — genuinely
  // indeterminate. Under ~400ms show nothing (most lookups land there);
  // past ~800ms shift the label once, non-looping, rather than pretend to
  // track progress that doesn't exist.
  const [lyricsWaitVisible, setLyricsWaitVisible] = useState(false)
  const [lyricsWaitLong, setLyricsWaitLong] = useState(false)
  const waiting = lyrics === 'loading'
  useEffect(() => {
    if (!waiting) return
    const shortTimer = setTimeout(() => setLyricsWaitVisible(true), 400)
    const longTimer = setTimeout(() => setLyricsWaitLong(true), 800)
    return () => {
      clearTimeout(shortTimer)
      clearTimeout(longTimer)
      setLyricsWaitVisible(false)
      setLyricsWaitLong(false)
    }
  }, [waiting])

  return { lyrics, lyricsWaitVisible, lyricsWaitLong }
}
