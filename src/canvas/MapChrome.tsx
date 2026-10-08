import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton } from '../ui/IconButton'
import { useShellLayout } from '../shell/layout'

/* The map's own floating chrome, sitting on the player's row at the right:
 * the toolbar, and the map options popover it opens. Both follow the right
 * panel's occupancy so they stay in the free space. The map had a legend
 * pill at the left, counting each node type; the library view's header
 * carries those counts, and the map has the room back. */

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
