import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import type { SortDir } from './types'

/* The library's sort control: a 34px outlined pill naming the current order
 * ("artist A–Z"), opening a short list of the others. Choosing the active
 * one again flips its direction, the same gesture as clicking a sorted
 * column header in the tracks table. */

type SortOption<T extends string> = { id: T; label: string }

/* Words for each direction, by what the field is: names run A–Z, numbers
 * low to high, dates oldest or newest first. */
export type SortKind = 'text' | 'number' | 'date'

function directionLabel(kind: SortKind, dir: SortDir): string {
  if (kind === 'text') return dir === 'asc' ? 'A–Z' : 'Z–A'
  if (kind === 'date') return dir === 'asc' ? 'oldest first' : 'newest first'
  return dir === 'asc' ? 'low to high' : 'high to low'
}

type SortPillProps<T extends string> = {
  options: readonly SortOption<T>[]
  value: T
  dir: SortDir
  kindOf: (id: T) => SortKind
  onChange: (value: T, dir: SortDir) => void
}

export function SortPill<T extends string>({ options, value, dir, kindOf, onChange }: SortPillProps<T>) {
  const current = options.find((o) => o.id === value)
  return (
    <Popover
      label="Sort by"
      placement="bottom"
      align="end"
      className="w-[220px] p-[6px]"
      trigger={({ open, ...props }) => (
        <button
          type="button"
          {...props}
          className={`inline-flex h-[34px] items-center gap-[6px] rounded-full border border-[var(--color-line-strong)] px-[12px] text-[length:var(--text-secondary)] font-medium text-[var(--color-ink-2)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)] hover:text-[var(--color-ink)] ${
            open ? 'bg-[var(--color-wash)] text-[var(--color-ink)]' : ''
          }`}
        >
          {current?.label} {directionLabel(kindOf(value), dir)}
          <Icon name="chevron-down" size={14} />
        </button>
      )}
    >
      {(close) => (
        <ul role="listbox" aria-label="Sort by" className="flex flex-col">
          {options.map((option) => {
            const active = option.id === value
            return (
              <li key={option.id} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(
                      option.id,
                      active
                        ? dir === 'asc'
                          ? 'desc'
                          : 'asc'
                        : option.id === 'dateAdded' || option.id === 'recentlyPlayed'
                          ? 'desc'
                          : 'asc',
                    )
                    close()
                  }}
                  className={`flex h-[32px] w-full items-center justify-between gap-[8px] rounded-[8px] px-[10px] text-left text-[length:var(--text-secondary)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)] ${
                    active ? 'font-medium text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
                  }`}
                >
                  {option.label}
                  {active && <span className="text-small text-[var(--color-ink-3)]">{directionLabel(kindOf(option.id), dir)}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Popover>
  )
}
