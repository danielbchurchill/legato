import { Fragment, useMemo, useState } from 'react'
import { Combobox } from '../ui/Combobox'
import { useTouchLayout } from '../ui/touchLayout'
import { useFetched } from './healthData'
import { MapButton, Name } from './InsightsParts'
import { stepWords, type Path, type Ref } from './insightsData'

/* #468's "How are these connected?": two of your artists, and the shortest
 * way between them through members, producers, labels and tracks they
 * share, each step named (GET /insights/path). It opens on the two the
 * server suggests, far apart, and either can be changed. */

export function InsightsPath({ suggestion }: { suggestion: { from: Ref; to: Ref } | null }) {
  const touch = useTouchLayout()
  // Every artist, once, for the pickers: a few thousand names at most.
  const { data: artists } = useFetched<Ref[]>('/insights/artists?limit=10000', [])
  const options = useMemo(() => (artists ?? []).map((a) => ({ value: String(a.id), label: a.title })), [artists])
  const [from, setFrom] = useState<string | null>(null)
  const [to, setTo] = useState<string | null>(null)
  const fromId = from ?? (suggestion ? String(suggestion.from.id) : null)
  const toId = to ?? (suggestion ? String(suggestion.to.id) : null)
  // Until the list arrives, the suggestion's two are the only options.
  const shown =
    options.length > 0 ? options : suggestion ? [suggestion.from, suggestion.to].map((a) => ({ value: String(a.id), label: a.title })) : []

  const { data } = useFetched<{ path: Path | null }>(
    fromId && toId && fromId !== toId ? `/insights/path?from=${fromId}&to=${toId}` : null,
    [],
  )
  const path = data?.path ?? null
  const label = (id: string | null) => shown.find((o) => o.value === id)?.label ?? ''

  return (
    <div className="flex flex-col gap-[10px]">
      <div className={`grid gap-[8px] ${touch ? 'grid-cols-1' : 'grid-cols-[auto_minmax(0,1fr)] items-center'}`}>
        {!touch && <span className="text-small text-[var(--color-ink-2)]">from</span>}
        <Combobox
          label="From artist"
          options={shown}
          value={fromId}
          onChange={setFrom}
          placeholder="an artist…"
          className={touch ? 'h-[44px]!' : ''}
        />
        {!touch && <span className="text-small text-[var(--color-ink-2)]">to</span>}
        <Combobox
          label="To artist"
          options={shown}
          value={toId}
          onChange={setTo}
          placeholder="another artist…"
          className={touch ? 'h-[44px]!' : ''}
        />
      </div>
      {fromId != null && toId != null && fromId !== toId && data != null && (
        <div aria-live="polite">
          {path == null ? (
            <p className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
              Nothing joins {label(fromId)} and {label(toId)} yet.
            </p>
          ) : (
            <div className="flex items-start gap-[10px]">
              <ol aria-label="The way between them" className="min-w-0 flex-1">
                {path.nodes.map((node, i) => (
                  <Fragment key={`${node.id}:${i}`}>
                    {i > 0 && (
                      <li
                        className={`ml-[3px] border-l border-[var(--color-line-strong)] pl-[13px] text-[var(--color-ink-2)] ${
                          touch ? 'py-[2px] text-[13px] leading-[18px]' : 'py-[1px] text-small'
                        }`}
                      >
                        {stepWords(path.links[i - 1]!)}
                      </li>
                    )}
                    <li
                      className={`flex items-center gap-[8px] ${touch ? 'min-h-[44px] text-[15px]' : 'text-[length:var(--text-body)] leading-[20px]'}`}
                    >
                      <span
                        aria-hidden
                        className={`size-[7px] shrink-0 rounded-full ${node.type === 'artist' ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-ink-3)]'}`}
                      />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <Name node={node} />
                      </span>
                    </li>
                  </Fragment>
                ))}
              </ol>
              <MapButton focus={path.focus} label="Show the way on the map" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
