import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { PanelHeader } from '../shell/SidePanel'
import { SectionLabel } from '../ui/SectionLabel'
import { Shimmer, Skeleton } from '../ui/Skeleton'
import { formatCount, plural } from '../ui/format'
import { InsightsPath } from './InsightsPath'
import { Card, Count, Name, Names, Row, Rows } from './InsightsParts'
import {
  cardsWithSomethingToSay,
  hubTies,
  monthYear,
  peakDecade,
  roleWords,
  useInsights,
  webLine,
  InsightsActionsContext,
  type CardId,
  type InsightsActions,
  type ReadyInsights,
  type Tie,
} from './insightsData'

/* #468: Insights, the rail item under Library health. A set of cards about
 * how this library connects, each from its own data (GET /insights): who
 * links its artists, who they share, what sounds alike with nothing between,
 * what's played and what's waiting. Each says it in a sentence. Every name
 * opens its details, and each row's map button lights what it's about on the
 * map. A card with nothing to say isn't drawn.
 *
 * #504: a row whose focus carries the tracks or albums that witness its
 * ties (Bridges, Shared producers, Shared labels, Recorded together) says
 * which of its ends each tie joins, and its map button lights by the path
 * card's drawn-step rule: a tie through a producer the map options hide,
 * or a label, lights no stub from each artist.
 *
 * The phone draws the same cards on its pushed page (PhonePages.tsx), as the
 * phone's grouped cards, with each name a pill on a 44px line so it takes a
 * finger. */

type InsightsPanelProps = InsightsActions & {
  /** On the phone's page, which has its own title. */
  phone?: boolean
}

export function InsightsPanel({ onOpenNode, onShowOnMap, drawsKind, phone = false }: InsightsPanelProps) {
  const insights = useInsights()
  return (
    <InsightsActionsContext.Provider value={{ onOpenNode, onShowOnMap, drawsKind }}>
      <div className="flex flex-col">
        {!phone && <PanelHeader title="Insights" />}
        {insights == null ? (
          <Loading phone={phone} />
        ) : insights.state === 'empty' ? (
          <p className="mt-[40px] px-[12px] text-center text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
            Insights appear here once your library is scanned: who links your artists, what you play most and what's waiting for you.
          </p>
        ) : (
          <Cards insights={insights} phone={phone} />
        )}
      </div>
    </InsightsActionsContext.Provider>
  )
}

/* Nothing for the first 400ms, then three cards' worth of placeholder. */
function Loading({ phone }: { phone: boolean }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 400)
    return () => clearTimeout(timer)
  }, [])
  if (!shown) return null
  return (
    <div aria-label="Loading" className="flex flex-col gap-[12px] pt-[12px]">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className={`h-[120px] w-full ${phone ? 'rounded-[16px]' : 'rounded-[var(--radius-card)]'}`} />
      ))}
    </div>
  )
}

function Cards({ insights, phone }: { insights: ReadyInsights; phone: boolean }) {
  const cards = cardsWithSomethingToSay(insights)
  const lead = webLine(insights.web)
  return (
    <>
      {insights.state === 'pending' ? (
        <p
          className={`text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)] ${phone ? 'px-[4px] pt-[8px]' : 'mt-[6px]'}`}
        >
          <Shimmer>Working out how your library connects…</Shimmer>
        </p>
      ) : (
        lead && (
          <p
            className={`text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)] ${phone ? 'px-[4px] pt-[8px]' : 'mt-[6px]'}`}
          >
            {lead}
          </p>
        )
      )}
      {cards.length === 0 && insights.state === 'ready' && (
        <p className="mt-[32px] px-[12px] text-center text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
          Nothing to say yet. As credits, band members and plays come in, the cards fill up here.
        </p>
      )}
      {cards.map((id) => (
        <Fragment key={id}>{CARD[id](insights)}</Fragment>
      ))}
    </>
  )
}

/* ---- The cards, in the panel's order ---- */

