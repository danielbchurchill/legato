import { useRef, type KeyboardEvent } from 'react'

/* A hand port of gpui-kit's Radio and RadioGroup (crates/component/src/
 * radio.rs, radio_group.rs), drawn in Legato's palette. See DESIGN.md
 * "Controls".
 *
 * A 16px ring, --color-control at rest; selected turns the ring --color-ink
 * and fills a centred 8px dot of the same, scaled up from nothing on
 * --ease-spring-control (a transform, so reduced motion makes it a jump).
 *
 * RadioGroup owns the keyboard the way WAI-ARIA's radio group pattern and
 * gpui-kit's both do: the group is one tab stop (the selected option, or
 * the first if none is), and arrow keys move the selection itself — not
 * just focus — to the next or previous option, wrapping at the ends and
 * skipping disabled ones. */

export type RadioOption<T extends string> = { value: T; label: string; disabled?: boolean }

type RadioGroupProps<T extends string> = {
  options: readonly RadioOption<T>[]
  value: T | null
  onChange: (value: T) => void
  /** Accessible name for the group as a whole. */
  label: string
  orientation?: 'horizontal' | 'vertical'
  disabled?: boolean
  className?: string
}

function RadioMark({ selected, disabled }: { selected: boolean; disabled: boolean }) {
  return (
    <span
      className={`focus-ring-part flex size-[16px] shrink-0 items-center justify-center rounded-full border transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] ${
        selected ? 'border-[var(--color-ink)]' : 'border-[var(--color-control)]'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className="size-[8px] rounded-full bg-[var(--color-ink)] transition-transform duration-[var(--motion-spring-control)] ease-[var(--ease-spring-control)]"
        style={{ transform: `scale(${selected ? 1 : 0})` }}
      />
    </span>
  )
}

export function RadioGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  orientation = 'vertical',
  disabled = false,
  className = '',
}: RadioGroupProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.map((o) => !disabled && !o.disabled)
  const selectedIndex = options.findIndex((o) => o.value === value)
  const tabStop = selectedIndex >= 0 && enabled[selectedIndex] ? selectedIndex : enabled.indexOf(true)

  const move = (from: number, direction: 1 | -1) => {
    for (let step = 1; step <= options.length; step++) {
      const next = (from + direction * step + options.length) % options.length
      if (enabled[next]) {
        onChange(options[next].value)
        refs.current[next]?.focus()
        return
      }
    }
  }

  const handleKeyDown = (index: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      move(index, 1)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      move(index, -1)
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-orientation={orientation}
      className={`flex ${orientation === 'vertical' ? 'flex-col gap-[var(--spacing-sm)]' : 'flex-wrap gap-x-[var(--spacing-lg)] gap-y-[var(--spacing-sm)]'} ${className}`}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!enabled[index]}
            tabIndex={index === tabStop ? 0 : -1}
            data-focus-ring="part"
            onClick={() => onChange(option.value)}
            onKeyDown={handleKeyDown(index)}
            className="inline-flex items-center gap-[8px] disabled:cursor-not-allowed"
          >
            <RadioMark selected={selected} disabled={!enabled[index]} />
            <span
              className={`text-left text-[length:var(--text-sm)] ${
                enabled[index] ? 'text-[color:var(--color-control)]' : 'text-[color:var(--color-muted)]'
              }`}
            >
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
