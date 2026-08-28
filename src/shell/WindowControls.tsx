import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { appWindow } from './tauriWindow'

/* The frameless window's own controls — minimize/maximize/close — factored
 * out of the old single Titlebar now that it has split into two separate
 * glass headers (LeftPanelHeader, RightPanelHeader; see DESIGN.md's shell
 * section). They live in RightPanelHeader, which already owns the window's
 * top-right corner: the OS-conventional home for this cluster, and the
 * Figma mockup has nothing to say about it either way — it has no native
 * window chrome to measure against at all. That placement is this file's
 * own call, not a measured value. */

type Control = { name: IconName; label: string; action: () => void }

function WindowButton({ control }: { control: Control }) {
  return (
    <Tooltip label={control.label}>
      <button
        type="button"
        onClick={control.action}
        aria-label={control.label}
        // Muted at rest so the chrome stays quiet, full white on hover — the
        // only hover affordance in the header outside its own icons.
        className="grid h-[32px] w-[32px] place-items-center rounded-[6px] text-[var(--color-muted)] transition-colors duration-150 hover:bg-white/8 hover:text-[var(--color-muted-hi)]"
      >
        <Icon name={control.name} size={24} />
      </button>
    </Tooltip>
  )
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  // The maximize glyph has to track state changes the buttons never see —
  // a WM keyboard shortcut, a double-click, a tiling change.
  useEffect(() => {
    let disposed = false
    let unlisten = () => {}

    const sync = async () => {
      const value = await appWindow.isMaximized()
      if (!disposed && value != null) setMaximized(value)
    }

    void sync()
    void appWindow.onResized(sync).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })

    return () => {
      disposed = true
      unlisten()
    }
  }, [])

  const controls: Control[] = [
    { name: 'spacebar', label: 'Minimize', action: () => void appWindow.minimize() },
    {
      name: 'arrow-minimize',
      label: maximized ? 'Restore' : 'Maximize',
      action: () => void appWindow.toggleMaximize(),
    },
    { name: 'cancel', label: 'Close', action: () => void appWindow.close() },
  ]

  return (
    <div className="flex items-center gap-[18px]">
      {controls.map((control) => (
        <WindowButton key={control.label} control={control} />
      ))}
    </div>
  )
}
