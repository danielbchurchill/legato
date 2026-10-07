/* The playing-row marker: three 3px accent bars at rest heights of 60/100/40%,
 * 14×12 overall. They move only while audio is actually playing — a paused
 * track keeps the bars still, so the marker says "this one" without claiming
 * sound. Reduced motion freezes them through index.css's global animation
 * rule, landing on the rest heights. */

const BARS = [
  { rest: 0.6, delay: '0ms' },
  { rest: 1, delay: '-280ms' },
  { rest: 0.4, delay: '-520ms' },
]

export function Equaliser({ playing, className = '' }: { playing: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-flex h-[12px] w-[14px] items-end justify-between ${className}`}>
      {BARS.map((bar, i) => (
        <span
          key={i}
          className={`w-[3px] origin-bottom rounded-[1px] bg-[var(--color-accent)] ${
            playing ? 'animate-[equaliser-bar_900ms_var(--ease-inout)_infinite_alternate]' : ''
          }`}
          style={{ height: `${bar.rest * 100}%`, animationDelay: bar.delay }}
        />
      ))}
    </span>
  )
}
