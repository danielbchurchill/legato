import { useState } from 'react'
import { Button } from '../ui/Button'
import { Disclosure } from '../ui/Disclosure'
import { Icon } from '../ui/Icon'
import { SectionLabel } from '../ui/SectionLabel'
import { Shimmer } from '../ui/Skeleton'
import { StatusDot, type Status } from '../ui/StatusDot'
import { formatCount } from '../ui/format'
import { PanelHeader } from '../shell/SidePanel'
import type { LeftView, WorklistKind } from '../shell/panels'
import { useScanStatus } from '../hooks/useScanStatus'
import { API_BASE as API } from '../config/serverHost'
import { formatBytes } from './format'
import { PipelineSection, SchemaSection, StorageSection } from './DatabaseInspector'
import {
  GAP_FIELDS,
  formatLibraryLength,
  formatWhen,
  useDbSnapshot,
  useGapCounts,
  useStats,
  useTagWrites,
  useWorklist,
  type GapField,
} from './healthData'
import { Worklist } from './Worklists'

/* Library health: one place for "is my library in order?", where there
 * used to be three — the database inspector, the tag manager and the
 * maintenance modal. The status of the last scan, the library's size, what
 * needs a look (each opening its own worklist), the metadata gaps, how
 * tracks were matched, and the raw internals folded away at the foot. */

/* How each file was matched (files.match_source), strongest first, and the
 * tone each gets in the bar: confident matches in ink, weaker ones fading. */
const SOURCES: Record<string, { label: string; color: string; rank: number }> = {
  mbid: { label: 'MusicBrainz', color: 'var(--color-ink)', rank: 0 },
  acoustid: { label: 'AcoustID', color: 'var(--color-ink-2)', rank: 1 },
  manual: { label: 'set by you', color: 'var(--color-accent)', rank: 2 },
  fuzzy_pending: { label: 'to confirm', color: 'var(--color-warn)', rank: 3 },
  unmatched: { label: 'tags only', color: 'var(--color-line-strong)', rank: 4 },
}
const sourceOf = (key: string) => SOURCES[key] ?? { label: key, color: 'var(--color-ink-3)', rank: 9 }

type HealthPanelProps = {
  view: LeftView
  onNavigate: (view: LeftView | null) => void
  onFocusNode: (id: number) => void
}

export function HealthPanel({ view, onNavigate, onFocusNode }: HealthPanelProps) {
  // The gap worklist opens on whichever field was clicked.
  const [gapField, setGapField] = useState<GapField>('bpm')
  if (view.kind === 'worklist') {
    return (
      <Worklist
        kind={view.list}
        gapField={gapField}
        onGapFieldChange={setGapField}
        onBack={() => onNavigate({ kind: 'health' })}
        onFocusNode={onFocusNode}
      />
    )
  }
  return (
    <HealthHome
      onOpen={(list, field) => {
        if (field) setGapField(field)
        onNavigate({ kind: 'worklist', list })
      }}
    />
  )
}

