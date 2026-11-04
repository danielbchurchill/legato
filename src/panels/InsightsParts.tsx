import { useContext, type ReactNode } from 'react'
import { useGraph } from '../canvas/graphContext'
import { CoverArt } from '../ui/CoverArt'
import { IconButton } from '../ui/IconButton'
import { plural } from '../ui/format'
import { useTouchLayout } from '../ui/touchLayout'
import { InsightsActionsContext, type Ref } from './insightsData'

/* #468: what every Insights card is made of (InsightsPanel.tsx). On the
 * desktop a card is a wash card in the panel; on the phone's page it's one
 * of the phone's grouped cards, and each name is a pill on a 44px line, so
 * every name takes a finger (DESIGN.md: every tap target is at least 44px). */

export function Card({ title, about, children }: { title: string; about?: ReactNode; children: ReactNode }) {
  const touch = useTouchLayout()
  return (
    <section
      aria-label={title}
      className={
        touch
          ? 'mt-[16px] rounded-[16px] border border-[var(--color-line)] bg-[var(--color-solid)] p-[16px]'
          : 'mt-[12px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[14px]'
      }
    >
      <h3 className={touch ? 'text-[17px] leading-[22px] font-medium text-[var(--color-ink)]' : 'text-heading text-[var(--color-ink)]'}>
        {title}
      </h3>
      {about && <p className={`mt-[2px] text-[var(--color-ink-2)] ${touch ? 'text-[13px] leading-[18px]' : 'text-small'}`}>{about}</p>}
      <div className="mt-[10px]">{children}</div>
    </section>
  )
}

/** The nodes of `ids` the map draws: "show on map" lights only those. */
function useOnMap(ids: number[]): number[] {
  const { byId } = useGraph()
  return ids.filter((id) => byId.has(id))
}

export function MapButton({ focus, label = 'Show on map' }: { focus: number[]; label?: string }) {
  const { onShowOnMap } = useContext(InsightsActionsContext)
  const touch = useTouchLayout()
  const onMap = useOnMap(focus)
  if (onMap.length === 0) return null
  return (
    <IconButton
      icon="map"
      label={label}
      size={touch ? 44 : 28}
      iconSize={touch ? 20 : 16}
      tone="ink-3"
      className={touch ? '-my-[8px] -mr-[10px]' : '-my-[2px]'}
      onClick={() => onShowOnMap(onMap)}
    />
  )
}

/** A row: a sentence, a quieter line under it, and its map button. */
export function Row({ children, meta, focus, cover }: { children: ReactNode; meta?: ReactNode; focus: number[]; cover?: number }) {
  const touch = useTouchLayout()
  return (
    <li className="flex items-start gap-[10px]">
      {cover != null && (
        <CoverArt nodeId={cover} size="thumb" radius="sm" className={`mt-[2px] shrink-0 ${touch ? 'size-[44px]' : 'size-[36px]'}`} />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={`[overflow-wrap:anywhere] text-[var(--color-ink)] ${
            touch ? 'text-[15px] leading-[44px]' : 'text-[length:var(--text-body)] leading-[20px]'
          }`}
        >
          {children}
        </p>
        {meta && <p className={`text-[var(--color-ink-2)] ${touch ? '-mt-[4px] text-[13px] leading-[18px]' : 'text-small'}`}>{meta}</p>}
      </div>
      <MapButton focus={focus} />
    </li>
  )
}

export function Rows({ children }: { children: ReactNode }) {
  const touch = useTouchLayout()
  return <ul className={`flex flex-col ${touch ? 'gap-[10px]' : 'gap-[10px]'}`}>{children}</ul>
}

/** A name that opens its details. A pill on a 44px line on the phone. */
export function Name({ node }: { node: Ref }) {
  const { onOpenNode } = useContext(InsightsActionsContext)
  const touch = useTouchLayout()
  return (
    <button
      type="button"
      onClick={() => onOpenNode(node.id)}
      className={
        touch
          ? 'touch-target inline h-[32px] rounded-full bg-[var(--color-wash-2)] px-[12px] align-middle font-medium text-[var(--color-ink)] [box-decoration-break:clone]'
          : 'inline text-left font-medium text-[var(--color-ink)] decoration-[var(--color-line-strong)] underline-offset-2 transition-colors duration-[var(--motion-fast)] hover:underline'
      }
    >
      {node.title}
    </button>
  )
}

/** "A, B and C", or "A, B, C and 4 more", each a name. */
export function Names({ nodes, total = nodes.length, max = 3 }: { nodes: Ref[]; total?: number; max?: number }) {
  const shown = nodes.slice(0, max)
  const more = total - shown.length
  const parts: ReactNode[] = shown.map((node) => <Name key={node.id} node={node} />)
  const out: ReactNode[] = []
  parts.forEach((part, i) => {
    if (i > 0) out.push(i === parts.length - 1 && more === 0 ? ' and ' : ', ')
    out.push(part)
  })
  if (more > 0) out.push(` and ${plural(more, 'more', 'more')}`)
  return <>{out}</>
}

/** A count in mono, at the end of a row. */
export function Count({ children }: { children: ReactNode }) {
  return <span className="mono shrink-0 text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{children}</span>
}
