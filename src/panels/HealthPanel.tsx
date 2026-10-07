import { Button } from '../ui/Button'
import { PanelHeader } from '../shell/SidePanel'
import type { LeftView } from '../shell/panels'
import { DatabaseInspector } from './DatabaseInspector'
import { TagManager } from './TagManager'

/* Library health, for now: the maintenance worklist (still its modal), the
 * database inspector and the tag manager, under one heading, until Health
 * itself is rebuilt. */
export function HealthPanel({
  onFocusNode,
  onEditNode,
  onOpenMaintenance,
}: {
  view: LeftView
  onNavigate: (view: LeftView | null) => void
  onFocusNode: (id: number) => void
  onEditNode: (id: number) => void
  onOpenMaintenance: () => void
}) {
  return (
    <div className="flex flex-col gap-[20px]">
      <PanelHeader
        title="Library health"
        actions={
          <Button variant="secondary" onClick={onOpenMaintenance}>
            maintenance
          </Button>
        }
      />
      <DatabaseInspector />
      <TagManager onSelectNode={onFocusNode} onEditNode={onEditNode} />
    </div>
  )
}