const CARD: Record<CardId, (insights: ReadyInsights) => ReactNode> = {
  bridges: ({ bridges }) => (
    <Card title="Bridges" about="The people who link the most of your artists.">
      <Rows>
        {bridges.map((row) => (
          <Row
            key={row.person.id}
            focus={row.focus}
            ties={hubTies(row.person.id)}
            meta={[roleWords(row.roles), row.ownRecords ? 'has records of their own' : null].filter(Boolean).join(' · ')}
          >
            <Name node={row.person} /> links <Names nodes={row.artists} total={row.total} />
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  path: ({ pathSuggestion }) => (
    <Card title="How are these connected?" about="Pick two of your artists to see what joins them, step by step.">
      <InsightsPath suggestion={pathSuggestion} />
    </Card>
  ),

  bandFamilies: ({ bandFamilies }) => (
    <Card title="Band families" about="Groups and solo artists joined by who played in them.">
      <Rows>
        {bandFamilies.map((row) => (
          <Row key={row.artists[0]!.id} focus={row.focus} meta={`${row.total} of your artists`}>
            <Names nodes={row.artists} total={row.total} max={4} />
            {row.through.length > 0 ? (
              <>
                {' '}
                are joined through <Names nodes={row.through} max={2} />
              </>
            ) : (
              ' are one family'
            )}
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  sharedPeople: ({ sharedPeople }) => (
    <Card title="Shared producers" about="Artists who had the same producer or engineer.">
      <Rows>
        {sharedPeople.map((row) => (
          <Row
            key={`${row.artists[0].id}:${row.artists[1].id}`}
            focus={row.focus}
            ties={() => row.people.flatMap(({ person }) => row.artists.map((artist): Tie => [artist.id, person.id]))}
            meta={
              [...new Set(row.people.flatMap((p) => p.roles))].length === 1
                ? roleWords(row.people[0]!.roles)
                : row.people.map((p) => `${p.person.title}: ${roleWords(p.roles)}`).join(' · ')
            }
          >
            <Name node={row.artists[0]} /> and <Name node={row.artists[1]} /> share <Names nodes={row.people.map((p) => p.person)} />
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  recordedTogether: ({ recordedTogether }) => (
    <Card title="Recorded together" about="Your artists on the same tracks.">
      <Rows>
        {recordedTogether.map((row) => (
          <Row key={`${row.artists[0].id}:${row.artists[1].id}`} focus={row.focus} ties={() => [[row.artists[0].id, row.artists[1].id]]}>
            <Name node={row.artists[0]} /> and <Name node={row.artists[1]} /> are on{' '}
            {row.tracks === 1 ? 'a track' : `${formatCount(row.tracks)} tracks`} together
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  sharedLabels: ({ sharedLabels }) => (
    <Card title="Shared labels" about="Labels with more than one of your artists.">
      <Rows>
        {sharedLabels.map((row) => (
          <Row key={row.label.id} focus={row.focus} ties={hubTies(row.label.id)} meta={plural(row.albums, 'album')}>
            <Names nodes={row.artists} total={row.total} /> {row.total === 2 ? 'are both on' : 'are all on'} <Name node={row.label} />
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  mostConnected: ({ mostConnected }) => (
    <Card title="Most connected" about="The artists who share someone with the most of the others.">
      <Rows>
        {mostConnected.map((row) => (
          <Row key={row.artist.id} focus={row.focus} meta={`linked to ${plural(row.artists, 'of your artists', 'of your artists')}`}>
            <Name node={row.artist} />
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  islands: ({ islands }) => (
    <Card title="Islands" about="Nothing ties these to the rest of your library: no member, producer, guest or track in common.">
      <Rows>
        <Row focus={islands!.artists.map((a) => a.id)} meta={islands!.total > 1 ? `${islands!.total} artists` : undefined}>
          <Names nodes={islands!.artists} total={islands!.total} max={8} />
        </Row>
      </Rows>
    </Card>
  ),

  soundsAlike: ({ soundsAlike }) => (
    <Card title="Sounds alike" about="Artists with a lot in common and nobody between them.">
      <Rows>
        {soundsAlike.map((row) => (
          <Row
            key={`${row.artists[0].id}:${row.artists[1].id}`}
            focus={row.focus}
            meta={row.shared.length > 0 ? `both ${row.shared.join(', ')}` : undefined}
          >
            <Name node={row.artists[0]} /> and <Name node={row.artists[1]} />
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  mostPlayed: ({ mostPlayed }) => (
    <Card title="Most played">
      {(
        [
          ['artists', mostPlayed.artists],
          ['albums', mostPlayed.albums],
          ['tracks', mostPlayed.tracks],
        ] as const
      )
        .filter(([, rows]) => rows.length > 0)
        .map(([label, rows], i) => (
          <div key={label} className={i > 0 ? 'mt-[14px]' : ''}>
            <SectionLabel className="mb-[6px]">{label}</SectionLabel>
            <Rows>
              {rows.map((row) => (
                <Row key={row.node.id} focus={row.focus} by={row.by} cover={label === 'albums' ? row.node.id : undefined}>
                  <span className="flex items-baseline justify-between gap-[8px]">
                    <span className="min-w-0">
                      <Name node={row.node} />
                    </span>
                    <Count>{plural(row.plays, 'play')}</Count>
                  </span>
                </Row>
              ))}
            </Rows>
          </div>
        ))}
    </Card>
  ),

  onRepeat: ({ onRepeat }) => (
    <Card title="On repeat" about="Played three times or more in the last 30 days.">
      <Rows>
        {onRepeat.map((row) => (
          <Row key={row.node.id} focus={row.focus} by={row.by} meta={`${plural(row.plays, 'play')} in the last 30 days`}>
            <Name node={row.node} />
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  rediscover: ({ rediscover }) => (
    <Card title="Rediscover" about="Artists you played a lot, and not for over three months.">
      <Rows>
        {rediscover.map((row) => (
          <Row key={row.artist.id} focus={row.focus} meta={`${plural(row.plays, 'play')}, the last in ${monthYear(row.lastPlayed)}`}>
            <Name node={row.artist} />
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  waiting: ({ waiting }) => (
    <Card title="Waiting for you" about={`${plural(waiting.total, 'album')} you've never played. The newest:`}>
      <Rows>
        {waiting.albums.map((row) => (
          <Row key={row.album.id} focus={row.focus} cover={row.album.id} by={row.by} meta={row.year != null ? String(row.year) : undefined}>
            <Name node={row.album} />
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  careers: ({ careers }) => (
    <Card title="Longest careers" about="The artists whose albums span the most years.">
      <Rows>
        {careers.map((row) => (
          <Row key={row.artist.id} focus={row.focus} meta={`${row.first}–${row.last} · ${plural(row.albums, 'album')}`}>
            <span className="flex items-baseline justify-between gap-[8px]">
              <span className="min-w-0">
                <Name node={row.artist} />
              </span>
              <Count>{plural(row.last - row.first, 'year')}</Count>
            </span>
          </Row>
        ))}
      </Rows>
    </Card>
  ),

  shape: ({ shape }) => <Shape shape={shape} />,
}

/* Library shape: albums by decade as bars, the peak in the accent, then the
 * labels with the most of them. */
function Shape({ shape }: { shape: ReadyInsights['shape'] }) {
  const peak = peakDecade(shape.decades)
  const most = Math.max(1, ...shape.decades.map((d) => d.albums))
  return (
    <Card
      title="Library shape"
      about={peak ? `Most of your albums are from the ${peak.decade}s: ${Math.round(peak.share * 100)}% of those with a year.` : undefined}
    >
      {shape.decades.length > 1 && (
        <ul aria-label="Albums by decade" className="flex flex-col gap-[4px]">
          {shape.decades.map((d) => (
            <li key={d.decade} className="flex items-center gap-[8px]">
              <span className="mono w-[44px] shrink-0 text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{d.decade}s</span>
              <span className="h-[8px] min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-sunken)]">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${(d.albums / most) * 100}%`,
                    background: peak?.decade === d.decade ? 'var(--color-accent)' : 'var(--color-ink-3)',
                  }}
                />
              </span>
              <span className="mono w-[48px] shrink-0 text-right text-[length:var(--text-mono)] text-[var(--color-ink)]">
                {formatCount(d.albums)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {shape.undated > 0 && <p className="mt-[6px] text-small text-[var(--color-ink-2)]">{plural(shape.undated, 'album')} with no year.</p>}
      {shape.labels.length > 1 && (
        <div className="mt-[14px]">
          <SectionLabel className="mb-[6px]">labels</SectionLabel>
          <Rows>
            {shape.labels.map((l) => (
              <Row key={l.label.id} focus={[]}>
                <span className="flex items-baseline justify-between gap-[8px]">
                  <span className="min-w-0">
                    <Name node={l.label} />
                  </span>
                  <Count>{plural(l.albums, 'album')}</Count>
                </span>
              </Row>
            ))}
          </Rows>
        </div>
      )}
    </Card>
  )
}
