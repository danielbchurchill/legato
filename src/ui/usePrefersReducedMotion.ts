import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function readReduced(mql: MediaQueryList): boolean {
  return mql.matches || document.documentElement.dataset.reducedMotion === 'true'
}

/* Reactive counterpart to Canvas.tsx's own one-shot prefersReducedMotion()
 * check — that one reads the query imperatively at animation-trigger time,
 * this one needs to drive a React className/style and re-render if the OS
 * setting changes mid-session. Kept separate rather than shared: Canvas.tsx
 * isn't a component and has no render to trigger.
 *
 * Also honours Legato Settings' own "reduce motion" force-on override, which
 * App.tsx mirrors onto documentElement's data-reduced-motion attribute (see
 * index.css). This hook used to read the OS query alone, so a component
 * handling its own motion — Disclosure's row height, a popup's enter slide —
 * ignored the in-app setting that index.css's CSS-only rule already obeyed. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => readReduced(window.matchMedia(QUERY)))

  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = () => setReduced(readReduced(mql))
    mql.addEventListener('change', onChange)
    const observer = new MutationObserver(onChange)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    return () => {
      mql.removeEventListener('change', onChange)
      observer.disconnect()
    }
  }, [])

  return reduced
}
