import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { Listbox } from './Listbox'
import { firstEnabled, optionId, stepHighlight, type ListboxOption } from './listboxNav'

/* A hand port of gpui-kit's Combobox (crates/component/src/combobox.rs): a
 * Select you can type into to filter. Same inset well and shared Listbox as
 * Select.tsx; the difference is that focus lives in a real text input, so
 * characters narrow the list instead of jumping through it.
 *
 * Filtering is a case-insensitive substring match on the label. While the
 * input is idle it shows the chosen option's label; focusing it selects
 * that text so typing replaces it, and leaving without choosing puts it
 * back — the query is scratch, never a value of its own. */

type ComboboxProps<T extends string> = {
  options: readonly ListboxOption<T>[]
  value: T | null
  onChange: (value: T) => void
  label: string
  placeholder?: string
  disabled?: boolean
  monospace?: boolean
  className?: string
}

export function Combobox<T extends string>({
  options,
  value,
  onChange,
  label,
  placeholder = 'search…',
  disabled,
  monospace = false,
  className = '',
}: ComboboxProps<T>) {
  const current = options.find((o) => o.value === value)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const wellRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const filtered = useMemo(() => {
    if (!query) return options
    const needle = query.toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(needle))
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (wellRef.current?.contains(target) || document.getElementById(listId)?.contains(target)) return
      setOpen(false)
      setQuery(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, listId])

  const openList = () => {
    const index = filtered.findIndex((o) => o.value === value)
    setHighlighted(index >= 0 ? index : firstEnabled(filtered))
    setOpen(true)
  }

  const choose = (next: T) => {
    onChange(next)
    setQuery(null)
    setOpen(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (!open) openList()
        else setHighlighted((h) => stepHighlight(filtered, h, 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        if (!open) openList()
        else setHighlighted((h) => stepHighlight(filtered, h, -1))
        break
      case 'Enter':
        if (open && filtered[highlighted] && !filtered[highlighted].disabled) {
          e.preventDefault()
          choose(filtered[highlighted].value)
        }
        break
      case 'Escape':
        if (open || query != null) {
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
          setQuery(null)
        }
        break
      case 'Tab':
        setOpen(false)
        setQuery(null)
        break
    }
  }

  return (
    <>
      <div
        ref={wellRef}
        className={`focus-ring-well flex h-[32px] w-full min-w-0 items-center gap-[var(--spacing-sm)] rounded-[var(--radius-control)] border border-[var(--color-hairline)] bg-[var(--color-inset)] px-[12px] ${
          disabled ? 'cursor-not-allowed opacity-50' : ''
        } ${className}`}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && highlighted >= 0 ? optionId(listId, highlighted) : undefined}
          disabled={disabled}
          placeholder={placeholder}
          value={query ?? current?.label ?? ''}
          onFocus={(e) => e.currentTarget.select()}
          onClick={() => !open && openList()}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlighted(0)
            setOpen(true)
          }}
          onKeyDown={handleKeyDown}
          className={`min-w-0 flex-1 bg-transparent text-[length:var(--text-sm)] text-[var(--color-ink)] outline-none placeholder:text-[color:var(--color-muted)] ${
            monospace ? 'font-[family-name:var(--font-mono)]' : ''
          }`}
        />
        <Icon name="search" size={16} className="text-[var(--color-muted)]" />
      </div>
      <Listbox
        id={listId}
        open={open}
        anchorRef={wellRef}
        options={filtered}
        selected={value}
        highlighted={highlighted}
        onHighlight={setHighlighted}
        onSelect={choose}
        monospace={monospace}
      />
    </>
  )
}
