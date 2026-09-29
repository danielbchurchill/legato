import { Icon } from './Icon'

/* A hand port of gpui-kit's Checkbox (crates/component/src/checkbox.rs),
 * drawn in Legato's palette. See DESIGN.md "Controls".
 *
 * Unchecked is a --color-control outline on nothing; checked and
 * indeterminate fill with --color-ink (gpui-kit's primary) and cut the mark
 * out in --color-canvas (its primary_foreground). The mark fades in on
 * --ease-spring-control, gpui-kit's spring_control, rather than snapping.
 * Corners are --radius-small — gpui-kit's 4px cap, the one thing keeping a
 * checked box from reading as a radio. Disabled fades the box to 50% and
 * steps the label down to muted.
 *
 * The whole row, label included, is one <button role="checkbox">, so the
 * label is as clickable as the box and the focus ring hugs the box alone
 * (data-focus-ring="part", index.css). */

export type CheckboxSize = 'sm' | 'md' | 'lg'

const GEOMETRY: Record<CheckboxSize, { box: string; mark: number }> = {
  sm: { box: 'size-[14px]', mark: 10 },
  md: { box: 'size-[16px]', mark: 12 },
  lg: { box: 'size-[20px]', mark: 14 },
}

type CheckboxProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Some-but-not-all: renders a dash, and a click checks it fully. */
  indeterminate?: boolean
  disabled?: boolean
  size?: CheckboxSize
  label?: string
  accessibilityLabel?: string
  className?: string
}

export function Checkbox({
  checked,
  onChange,
  indeterminate = false,
  disabled,
  size = 'md',
  label,
  accessibilityLabel,
  className = '',
}: CheckboxProps) {
  const geometry = GEOMETRY[size]
  const filled = checked || indeterminate
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={accessibilityLabel ?? label}
      disabled={disabled}
      data-focus-ring="part"
      onClick={() => onChange(indeterminate ? true : !checked)}
      className={`inline-flex items-center gap-[8px] disabled:cursor-not-allowed ${className}`}
    >
      <span
        className={`focus-ring-part flex shrink-0 items-center justify-center rounded-[var(--radius-small)] border transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] ${geometry.box} ${
          filled
            ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
            : 'border-[var(--color-control)] bg-transparent text-transparent'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <span
          className="flex transition-opacity duration-[var(--motion-spring-control)] ease-[var(--ease-spring-control)]"
          style={{ opacity: filled ? 1 : 0 }}
        >
          <Icon name={indeterminate ? 'subtract' : 'checkmark'} size={geometry.mark} />
        </span>
      </span>
      {label && (
        <span
          className={`min-w-0 text-left text-[length:var(--text-sm)] ${
            disabled ? 'text-[color:var(--color-muted)]' : 'text-[color:var(--color-control)]'
          }`}
        >
          {label}
        </span>
      )}
    </button>
  )
}
