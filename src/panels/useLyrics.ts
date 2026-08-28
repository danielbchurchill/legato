import { useEffect, useState } from 'react'
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
  const [lyrics, setLyrics] = useState<LyricsData | 'loading' | null>(null)

  // A lyrics view left open (paged to, or disclosed) on the last track must
  // not keep showing the last track's lyrics over a different one.
  useEffect(() => {
    setLyrics(null)
  }, [nodeId])

  useEffect(() => {
    if (!enabled || lyrics !== null) return
    setLyrics('loading')
    fetch(`${API}/nodes/${nodeId}/lyrics`)
      .then((r) => (r.ok ? (r.json() as Promise<LyricsData>) : null))
      .then(setLyrics)
      .catch(() => setLyrics(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, enabled, lyrics])

  // MO-11: a single LRCLIB round trip has no measurable length — genuinely
  // indeterminate. Under ~400ms show nothing (most lookups land there);
  // past ~800ms shift the label once, non-looping, rather than pretend to
  // track progress that doesn't exist.
  const [lyricsWaitVisible, setLyricsWaitVisible] = useState(false)
  const [lyricsWaitLong, setLyricsWaitLong] = useState(false)
  useEffect(() => {
    if (lyrics !== 'loading') {
      setLyricsWaitVisible(false)
      setLyricsWaitLong(false)
      return
    }
    const shortTimer = setTimeout(() => setLyricsWaitVisible(true), 400)
    const longTimer = setTimeout(() => setLyricsWaitLong(true), 800)
    return () => {
      clearTimeout(shortTimer)
      clearTimeout(longTimer)
    }
  }, [lyrics])

  return { lyrics, lyricsWaitVisible, lyricsWaitLong }
}
