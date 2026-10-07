import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton } from '../ui/IconButton'
import { formatCount } from '../ui/format'
import { useShellLayout } from '../shell/layout'

/* The map's own floating chrome, sitting on the player's row: the legend
 * pill on the left, the toolbar on the right, and the map options popover
 * the toolbar opens. All three follow the side panels' occupancy so they
 * stay in the free space. */

const LEGEND = [
  { type: 'artist', label: 'artists', dot: 9, color: 'var(--color-node-artist)' },
  { type: 'release', label: 'albums', dot: 7, color: 'var(--color-node-release)' },
  { type: 'recording', label: 'tracks', dot: 5, color: 'var(--color-node-recording)' },
  { type: 'credit', label: 'producers', dot: 6, color: 'var(--color-node-credit)' },
] as const

/* What the dots mean, with how many of each the library holds. The dot sizes
 * echo the map's own (an artist is the biggest), so the key reads as a
 * scale as well as a palette. Producers only appear while they're shown. */
export function MapLegend({ counts, showProducers }: { counts: Record<(typeof LEGEND)[number]['type'], number>; showProducers: boolean }) {
  const layout = useShellLayout()
  return (
    <div
      className="glass absolute z-10 flex h-[34px] items-center gap-[14px] rounded-full px-[14px] text-small text-[var(--color-ink-2)]"
      style={{ left: layout.leftOccupancy + 16, bottom: layout.floatingBottom }}
    >
      {LEGEND.filter((item) => item.type !== 'credit' || showProducers).map((item) => (
        <span key={item.type} className="flex items-center gap-[6px] whitespace-nowrap">
          <span
            aria-hidden="true"
            className="shrink-0 rounded-full"
            style={{ width: item.dot, height: item.dot, background: item.color }}
          />
          <span className="mono">{formatCount(counts[item.type])}</span> {item.label}
        </span>
      ))}
    </div>
  )
}

type MapToolbarProps = {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  options: ReactNode
}

/* Zoom, fit, and the map options. Map settings used to be a whole rail
 * destination; they're about the map, so they live on it. */
export function MapToolbar({ onZoomIn, onZoomOut, onFit, options }: MapToolbarProps) {
  const layout = useShellLayout()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Outside press or Escape closes the popover. Escape is claimed (default
  // prevented) so the shell's own Escape doesn't also close a panel.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element
      // A select's listbox is portaled to <body>; pressing it isn't outside.
      if (rootRef.current?.contains(target) || target.closest?.('[role="listbox"]')) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return (
    <div ref={rootRef}>
      <div
        role="toolbar"
        aria-label="Map"
        aria-orientation="vertical"
        className="glass absolute z-10 flex flex-col gap-[2px] rounded-[var(--radius-card)] p-[4px]"
        style={{ right: layout.rightOccupancy + 12, bottom: layout.floatingBottom }}
      >
        <IconButton icon="add" label="Zoom in" size={36} onClick={onZoomIn} tooltipPlacement="left" />
        <IconButton icon="subtract" label="Zoom out" size={36} onClick={onZoomOut} tooltipPlacement="left" />
        <span aria-hidden="true" className="mx-[6px] my-[2px] h-px bg-[var(--color-line)]" />
        <IconButton icon="eye" label="Fit the map" size={36} onClick={onFit} tooltipPlacement="left" />
        <IconButton
          icon="sliders"
          label="Map options"
          size={36}
          active={open}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((v) => !v)}
          tooltipPlacement="left"
        />
      </div>
      {open && (
        <div
          role="dialog"
          aria-label="Map options"
          className="glass absolute z-20 flex w-[300px] flex-col gap-[14px] rounded-[var(--radius-rail)] p-[16px]"
          style={{ right: layout.rightOccupancy + 68, bottom: layout.floatingBottom }}
        >
          {options}
        </div>
      )}
    </div>
  )
}
