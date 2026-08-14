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

  // Without this, moving from an album that has art to one that does not
  // leaves the previous failure latched and hides art that exists.
  useEffect(() => setFailed(false), [nodeId])

  if (nodeId == null || failed) {
    return <div aria-hidden className={`bg-white/6 ${className}`} />
  }

  return (
    <img
      src={`${API}/nodes/${nodeId}/cover?size=${size}`}
      alt={alt}
      draggable={false}
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  )
}
