import { useContext, type ReactNode } from 'react'
import { useGraph } from '../canvas/graphContext'
import { CoverArt } from '../ui/CoverArt'
import { IconButton } from '../ui/IconButton'
import { plural } from '../ui/format'
import { useTouchLayout } from '../ui/touchLayout'
import { InsightsActionsContext, drawnFocus, splitFocus, useDrawn, type Ref, type Tie } from './insightsData'

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
  const drawn = useDrawn()
  return ids.filter(drawn)
}

/** `lights`, when given, says what a click lights in place of `focus`'s
 * nodes on the map, worked out as it's clicked: a path's, or a row's with
 * witnesses, takes a pass over every edge. */
export function MapButton({ focus, label = 'Show on map', lights }: { focus: number[]; label?: string; lights?: () => number[] }) {
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
      onClick={() => onShowOnMap(lights ? lights() : onMap)}
    />
  )
}

/** #504: what a row's map button lights. Without `ties`, the nodes of its
 * focus the map draws. With them, the focus also carries the tracks or
 * albums that witness the row's ties, and a click lights by the path card's
 * drawn-step rule (drawnFocus), so a tie through a person the map hides
 * lights no stub from each artist. The button shows while the map draws
 * any of the row's ends. */
function useRowLights(focus: number[], ties?: (ends: number[]) => readonly Tie[]): { ends: number[]; lights?: () => number[] } {
  const { byId, edges } = useGraph()
  const drawn = useDrawn()
  if (!ties) return { ends: focus }
  const { ends, witnesses } = splitFocus(focus, (id) => byId.get(id)?.type)
  return { ends, lights: () => drawnFocus(ends, ties(ends), witnesses, drawn, edges) }
}

/** A row: a sentence, who it's by, a quieter line under it, and its map
 * button. `ties`, for a row whose focus carries witnesses, pairs up its
 * ends: the focus's nodes that aren't tracks or albums. */
export function Row({
  children,
  by,
  meta,
  focus,
  ties,
  cover,
}: {
  children: ReactNode
  by?: Ref | null
  meta?: ReactNode
  focus: number[]
  ties?: (ends: number[]) => readonly Tie[]
  cover?: number
}) {
  const touch = useTouchLayout()
  const { ends, lights } = useRowLights(focus, ties)
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
        {by && (
          <p
            className={`[overflow-wrap:anywhere] text-[var(--color-ink-2)] ${touch ? '-mt-[8px] text-[13px] leading-[44px]' : 'text-small'}`}
          >
            by <Name node={by} />
          </p>
        )}
        {meta && <p className={`text-[var(--color-ink-2)] ${touch ? '-mt-[4px] text-[13px] leading-[18px]' : 'text-small'}`}>{meta}</p>}
      </div>
      <MapButton focus={ends} lights={lights} />
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
          ? 'touch-target inline-flex h-[32px] max-w-full items-center rounded-full bg-[var(--color-wash-2)] px-[12px] text-left align-baseline font-medium text-[var(--color-ink)]'
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
  // Kept on one line, so "and 2 more" never breaks after the number.
  if (more > 0) out.push(<span key="more" className="whitespace-nowrap">{` and ${plural(more, 'more', 'more')}`}</span>)
  return <>{out}</>
}

/** A count in mono, at the end of a row. */
export function Count({ children }: { children: ReactNode }) {
  return <span className="mono shrink-0 text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{children}</span>
}
