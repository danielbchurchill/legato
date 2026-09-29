import type { ReactNode } from 'react'

/* A hand port of gpui-kit's ToggleGroup (crates/component/src/
 * toggle_group.rs): a row of pressable pills, each aria-pressed, choosing
 * one (`single`) or any number (`multiple`) of a set. Unlike Tabs, pressing
 * one doesn't switch a view — it sets an option — so it's buttons, not a
 * tablist, and a single group can be left with nothing pressed (the Music
 * Map's "custom" preset state is exactly that).
 *
 * gpui-kit's outline variant in Legato's palette: every pill carries the
 * hairline edge Button's `destructive` shape already uses; pressed fills
 * with --color-hover-wash and lifts its text to --color-ink. That replaces
 * the ColorSwatch-style ring the preset pills used to borrow for "this one
 * is selected" — a ring offset outside a bordered pill read as two borders. */

type ToggleOption<T extends string> = { value: T; label: ReactNode; accessibilityLabel?: string }

type BaseProps<T extends string> = {
  options: readonly ToggleOption<T>[]
  label: string
  disabled?: boolean
  className?: string
}

type SingleProps<T extends string> = BaseProps<T> & {
  type: 'single'
  value: T | null
  onChange: (value: T) => void
}

type MultipleProps<T extends string> = BaseProps<T> & {
  type: 'multiple'
  value: readonly T[]
  onChange: (value: T[]) => void
}

export function ToggleGroup<T extends string>(props: SingleProps<T> | MultipleProps<T>) {
  const { options, label, disabled, className = '' } = props
  const isPressed = (v: T) => (props.type === 'single' ? props.value === v : props.value.includes(v))

  const press = (v: T) => {
    if (props.type === 'single') props.onChange(v)
    else props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v])
  }

  return (
    <div role="group" aria-label={label} className={`flex flex-wrap gap-[var(--spacing-sm)] ${className}`}>
      {options.map((option) => {
        const pressed = isPressed(option.value)
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            aria-label={option.accessibilityLabel}
            disabled={disabled}
            onClick={() => press(option.value)}
            className={`h-[24px] rounded-full border border-[var(--color-hairline)] px-[12px] text-[length:var(--text-sm)] leading-none transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] disabled:cursor-not-allowed disabled:opacity-50 ${
              pressed
                ? 'bg-[var(--color-hover-wash)] text-[var(--color-ink)]'
                : 'text-[color:var(--color-control)] hover:bg-[var(--color-hover-wash)] hover:text-[var(--color-muted-hi)]'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
