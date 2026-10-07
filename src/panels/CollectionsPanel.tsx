import { PanelHeader } from '../shell/SidePanel'
import type { LeftView } from '../shell/panels'
import type { usePlayback } from '../playback/usePlayback'
import { Favourites } from './Favourites'
import { Playlists } from './Playlists'

/* Collections, for now: the favourites and playlists panels as they were,
 * under one heading, until Collections itself is rebuilt. */
export function CollectionsPanel({
  onFocusNode,
  playback,
}: {
  view: LeftView
  onNavigate: (view: LeftView | null) => void
  onFocusNode: (id: number) => void
  playback: ReturnType<typeof usePlayback>
}) {
  return (
    <div className="flex flex-col gap-[20px]">
      <PanelHeader title="Collections" />
      <Favourites onSelectNode={onFocusNode} playback={playback} />
      <Playlists playback={playback} />
    </div>
  )
}
