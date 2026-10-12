import { createContext, useContext } from 'react'

/* True inside the phone's pushed pages (#389), which are laid out for a
 * finger: every Button takes taps across at least 44px each way however
 * small it's drawn (the `touch-target` utility, index.css), and settings
 * groups draw as the phone's grouped cards (SettingsPrimitives.tsx). So a
 * desktop control can sit on a phone page as it is, without a copy.
 * Split from the components that read it, per react/only-export-components. */
export const TouchLayoutContext = createContext(false)

export function useTouchLayout(): boolean {
  return useContext(TouchLayoutContext)
}
