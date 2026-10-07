import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Progress } from '../ui/Progress'
import { Spinner } from '../ui/Spinner'
import { formatCount } from '../ui/format'
import type { ScanProgress, ScanStage } from '../hooks/useScanStatus'
import { useShellLayout } from '../shell/layout'

/* The map's states other than "here's your map": the first scan building
 * it, and the notices for a scan that failed, a map with nothing on it, and
 * a layout that pushed everything off screen. Each is one glass card in the
 * middle of the free space, saying what's true and what to do. */

/* The scanner's six stages, told as the three a person would recognise. */
const STEPS: { label: string; stages: ScanStage[] }[] = [
  { label: 'Reading tags', stages: ['discover', 'read_tags'] },
  { label: 'Matching tracks', stages: ['match', 'collapse'] },
  { label: 'Laying out the map', stages: ['layout', 'enrich_queued'] },
]

/* First scan: the clusters matched so far are already drawn behind this;
 * the card says how far along the rest is. The percentage is files read,
 * the one count that exists from the first second — later stages have no
 * total until they start. */
export function FirstScanCard({ progress }: { progress: ScanProgress | null }) {
  const layout = useShellLayout()
  const total = progress?.filesTotal ?? 0
  const done = progress?.filesScanned ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : undefined
  const currentStep = progress ? STEPS.findIndex((step) => step.stages.includes(progress.stage)) : 0

  return (
    <div
      role="status"
      aria-live="polite"
      className="glass absolute z-10 flex w-[380px] -translate-x-1/2 -translate-y-1/2 flex-col gap-[12px] rounded-[var(--radius-rail)] p-[20px]"
      style={{ left: layout.cx, top: '46%' }}
    >
      <div className="flex items-center gap-[10px] text-[var(--color-accent)]">
        <Spinner size={18} />
        <span className="text-heading text-[var(--color-ink)]">Building your map</span>
      </div>
      <Progress value={pct} size="sm" label="Files read" />
      <div className="mono flex justify-between text-[length:var(--text-mono)] text-[var(--color-ink-2)]">
        <span>{total > 0 ? `${formatCount(done)} of ${formatCount(total)} files` : 'Finding files…'}</span>
        {pct != null && <span>{pct}%</span>}
      </div>
      <ol className="flex flex-col gap-[6px] text-[length:var(--text-secondary)] leading-[18px]">
        {STEPS.map((step, i) => {
          const state = i < currentStep ? 'done' : i === currentStep ? 'current' : 'next'
          return (
            <li
              key={step.label}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`flex items-center gap-[8px] ${
                state === 'current'
                  ? 'text-[var(--color-ink)]'
                  : state === 'done'
                    ? 'text-[var(--color-ink-2)]'
                    : 'text-[var(--color-ink-3)]'
              }`}
            >
              {state === 'done' ? (
                <Icon name="checkmark" size={14} className="text-[var(--color-ok)]" />
              ) : (
                <span
                  aria-hidden="true"
                  className={`mx-[3px] size-[8px] shrink-0 rounded-full ${state === 'current' ? 'bg-[image:var(--accent-fill)]' : 'bg-[var(--color-wash-2)]'}`}
                />
              )}
              {step.label}
            </li>
          )
        })}
      </ol>
      <span className="text-small text-[var(--color-ink-3)]">You can play music while this runs. Nodes appear as they're matched.</span>
    </div>
  )
}

type NoticeAction = { label: string; onClick: () => void; primary?: boolean }

export function MapNotice({ title, body, actions = [] }: { title: string; body: string; actions?: NoticeAction[] }) {
  const layout = useShellLayout()
  return (
    <div
      role="status"
      className="glass absolute z-10 flex w-[380px] -translate-x-1/2 -translate-y-1/2 flex-col gap-[8px] rounded-[var(--radius-rail)] p-[20px]"
      style={{ left: layout.cx, top: '46%' }}
    >
      <span className="text-heading text-[var(--color-ink)]">{title}</span>
      <p className="text-[length:var(--text-secondary)] leading-[18px] [overflow-wrap:anywhere] text-[var(--color-ink-2)]">{body}</p>
      {actions.length > 0 && (
        <div className="mt-[6px] flex gap-[8px]">
          {actions.map((action) => (
            <Button key={action.label} variant={action.primary ? 'primary' : 'secondary'} onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
