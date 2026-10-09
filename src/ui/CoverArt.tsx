import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import { withMediaTicket } from '../auth/session'

/* Album art from the cover cache. v2 rounds every cover a little (6px; 4px
 * on a 36px row thumbnail, 8–10 on a hero) and lays a 1px inset edge over it,
 * so a black cover keeps an edge on the dark theme and a white one on paper.
 * The art itself is never tinted or filtered.
 *
 * The edge is an overlay above the <img>, not a box-shadow on it: an inset
 * shadow on a replaced element is painted underneath the image and never
 * shows.
 *
 * The endpoint 404s for a node with no art, which is a normal state rather
 * than an error, so the fallback is a quiet wash instead of a broken image
 * icon or an apology. */

export type CoverRadius = 'none' | 'sm' | 'art' | 'hero' | 'round'

const RADIUS: Record<CoverRadius, string> = {
  none: '',
  sm: 'rounded-[var(--radius-art-sm)]',
  art: 'rounded-[var(--radius-art)]',
  hero: 'rounded-[10px]',
  round: 'rounded-full',
}

type CoverArtProps = {
  nodeId: number | null
  size: 'thumb' | 'full'
  className?: string
  alt?: string
  /** For callers whose layout maths owns the dimensions. */
  style?: CSSProperties
  radius?: CoverRadius
  /** The inset art edge. Off inside a Mosaic, which draws one edge around
   * all four cells. */
  edge?: boolean
}

export function CoverArt({ nodeId, size, className = '', alt = '', style, radius = 'art', edge = true }: CoverArtProps) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const imgRef = useRef<HTMLImageElement>(null)

  const src = nodeId == null ? null : withMediaTicket(`${API}/nodes/${nodeId}/cover?size=${size}`)
  // #119: art that failed while the server was out of reach is asked for
  // once more when it's back.
  const reconnects = useReconnectEpoch()

  // Without this, moving from an album that has art to one that does not
  // leaves the previous failure latched and hides art that exists. Keyed
  // on `src` (not just nodeId) so a size change resets it too.
  //
  // `loaded` resets to whether the image has *actually* already decoded, not
  // to a flat false. A cached thumb can finish before this effect runs — and
  // StrictMode double-invokes effects, so this can also re-run after a real
  // onLoad — and once an image is complete the browser never fires load for
  // it again. Blindly resetting to false in either case stranded the <img>
  // at opacity-0 permanently: present, correct src, no error, just invisible.
  // That is the intermittent "artwork doesn't display" bug.
  useLayoutEffect(() => {
    const img = imgRef.current
    // Resetting from the img's real decode state here is the fix described above; it must run before paint.
    // oxlint-disable-next-line react/set-state-in-effect
    setFailed(false)
    setLoaded(img != null && img.complete && img.naturalWidth > 0)
  }, [src, reconnects])

  const frame = `relative shrink-0 overflow-hidden ${RADIUS[radius]} ${className}`
  const edgeOverlay = edge && (
    <span aria-hidden className={`pointer-events-none absolute inset-0 shadow-[var(--shadow-art-edge)] ${RADIUS[radius]}`} />
  )

  if (src == null || failed) {
    // The no-art fallback doesn't fade (MO-10) — it isn't loading, it's the
    // answer.
    return (
      <div aria-hidden className={`bg-[var(--color-wash-2)] ${frame}`} style={style}>
        {edgeOverlay}
      </div>
    )
  }

  return (
    <div className={frame} style={style}>
      <img
        // Keyed on src so React unmounts the previous <img> outright instead
        // of mutating its src in place. Reusing one DOM node meant a stray
        // load/error from the request React had just cancelled could still
        // land on the listener now watching the *new* src — checking
        // event.currentTarget.src didn't help, since the DOM node's src had
        // already been overwritten to the new value by the time that stale
        // event fired. A fresh node per src has no listener left for a
        // cancelled request's event to reach.
        key={src}
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => setLoaded(true)}
        // Guarded against `loaded`: a stray error firing after a successful
        // load (e.g. something re-touching the DOM node) must not
        // retroactively hide art that already rendered.
        onError={() => {
          if (loaded) return
          setFailed(true)
          // The <img> error event carries no reason, which is why the
          // intermittent "art sometimes doesn't show" bug has been so hard to
          // pin down — a 404 (genuinely no art), a 500, a truncated body and a
          // connection the browser dropped under load all look identical here.
          // Re-request once, dev-only, purely to record which one it was.
          if (import.meta.env.DEV) {
            fetch(src)
              .then(async (r) => {
                const body = await r.blob()
                console.warn(
                  `[CoverArt] load failed nodeId=${nodeId} size=${size} status=${r.status} bytes=${body.size} type=${body.type} coverSource=${r.headers.get('X-Cover-Source')}`,
                )
              })
              .catch((err) => {
                console.warn(`[CoverArt] load failed nodeId=${nodeId} size=${size} refetch threw:`, err)
              })
          }
        }}
        // One-shot fade as the image decodes, rather than popping in (MO-10) —
        // a single opacity transition triggered by `loaded` flipping once,
        // not a loop. motion-reduce shows it immediately: unlike a hover or
        // press crossfade this isn't carrying state, just easing content in.
        className={`absolute inset-0 size-full object-cover transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)] motion-reduce:duration-0 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
      {edgeOverlay}
    </div>
  )
}
