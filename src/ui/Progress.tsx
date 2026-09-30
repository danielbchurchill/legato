/* Progress — hand ports of gpui-kit's Progress and ProgressCircle
 * (crates/component/src/progress/). See DESIGN.md Motion, "A bounded
 * exception: progress".
 *
 * Determinate is the default and the one to reach for: a scan knows its
 * file count, the enrichment queue knows its remaining jobs, and DESIGN.md
 * says render the real value. The bar is gpui-kit's — a track of
 * --color-ink at 20% with the done share in full --color-ink, 8px tall at
 * medium (4/6/8/10 across xs-lg), pill ends. The fill's width eases on
 * --motion-base, the one place a value is allowed to: it moves in coarse
 * steps as work lands, and stepping a bar that jumps 5% at a time reads as
 * stutter rather than as truth. Anything genuinely live (playback position)
 * still steps.
 *
 * Indeterminate (value omitted) is gpui-kit's sweep: a 40% segment crossing
 * the track every --motion-progress. Reduced motion parks it at its start. */

export type ProgressSize = 'xs' | 'sm' | 'md' | 'lg'

const BAR_HEIGHT: Record<ProgressSize, string> = { xs: 'h-[4px]', sm: 'h-[6px]', md: 'h-[8px]', lg: 'h-[10px]' }

type ProgressProps = {
  /** 0-100. Omit for indeterminate. */
  value?: number
  label: string
  size?: ProgressSize
  className?: string
}

export function Progress({ value, label, size = 'md', className = '' }: ProgressProps) {
  const determinate = value != null
  const pct = determinate ? Math.min(100, Math.max(0, value)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      className={`relative w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-ink)_20%,transparent)] ${BAR_HEIGHT[size]} ${className}`}
    >
      {determinate ? (
        <div
          className="h-full rounded-full bg-[var(--color-ink)] transition-[width] duration-[var(--motion-base)] ease-[var(--ease-out)]"
          style={{ width: `${pct}%` }}
        />
      ) : (
        <div className="h-full w-[40%] rounded-full bg-[var(--color-ink)] animate-[progress-sweep_var(--motion-progress)_var(--ease-inout)_infinite]" />
      )}
    </div>
  )
}

const CIRCLE_SIZE: Record<ProgressSize, number> = { xs: 8, sm: 12, md: 16, lg: 20 }

/* The ring form, for a slot too small for a bar — beside a row, in a
 * button. Stroke is 15% of the diameter capped at 5px, gpui-kit's
 * progress_circle.rs. */
export function ProgressCircle({ value, label, size = 'md', className = '' }: ProgressProps) {
  const diameter = CIRCLE_SIZE[size]
  const stroke = Math.min(5, diameter * 0.15)
  const radius = (diameter - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const determinate = value != null
  const pct = determinate ? Math.min(100, Math.max(0, value)) : 25
  return (
    <svg
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      width={diameter}
      height={diameter}
      viewBox={`0 0 ${diameter} ${diameter}`}
      className={`shrink-0 -rotate-90 ${determinate ? '' : 'animate-[spinner-spin_var(--motion-progress)_linear_infinite]'} ${className}`}
    >
      <circle
        cx={diameter / 2}
        cy={diameter / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-[color-mix(in_srgb,var(--color-ink)_20%,transparent)]"
      />
      <circle
        cx={diameter / 2}
        cy={diameter / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct / 100)}
        className="stroke-[var(--color-ink)] transition-[stroke-dashoffset] duration-[var(--motion-base)] ease-[var(--ease-out)]"
      />
    </svg>
  )
}
