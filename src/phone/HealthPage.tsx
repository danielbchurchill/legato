import { API_BASE as API } from '../config/serverHost'
import { useScanStatus } from '../hooks/useScanStatus'
import { formatWhen, useDbSnapshot, type GapField } from '../panels/healthData'
import type { WorklistKind } from '../shell/panels'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Progress } from '../ui/Progress'
import { SectionLabel } from '../ui/SectionLabel'
import { Shimmer, Skeleton } from '../ui/Skeleton'
import { StatusDot } from '../ui/StatusDot'
import { formatCount, plural } from '../ui/format'
import { matchSummary, useAttention, type AttentionRow } from './libraryHealth'
import { PageNote } from './PageGroup'

/* Library health on the phone (#389, Legato Mobile v2's screen 8): how much
 * of the library is matched, what needs attention, each opening its list,
 * and the two things to do about it. The data is the desktop panel's
 * (panels/healthData.ts). The desktop's stats, match-quality breakdown and
 * "under the hood" internals stay on the desktop: the handoff leaves them
 * out, and the summary's figure is the one that answers "is my library in
 * order?". */

type HealthPageProps = {
  /** Opens a worklist, the gaps list on `field`. */
  onOpen: (list: WorklistKind, field?: GapField) => void
}

export function HealthPage({ onOpen }: HealthPageProps) {
  const { rows, fixes } = useAttention()
  const snapshot = useDbSnapshot()
  const scan = useScanStatus()
  const summary = snapshot ? matchSummary(snapshot.matchQuality) : null
  const latest = snapshot?.pipeline.latestScan ?? null
  const finished = formatWhen(latest?.finishedAt)
  const scanned = scan.scanning
    ? 'scanning now'
    : scan.error
      ? 'last scan failed'
      : finished
        ? `scanned ${finished}`
        : latest
          ? 'scanned'
          : 'not scanned yet'

  const rescan = () => {
    void fetch(`${API}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  }

  return (
    <div className="flex flex-col">
      <div className="mt-[8px] flex flex-col gap-[12px] rounded-[18px] border border-[var(--color-line)] bg-[var(--color-solid)] p-[18px]">
        <div className="flex items-baseline justify-between gap-[12px]">
          <span className="text-[40px] leading-[44px] font-medium tabular-nums text-[var(--color-ink)]">
            {summary ? `${summary.percent}%` : <Skeleton className="inline-block h-[32px] w-[96px] rounded-[8px]" />}
          </span>
          <span className="text-[13px] text-[var(--color-ink-2)]">matched</span>
        </div>
        <Progress size="sm" label="Files matched" value={summary?.percent ?? 0} />
        <div className="mono flex justify-between gap-[12px] text-[12px] leading-[16px] text-[var(--color-ink-2)]">
          <span>{summary && `${formatCount(summary.matched)} of ${plural(summary.files, 'file')}`}</span>
          <span className="truncate">{scanned}</span>
        </div>
        {scan.error && <p className="text-[13px] leading-[18px] [overflow-wrap:anywhere] text-[var(--color-ink-2)]">{scan.error}</p>}
      </div>

      <SectionLabel className="px-[4px] pt-[22px] pb-[8px]">needs attention</SectionLabel>
      <ul className="flex flex-col divide-y divide-[var(--color-line)] rounded-[16px] border border-[var(--color-line)] bg-[var(--color-solid)] px-[16px]">
        {rows == null ? (
          <li aria-label="Loading" className="flex min-h-[64px] flex-col justify-center gap-[8px]">
            <Skeleton className="h-[12px] w-[160px] rounded-full" />
            <Skeleton className="h-[10px] w-[220px] rounded-full" />
          </li>
        ) : rows.length === 0 ? (
          <li className="flex min-h-[64px] items-center gap-[12px] py-[10px]">
            <StatusDot status="ok" size={10} />
            <span className="flex min-w-0 flex-col">
              <span className="text-[16px] leading-[21px] text-[var(--color-ink)]">Nothing needs attention</span>
              <span className="text-[13px] leading-[18px] text-[var(--color-ink-2)]">
                Unmatched tracks, duplicates, missing files and tag writes show up here.
              </span>
            </span>
          </li>
        ) : (
          rows.map((row) => <Attention key={row.list} row={row} onOpen={() => onOpen(row.list, row.field)} />)
        )}
      </ul>

      <PageNote>Fixes are proposed, never applied. You review every change before anything is written to your files.</PageNote>

      <div className="mt-[20px] flex gap-[8px]">
        {fixes != null && fixes > 0 && (
          <Button variant="primary" size="xl" className="flex-1" onClick={() => onOpen('tag-writes')}>
            Review {plural(fixes, 'fix', 'fixes')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="xl"
          className={fixes != null && fixes > 0 ? '' : 'flex-1'}
          onClick={rescan}
          disabled={scan.scanning}
        >
          {scan.scanning ? <Shimmer>Scanning…</Shimmer> : 'Rescan'}
        </Button>
      </div>
    </div>
  )
}

/* A 64px row: its status, what it is and what that means, how many, and a
 * chevron saying it opens a list. */
function Attention({ row, onOpen }: { row: AttentionRow; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-[64px] w-full items-center gap-[12px] py-[10px] text-left">
        <StatusDot status={row.status} size={10} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[16px] leading-[21px] text-[var(--color-ink)]">{row.title}</span>
          <span className="truncate text-[13px] leading-[18px] text-[var(--color-ink-2)]">{row.explanation}</span>
        </span>
        <span className="mono shrink-0 text-[13px] text-[var(--color-ink-2)]">{formatCount(row.count)}</span>
        <span className="inline-flex shrink-0 -rotate-90 text-[var(--color-ink-3)]">
          <Icon name="chevron-down" size={18} />
        </span>
      </button>
    </li>
  )
}
