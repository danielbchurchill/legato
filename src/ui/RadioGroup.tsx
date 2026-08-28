/* v2's radio-dot selector — settings/music-map/default-view, a preference
 * separate from the artists/releases/tracks toggle pill (which is the
 * *active* view, not the *default* one). See DESIGN.md "Controls" -> "v2:
 * settings primitives".
 *
 * Options are laid out with justify-between, not a fixed gap: the mockup's
 * own spacing between options varies with each label's width rather than
 * holding a constant pitch, which is what evenly distributing across the
 * row's own width reproduces. */

type RadioGroupProps<T extends string> = {
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  /** Display text per option — falls back to the raw option value when an
   * option has no entry, so a caller with no separate display text can
   * still pass options straight through. */
  labels?: Partial<Record<T, string>>
  className?: string
}

export function RadioGroup<T extends string>({
  options,
  value,
  onChange,
  labels,
  className = '',
}: RadioGroupProps<T>) {
  return (
    <div role="radiogroup" className={`flex items-start justify-between ${className}`}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          onClick={() => onChange(option)}
          className="flex flex-col items-center gap-[var(--spacing-xs)]"
        >
          <span
            className={`size-[10px] rounded-full border border-[var(--color-control)] ${
              option === value ? 'bg-[var(--color-control)]' : 'bg-transparent'
            }`}
          />
          <span className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
            {labels?.[option] ?? option}
          </span>
        </button>
      ))}
    </div>
  )
}
