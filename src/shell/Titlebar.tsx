import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { Surface } from './Surface'
import { appWindow } from './tauriWindow'

/* The frameless window's own chrome: centered wordmark, three custom controls.
 *
 * Glyphs are the ones the mockup specifies. proicons' `spacebar` is the
 * key-shaped mark used for minimize; `arrow-minimize` is the collapse-inward
 * pair used for maximize/restore. */

type Control = { name: IconName; label: string; action: () => void }

function WindowButton({ control }: { control: Control }) {
  return (
    <button
      type="button"
      onClick={control.action}
      aria-label={control.label}
      title={control.label}
      // Muted at rest so the chrome stays quiet, full white on hover — the
      // only hover affordance in the titlebar.
      className="grid h-[32px] w-[32px] place-items-center rounded-[6px] text-[var(--color-muted)] transition-colors duration-150 hover:bg-white/8 hover:text-[var(--color-ink)]"
    >
      <Icon name={control.name} size={24} />
    </button>
  )
}

export function Titlebar() {
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
    <Surface edges="bottom" className="relative z-20 h-[61px] shrink-0">
      {/* The drag region is the bar itself; the buttons are children without
       * the attribute, so they stay clickable. */}
      <div data-tauri-drag-region className="flex h-full items-center justify-center">
        <span className="pointer-events-none select-none font-[family-name:var(--font-display)] text-[length:var(--text-wordmark)] leading-none text-[var(--color-ink)]">
          legato
        </span>
      </div>

      <div className="absolute inset-y-0 right-[14px] flex items-center gap-[18px]">
        {controls.map((control) => (
          <WindowButton key={control.label} control={control} />
        ))}
      </div>
    </Surface>
  )
}
