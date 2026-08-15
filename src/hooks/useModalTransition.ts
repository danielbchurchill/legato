import { useEffect, useRef, useState } from 'react'

type Phase = 'entering' | 'entered' | 'exiting'

// --motion-exit — mirrored here since a JS timeout can't read a CSS var.
const EXIT_MS = 120

/* Modal entry/exit (MO-8). App.tsx mounts these modals on a plain boolean
 * (`open && <Modal onClose={...} />`), which would normally unmount before
 * an exit transition ever got a frame to play — clicking close would just
 * cut. This intercepts the close request, holds the modal mounted for
 * --motion-exit while it plays its exit classes, then calls the real
 * onClose. Escape also routes through requestClose, since it needs the
 * same held-open beat as every other way of closing.
 *
 * `entering` -> `entered` on the next frame is the same "mount at the
 * from-state, flip on the next paint" trick Tooltip.tsx uses — a
 * transition can't animate from and to the same paint. */
export function useModalTransition(onClose: () => void) {
  const [phase, setPhase] = useState<Phase>('entering')
  const closingRef = useRef(false)

  const requestClose = () => {
    if (closingRef.current) return
    closingRef.current = true
    setPhase('exiting')
    setTimeout(onClose, EXIT_MS)
  }

  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase('entered'))
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { phase, requestClose }
}