function HealthHome({ onOpen }: { onOpen: (list: WorklistKind, field?: GapField) => void }) {
  const stats = useStats()
  const snapshot = useDbSnapshot()
  const { data: worklist } = useWorklist()
  const { data: tagWrites } = useTagWrites()
  const gaps = useGapCounts()
  const scan = useScanStatus()

  const count = (type: string) => (worklist ?? []).filter((item) => item.type === type).length
  const attention: { list: WorklistKind; label: string; status: Status; count: number }[] = [
    { list: 'duplicates', label: 'Possible duplicates', status: 'warn', count: count('fuzzy_pending') },
    { list: 'missing', label: 'Missing files', status: 'bad', count: count('missing_file') + count('wont_decode') },
    { list: 'enrichment', label: 'Enrichment to confirm', status: 'warn', count: count('enrichment_flag') },
    {
      list: 'tag-writes',
      label: 'Tag writes to review',
      status: 'accent',
      count: (tagWrites ?? []).filter((t) => t.status === 'pending_review').length,
    },
  ]
  const needing = attention.filter((row) => row.count > 0)
  const total = needing.reduce((n, row) => n + row.count, 0)
  const loaded = worklist != null && tagWrites != null

  const latest = snapshot?.pipeline.latestScan ?? null
  const finished = formatWhen(latest?.finishedAt)
  const scanLine = scan.scanning
    ? 'Reading your folders now'
    : latest
      ? [
          finished ? `Scan finished ${finished}` : 'Last scan',
          `${formatCount(latest.filesAdded)} added, ${formatCount(latest.filesUpdated)} updated`,
        ].join(' · ')
      : 'Not scanned yet'

  const rescan = () => {
    void fetch(`${API}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  }

  return (
    <div className="flex flex-col">
      <PanelHeader title="Library health" />

      <div className="mt-[14px] flex items-center gap-[12px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[14px]">
        <StatusDot status={scan.error ? 'bad' : scan.scanning ? 'accent' : 'ok'} size={10} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-heading text-[var(--color-ink)]">
            {scan.error ? 'The last scan failed' : scan.scanning ? <Shimmer>Scanning…</Shimmer> : 'Up to date'}
          </span>
          <span className="text-small [overflow-wrap:anywhere] text-[var(--color-ink-2)]">{scan.error ?? scanLine}</span>
        </div>
        <Button variant="secondary" onClick={rescan} disabled={scan.scanning}>
          scan
        </Button>
      </div>

      {stats && (
        <dl className="mt-[14px] grid grid-cols-2 gap-[10px]">
          <Stat value={formatCount(stats.albums)} label="albums" />
          <Stat value={formatCount(stats.tracks)} label="tracks" />
          <Stat value={formatBytes(stats.totalBytes)} label="on disk" />
          <Stat value={formatLibraryLength(stats.totalDurationMs)} label="length" />
        </dl>
      )}

      {loaded && needing.length === 0 ? (
        <div className="mt-[20px] flex flex-col items-center gap-[8px] rounded-[var(--radius-card)] px-[12px] py-[20px] text-center">
          <Icon name="checkmark" size={24} className="text-[var(--color-ok)]" />
          <span className="text-heading text-[var(--color-ink)]">Nothing needs attention</span>
          <span className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
            Duplicates, missing files and tag writes show up here when there are any.
          </span>
        </div>
      ) : (
        <section className="mt-[20px]">
          <SectionLabel count={loaded ? total : undefined} className="h-[24px]">
            needs attention
          </SectionLabel>
          <ul className="-mx-[8px] mt-[4px]">
            {needing.map((row) => (
              <HealthRow key={row.list} status={row.status} label={row.label} count={row.count} onClick={() => onOpen(row.list)} />
            ))}
          </ul>
        </section>
      )}

      {gaps && (
        <section className="mt-[20px]">
          <SectionLabel className="h-[24px]">metadata gaps</SectionLabel>
          <ul className="-mx-[8px] mt-[4px]">
            {GAP_FIELDS.filter((g) => g.field === 'bpm' || g.field === 'unmatched' || g.field === 'release_date').map((gap) => (
              <HealthRow key={gap.field} label={gap.row} count={gaps[gap.field]} onClick={() => onOpen('gaps', gap.field)} />
            ))}
          </ul>
        </section>
      )}

      {snapshot && snapshot.matchQuality.length > 0 && (
        <section className="mt-[20px]">
          <SectionLabel className="h-[24px]">match quality</SectionLabel>
          {(() => {
            const sources = [...snapshot.matchQuality].sort((a, b) => sourceOf(a.source).rank - sourceOf(b.source).rank)
            return (
              <>
                <div
                  role="img"
                  aria-label={sources.map((m) => `${sourceOf(m.source).label} ${Math.round(m.share * 100)}%`).join(', ')}
                  className="mt-[8px] flex h-[8px] gap-[2px] overflow-hidden rounded-full"
                >
                  {sources.map((m) => (
                    <span key={m.source} style={{ width: `${m.share * 100}%`, background: sourceOf(m.source).color }} />
                  ))}
                </div>
                <div className="mt-[8px] flex flex-wrap gap-x-[14px] gap-y-[4px] text-small text-[var(--color-ink-2)]">
                  {sources.map((m) => (
                    <span key={m.source} className="flex items-center gap-[6px]">
                      <span className="size-[8px] rounded-full" style={{ background: sourceOf(m.source).color }} />
                      {sourceOf(m.source).label} <span className="mono">{Math.round(m.share * 100)}%</span>
                    </span>
                  ))}
                </div>
              </>
            )
          })()}
        </section>
      )}

      {snapshot && (
        <div className="mt-[22px]">
          <Disclosure title="under the hood" description="pipeline, schema, storage">
            <div className="flex flex-col gap-[20px]">
              <PipelineSection pipeline={snapshot.pipeline} />
              <SchemaSection schema={snapshot.schema} />
              <StorageSection storage={snapshot.storage} />
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-[var(--radius-card)] bg-[var(--color-wash)] px-[12px] py-[10px]">
      <dd className="truncate text-[18px] leading-[24px] font-medium tabular-nums text-[var(--color-ink)]" title={value}>
        {value}
      </dd>
      <dt className="order-last text-small text-[var(--color-ink-2)]">{label}</dt>
    </div>
  )
}

/* A row that opens a worklist: its status, what it is, how many, and a
 * chevron saying it goes somewhere. */
function HealthRow({ status, label, count, onClick }: { status?: Status; label: string; count: number; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex h-[40px] w-full items-center gap-[10px] rounded-[var(--radius-control)] px-[8px] text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)]"
      >
        {status && <StatusDot status={status} />}
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] leading-[20px] text-[var(--color-ink)]">{label}</span>
        <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink)]">{formatCount(count)}</span>
        <span className="inline-flex -rotate-90 text-[var(--color-ink-3)]">
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
    </li>
  )
}
