import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { Listbox } from './Listbox'
import { firstEnabled, optionId, stepHighlight, type ListboxOption } from './listboxNav'

/* A hand port of gpui-kit's Select (crates/component/src/select.rs), drawn
 * in Legato's palette. Replaces the native <select> — whose popup is OS
 * chrome in the wrong typeface over the glass, the same C-1 complaint that
 * retired title= tooltips — with the shared Listbox.
 *
 * The trigger is an inset control well (DESIGN.md "Raised and inset"):
 * --color-inset fill, hairline edge, --radius-control, no shadow. 32px
 * tall with 12px sides — gpui-kit's medium input — at --text-sm.
 *
 * Keyboard, from gpui-kit and the WAI-ARIA select-only combobox pattern:
 * Down/Up/Enter/Space open it; while open, arrows move the highlight, Home/
 * End jump to the ends, Enter/Space choose, Escape and Tab close without
 * choosing. Typing a letter jumps to the next option starting with it,
 * open or closed. */

type SelectProps<T extends string> = {
  options: readonly ListboxOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name. */
  label: string
  placeholder?: string
  disabled?: boolean
  /** Options are data (device names, paths) — Sometype Mono. */
  monospace?: boolean
  className?: string
}

export function Select<T extends string>({
  options,
  value,
  onChange,
  label,
  placeholder = 'choose…',
  disabled,
  monospace = false,
  className = '',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const selectedIndex = options.findIndex((o) => o.value === value)
  const [highlighted, setHighlighted] = useState(selectedIndex)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const typeahead = useRef({ text: '', at: 0 })

  const openList = () => {
    setHighlighted(selectedIndex >= 0 ? selectedIndex : firstEnabled(options))
    setOpen(true)
  }

  const choose = (next: T) => {
    onChange(next)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    // Blur alone can't be trusted to close it: WebKit doesn't focus a
    // button it clicks, so a mouse-opened list may never have had focus to
    // lose. The list itself is exempt, or a press on an option would
    // unmount it before the click could land.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || document.getElementById(listId)?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, listId])

  const jumpTo = (char: string) => {
    const now = Date.now()
    // Keys typed within half a second build one prefix ("sy" for "system
    // default"), the way a native select does.
    typeahead.current = {
      text: now - typeahead.current.at < 500 ? typeahead.current.text + char : char,
      at: now,
    }
    const prefix = typeahead.current.text.toLowerCase()
    const from = open ? highlighted : selectedIndex
    const ordered = options.map((_, i) => (from + 1 + i) % options.length)
    const match = ordered.find((i) => !options[i].disabled && options[i].label.toLowerCase().startsWith(prefix))
    if (match == null) return
    if (open) setHighlighted(match)
    else onChange(options[match].value)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        openList()
      } else if (e.key.length === 1) {
        jumpTo(e.key)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlighted((h) => stepHighlight(options, h, 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlighted((h) => stepHighlight(options, h, -1))
        break
      case 'Home':
        e.preventDefault()
        setHighlighted(firstEnabled(options))
        break
      case 'End':
        e.preventDefault()
        setHighlighted(firstEnabled(options, true))
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (options[highlighted] && !options[highlighted].disabled) choose(options[highlighted].value)
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        if (e.key.length === 1) jumpTo(e.key)
    }
  }

  const current = options[selectedIndex]

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && highlighted >= 0 ? optionId(listId, highlighted) : undefined}
        disabled={disabled}
        onClick={(e) => {
          e.currentTarget.focus({ preventScroll: true })
          if (open) setOpen(false)
          else openList()
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
        className={`flex h-[32px] w-full min-w-0 items-center justify-between gap-[var(--spacing-sm)] rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-wash)] px-[12px] text-left text-[length:var(--text-sm)] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        <span
          className={`min-w-0 truncate ${current ? 'text-[var(--color-ink)]' : 'text-[color:var(--color-muted)]'} ${
            monospace && current ? 'font-[family-name:var(--font-mono)]' : ''
          }`}
          title={current?.label}
        >
          {current?.label ?? placeholder}
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className={`text-[var(--color-muted)] transition-transform duration-[var(--motion-fast)] ease-[var(--ease-out)] ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <Listbox
        id={listId}
        open={open}
        anchorRef={triggerRef}
        options={options}
        selected={value}
        highlighted={highlighted}
        onHighlight={setHighlighted}
        onSelect={choose}
        monospace={monospace}
      />
    </>
  )
}
