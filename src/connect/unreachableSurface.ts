import { createContext, useContext, useEffect } from 'react'
import type { UnreachableView } from './ServerUnreachable'

/* Where the unreachable state (#119) draws. The shell, when it's mounted,
 * draws it itself, under its player; App.tsx draws the whole-window form
 * only when nothing has claimed it. A count rather than a flag, so a
 * remount that mounts the new shell before unmounting the old one can't
 * leave it unclaimed. */
export type UnreachableSurface = { view: UnreachableView | null; claim: () => () => void }

export const UnreachableContext = createContext<UnreachableSurface>({ view: null, claim: () => () => {} })

/** For the shell: claims the state for as long as it's mounted, and returns
 * it while the server is unreachable. */
export function useUnreachableInShell(): UnreachableView | null {
  const { view, claim } = useContext(UnreachableContext)
  useEffect(() => claim(), [claim])
  return view
}
