import { Surface } from '../shell/Surface'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { useModalTransition } from '../hooks/useModalTransition'
import { NodeDetailPages } from './NodeDetailPages'
import { NodeTitleBlock } from './NodeTitleBlock'
import { useNodeDetail } from './useNodeDetail'

/* Everything about a node that doesn't fit on the canvas card: its full
 * metadata with the edit -> diff -> approve write-back flow, its generated
 * facts, its manual edges and the form that adds them, lyrics, and whatever
 * prose exists about it.
 *
 * This is where the old select state's contents went. Selecting a node now
 * shows the card in place on the graph (canvas/NodeCard.tsx), and the card
 * opens this — so the depth is still one click away, but it is a click, not
 * something that happens to the right-hand panel every time the pointer
 * lands on a node.
 *
 * Same overlay shape as HygieneView, down to the shared useModalTransition:
 * a blurred scrim over the canvas and one glass sheet, arriving at
 * --motion-base and leaving at --motion-exit. The scrim is not a dismiss
 * target here either — Escape and the close control are the two ways out of
 * every modal in the app, and adding a third to one of them would make the
 * other one feel broken. */

type NodeInspectorProps = {
  nodeId: number
  isPlaying: boolean
  /** Set when this inspector was opened via TagManager's "edit" action
   * (issue #65) — the id of the node to drop straight into edit mode on,
   * once. See NodeDetailPages.tsx for where it's consumed. */
  autoEditNodeId: number | null
  onAutoEditConsumed: () => void
  onSelectNode: (id: number) => void
  onPlay: (nodeId: number, title: string) => void
  onClose: () => void
}

export function NodeInspector({
  nodeId,
  isPlaying,
  autoEditNodeId,
  onAutoEditConsumed,
  onSelectNode,
  onPlay,
  onClose,
}: NodeInspectorProps) {
  const { phase, requestClose } = useModalTransition(onClose)
  const { node, reload } = useNodeDetail(nodeId)

  const duration = phase === 'exiting' ? 'duration-[var(--motion-exit)]' : 'duration-[var(--motion-base)]'
  const entered = phase === 'entered'

  return (
    <div
      className={`fixed inset-0 z-30 flex items-center justify-center bg-[var(--color-canvas)]/40 p-[60px] backdrop-blur-[var(--blur-glass)] transition-opacity ${duration} ease-[var(--ease-out)] ${entered ? 'opacity-100' : 'opacity-0'}`}
    >
      <Surface
        className={`flex max-h-full w-full max-w-[900px] flex-col overflow-hidden transition-all ${duration} ease-[var(--ease-out)] motion-reduce:scale-100 ${entered ? 'scale-100 opacity-100' : 'scale-[0.985] opacity-0'}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-divider)] px-[var(--spacing-panel)] py-[21px]">
          <h2 className="text-[length:var(--text-base)] font-normal text-[var(--color-muted)]">selected</h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)]"
          >
            <Icon name="cancel" size={24} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-[var(--spacing-panel)] pb-[var(--spacing-panel)]">
          {node ? (
            // Two columns rather than the panel's single narrow one: the
            // sheet is 900px wide, and stacking a 255px cover above a
            // 314px-wide pager in that space would leave most of it empty.
            <div className="flex gap-[25px] pt-[var(--spacing-panel)]">
              <div className="w-[255px] shrink-0">
                <CoverArt
                  nodeId={node.id}
                  size="full"
                  alt={`Cover art for ${node.title}`}
                  className="aspect-square w-full"
                />
                <NodeTitleBlock node={node} />
              </div>
              <div className="min-w-0 flex-1">
                <NodeDetailPages
                  node={node}
                  reload={reload}
                  isPlaying={isPlaying}
                  autoEditNodeId={autoEditNodeId}
                  onAutoEditConsumed={onAutoEditConsumed}
                  onSelectNode={onSelectNode}
                  onPlay={onPlay}
                />
              </div>
            </div>
          ) : (
            <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
              loading…
            </p>
          )}
        </div>
      </Surface>
    </div>
  )
}
