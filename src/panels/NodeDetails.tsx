import type { DetailsTab } from '../shell/panels'
import type { usePlayback } from '../playback/usePlayback'
import { NodeDetailPages } from './NodeDetailPages'
import { useNodeDetail } from './useNodeDetail'

/* Node details, for now: the old inspector's pages, in the right-hand panel
 * rather than a full-screen modal over the map, until details are rebuilt
 * with tabs of their own. */
export function NodeDetails({
  nodeId,
  playback,
  onFocusNode,
}: {
  nodeId: number
  tab: DetailsTab
  onTabChange: (tab: DetailsTab) => void
  playback: ReturnType<typeof usePlayback>
  onFocusNode: (id: number) => void
}) {
  const { node, reload } = useNodeDetail(nodeId)
  if (!node) return null
  return (
    <NodeDetailPages
      node={node}
      reload={reload}
      isPlaying={nodeId === playback.status.currentRecordingNodeId}
      queueBusy={playback.queueBusy}
      autoEditNodeId={null}
      onAutoEditConsumed={() => {}}
      onSelectNode={onFocusNode}
      onPlay={playback.playNode}
    />
  )
}
