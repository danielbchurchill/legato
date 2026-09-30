import { useState, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { snapToStep, stepDecimals } from './sliderMath'

/* A hand port of gpui-kit's NumberInput (crates/component/src/
 * number_input.rs): a text field flanked by decrement and increment
 * buttons, in place of <input type="number">, whose native spinner arrows
 * are OS chrome the size of a fingernail and whose parsing accepts "1e3"
 * and "--" without complaint.
 *
 * Typing is free-form while the field has focus. On Enter or blur the text
 * is parsed, clamped to min/max, and snapped to the step grid; text that
 * isn't a number reverts to the last good value rather than erasing it.
 * Up/Down step while typing (Shift for ten steps), the same as the buttons.
 * `null` is a real value — an empty field — for a tag that simply isn't
 * set, like a track's bpm.
 *
 * Two appearances: `well`, the inset control well Select and Combobox use,
 * and `bare`, for an inline edit sitting in a DataRow alongside plain text
 * inputs that have no well either — MetadataFields' bpm. Rubik by default;
 * `monospace` when the number is library data. */

type NumberInputProps = {
  value: number | null
  onChange: (value: number | null) => void
  min?: number
  max?: number
  step?: number
  label: string
  disabled?: boolean
  appearance?: 'well' | 'bare'
  monospace?: boolean
  /** --text-base for a data row; --text-sm (default) for control chrome. */
  textSize?: 'sm' | 'base'
  className?: string
}

export function NumberInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  label,
  disabled,
  appearance = 'well',
  monospace = false,
  textSize = 'sm',
  className = '',
}: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const format = (v: number | null) => (v == null ? '' : v.toFixed(stepDecimals(step)))
  const normalize = (v: number) => snapToStep(v, Number.isFinite(min) ? min : v - (v % step), max, step)

  const commit = () => {
    if (draft == null) return
    const text = draft.trim()
    setDraft(null)
    if (text === '') {
      onChange(null)
      return
    }
    // Number() rather than parseFloat: "12abc" is a typo to reject, not 12.
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    onChange(normalize(parsed))
  }

  const stepBy = (direction: 1 | -1, multiplier = 1) => {
    const base = draft != null && Number.isFinite(Number(draft)) && draft.trim() !== '' ? Number(draft) : value
    const from = base ?? (Number.isFinite(min) ? min : 0)
    setDraft(null)
    onChange(normalize(Math.min(max, Math.max(min, from + direction * step * multiplier))))
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit()
    } else if (e.key === 'Escape' && draft != null) {
      e.stopPropagation()
      setDraft(null)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      stepBy(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : 1)
    }
  }

  const atMin = value != null && value <= min
  const atMax = value != null && value >= max
  const stepButton = 'flex shrink-0 items-center justify-center text-[var(--color-muted)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)] disabled:pointer-events-none disabled:opacity-40'

  return (
    <div
      className={`focus-ring-well flex min-w-0 items-center gap-[var(--spacing-xs)] ${
        appearance === 'well'
          ? 'h-[32px] rounded-[var(--radius-control)] border border-[var(--color-hairline)] bg-[var(--color-inset)] px-[8px]'
          : 'rounded-[var(--radius-small)]'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${className}`}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Decrease ${label}`}
        disabled={disabled || atMin}
        onClick={() => stepBy(-1)}
        className={stepButton}
      >
        <Icon name="subtract" size={16} />
      </button>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        disabled={disabled}
        value={draft ?? format(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className={`w-full min-w-0 flex-1 bg-transparent text-center text-[var(--color-ink)] tabular-nums outline-none ${
          textSize === 'base' ? 'text-[length:var(--text-base)]' : 'text-[length:var(--text-sm)]'
        } ${monospace ? 'font-[family-name:var(--font-mono)]' : ''}`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Increase ${label}`}
        disabled={disabled || atMax}
        onClick={() => stepBy(1)}
        className={stepButton}
      >
        <Icon name="add" size={16} />
      </button>
    </div>
  )
}
