import { getCurrentWindow } from '@tauri-apps/api/window'

/* Turning decorations off takes the window manager's resize borders with it,
 * so a frameless window cannot be resized by dragging its edges unless we put
 * the grab zones back. Without this, going frameless is a straight regression
 * from the decorated window it replaces.
 *
 * Eight invisible strips pinned to the window edge, each starting a native
 * resize drag. The WM does the actual resizing — these only tell it which
 * direction the user grabbed. */

type Zone = {
  direction: string
  className: string
  cursor: string
}

// Written out literally rather than interpolated from constants: Tailwind
// scans source statically, so a class built from a template literal is never
// generated and the zone silently ends up with no size at all.
const ZONES: Zone[] = [
  { direction: 'North', className: 'top-0 left-0 right-0 h-[5px]', cursor: 'ns-resize' },
  { direction: 'South', className: 'bottom-0 left-0 right-0 h-[5px]', cursor: 'ns-resize' },
  { direction: 'West', className: 'left-0 top-0 bottom-0 w-[5px]', cursor: 'ew-resize' },
  { direction: 'East', className: 'right-0 top-0 bottom-0 w-[5px]', cursor: 'ew-resize' },
  // Corners come last so they stack above the edges they overlap.
  { direction: 'NorthWest', className: 'top-0 left-0 w-[12px] h-[12px]', cursor: 'nwse-resize' },
  { direction: 'NorthEast', className: 'top-0 right-0 w-[12px] h-[12px]', cursor: 'nesw-resize' },
  { direction: 'SouthWest', className: 'bottom-0 left-0 w-[12px] h-[12px]', cursor: 'nesw-resize' },
  { direction: 'SouthEast', className: 'bottom-0 right-0 w-[12px] h-[12px]', cursor: 'nwse-resize' },
]

async function startResize(direction: string) {
  try {
    // Cast: the enum is a plain string union at runtime, and importing the
    // ResizeDirection enum value pulls Tauri internals into the browser-only
    // build path where getCurrentWindow() already cannot resolve.
    await getCurrentWindow().startResizeDragging(direction as never)
  } catch {
    // No Tauri window (plain browser tab) — nothing to resize.
  }
}

export function ResizeHandles() {
  return (
    <>
      {ZONES.map((zone) => (
        <div
          key={zone.direction}
          onMouseDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            void startResize(zone.direction)
          }}
          style={{ cursor: zone.cursor }}
          className={`fixed z-50 ${zone.className}`}
        />
      ))}
    </>
  )
}
