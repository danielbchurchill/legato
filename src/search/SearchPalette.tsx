import { useEffect, useRef, useState } from 'react'
import { CollectionPanel, type CollectionPanelHandle } from '../panels/CollectionPanel'
import { useShellLayout } from '../shell/layout'
import type { usePlayback } from '../playback/usePlayback'

/* Search, for now: the old collection panel's search field and maintenance
 * preview, opened in the capsule's place, until the palette is built. */
export function SearchPalette({
  onClose,
  onOpen,
  onOpenMaintenance,
  playback,
}: {
  onClose: () => void
  onOpen: (id: number) => void
  onOpenMaintenance: () => void
  playback: ReturnType<typeof usePlayback>
}) {
  const layout = useShellLayout()
  const [query, setQuery] = useState('')
  const panelRef = useRef<CollectionPanelHandle>(null)
  useEffect(() => {
    panelRef.current?.focusSearch()
  }, [])

  return (
    <div
      className="absolute inset-0 z-40"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        aria-hidden="true"
        onPointerDown={onClose}
        className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-canvas)_50%,transparent)] backdrop-blur-[4px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="glass absolute top-[var(--inset)] max-h-[calc(100%-24px)] -translate-x-1/2 overflow-y-auto rounded-[var(--radius-panel)] p-[20px]"
        style={{ left: layout.cx, width: Math.min(480, layout.width - 24) }}
      >
        <CollectionPanel
          ref={panelRef}
          onSelectNode={onOpen}
          onOpenMaintenance={onOpenMaintenance}
          playback={playback}
          query={query}
          onQueryChange={setQuery}
        />
      </div>
    </div>
  )
}
