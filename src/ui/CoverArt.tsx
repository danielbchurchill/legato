import { useEffect, useState } from 'react'

const API = 'http://127.0.0.1:8899/api/v1'

/* Album art from the cover cache. Square-cornered everywhere in a panel —
 * artwork is reproduced, not restyled (DESIGN.md "Radius").
 *
 * The endpoint 404s for a node with no art, which is a normal state rather
 * than an error, so the fallback is a quiet muted block instead of a broken
 * image icon or an apology. */

type CoverArtProps = {
  nodeId: number | null
  size: 'thumb' | 'full'
  className?: string
  alt?: string
}

export function CoverArt({ nodeId, size, className = '', alt = '' }: CoverArtProps) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Without this, moving from an album that has art to one that does not
  // leaves the previous failure latched and hides art that exists.
  useEffect(() => {
    setFailed(false)
    setLoaded(false)
  }, [nodeId])

  if (nodeId == null || failed) {
    // The no-art fallback doesn't fade (MO-10) — it isn't loading, it's the
    // answer.
    return <div aria-hidden className={`bg-white/6 ${className}`} />
  }

  return (
    <img
      src={`${API}/nodes/${nodeId}/cover?size=${size}`}
      alt={alt}
      draggable={false}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      // One-shot fade as the image decodes, rather than popping in (MO-10) —
      // a single opacity transition triggered by `loaded` flipping once,
      // not a loop. motion-reduce shows it immediately: unlike a hover or
      // press crossfade this isn't carrying state, just easing content in.
      className={`object-cover transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)] motion-reduce:duration-0 ${loaded ? 'opacity-100' : 'opacity-0'} ${className}`}
    />
  )
}
