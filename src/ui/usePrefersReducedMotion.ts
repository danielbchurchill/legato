import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/* Reactive counterpart to Canvas.tsx's own one-shot prefersReducedMotion()
 * check — that one reads the query imperatively at animation-trigger time,
 * this one needs to drive a React className/style and re-render if the OS
 * setting changes mid-session. Kept separate rather than shared: Canvas.tsx
 * isn't a component and has no render to trigger. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = () => setReduced(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}
