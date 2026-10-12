import type { Ref } from 'react'

/* The v2 input well: 34px, --radius-control, sunk into the surface
 * (--color-sunken with a 1px line), mono 12 because what goes in one is a
 * value — a label, a date, a bpm, a path. Focus turns the border accent with a
 * 25% accent ring outside it (index.css's .focus-ring-well).
 *
 * `lg` is the phone's (#389): 44px, a tap target, with prose at 16px, under
 * which iOS Safari zooms the page into a field it focuses. */

type TextFieldProps = {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  /** Rubik instead of mono, for free text (a note, a playlist name). */
  prose?: boolean
  autoFocus?: boolean
  onEnter?: () => void
  onEscape?: () => void
  className?: string
  inputMode?: 'text' | 'numeric' | 'decimal'
  ref?: Ref<HTMLInputElement>
  size?: 'md' | 'lg'
}

export function TextField({
  value,
  onChange,
  label,
  placeholder,
  prose = false,
  autoFocus,
  onEnter,
  onEscape,
  className = '',
  inputMode,
  ref,
  size = 'md',
}: TextFieldProps) {
  return (
    <div
      className={`focus-ring-well flex ${size === 'lg' ? 'h-[44px]' : 'h-[34px]'} min-w-0 items-center rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-sunken)] px-[10px] transition-[border-color] duration-[var(--motion-fast)] ${className}`}
    >
      <input
        ref={ref}
        type="text"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault()
            onEnter()
          } else if (e.key === 'Escape' && onEscape) {
            e.preventDefault()
            e.stopPropagation()
            onEscape()
          }
        }}
        className={`w-full min-w-0 bg-transparent text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-3)] ${
          prose ? (size === 'lg' ? 'text-[16px]' : 'text-[length:var(--text-secondary)]') : 'mono text-[length:var(--text-mono)]'
        }`}
      />
    </div>
  )
}
