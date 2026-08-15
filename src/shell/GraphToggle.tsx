import { Surface } from './Surface'
import { GRANULARITIES, type Granularity } from './granularity'

/* The graph's granularity switch. Session 4 makes it rebuild the graph at each
 * level (three distinct node sets, edges and layouts); for now it owns the
 * state and looks right.
 *
 * Active and inactive differ by color alone — no pill, no underline, no weight
 * change. Rubik at 16px in both cases, muted -> ink. */

type GraphToggleProps = {
  value: Granularity
  onChange: (value: Granularity) => void
}

export function GraphToggle({ value, onChange }: GraphToggleProps) {
  return (
    <Surface
      className="absolute top-[69px] left-1/2 h-[41px] w-[206px] -translate-x-1/2 overflow-hidden"
      style={{ zIndex: 10 }}
    >
      <div role="tablist" className="flex h-full items-center justify-center gap-[10px] px-[14px]">
        {GRANULARITIES.map((granularity) => {
          const active = granularity === value
          return (
            <button
              key={granularity}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(granularity)}
              className={`text-[length:var(--text-base)] leading-none transition-colors duration-150 ${
                active
                  ? 'text-[var(--color-ink)]'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'
              }`}
            >
              {granularity}
            </button>
          )
        })}
      </div>
    </Surface>
  )
}
