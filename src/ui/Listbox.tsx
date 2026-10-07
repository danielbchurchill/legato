import { useEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { enterOffset, useAnchoredPosition } from './floating'
import { useMountFade } from './useMountFade'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'
import { optionId, type ListboxOption } from './listboxNav'

/* The option list Select and Combobox both open — gpui-kit gives every
 * popup one surface (styled.rs `popover_style`), and Select and Combobox
 * share their list as well as that. Glass recipe, portaled and positioned
 * by floating.ts, at least as wide as its trigger.
 *
 * Focus never moves into the list: the trigger (Select's button,
 * Combobox's input) keeps it and points at the highlighted option through
 * aria-activedescendant, which is what lets a Combobox keep taking typed
 * characters while arrow keys move through the list. So this renders
 * options and reports clicks; the keyboard lives with the owner. */



export function Listbox<T extends string>({
  id,
  open,
  anchorRef,
  options,
  selected,
  highlighted,
  onHighlight,
  onSelect,
  monospace,
  emptyText = 'no matches',
}: {
  id: string
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  options: readonly ListboxOption<T>[]
  selected: T | null
  highlighted: number
  onHighlight: (index: number) => void
  onSelect: (value: T) => void
  monospace?: boolean
  emptyText?: string
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const shown = useMountFade(open)
  const reduced = usePrefersReducedMotion()
  const position = useAnchoredPosition({
    open,
    anchorRef,
    floatingRef: listRef,
    placement: 'bottom',
    align: 'start',
    gap: 4,
    deps: [options.length],
  })

  // Keep the highlighted option in view as the keyboard walks past the
  // list's visible edge.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector(`#${CSS.escape(optionId(id, highlighted))}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, highlighted, id])

  if (!open) return null
  return createPortal(
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      // A press on the list must not blur the trigger before the click
      // lands, or Combobox's input would close the list out from under it.
      onPointerDown={(e) => e.preventDefault()}
      className="fixed z-40 max-h-[240px] overflow-y-auto rounded-[var(--radius-control)] glass p-[4px] transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--ease-enter)]"
      style={{
        opacity: shown ? 1 : 0,
        transform: shown || reduced ? 'none' : enterOffset(position.placement),
        top: `${position.top}px`,
        left: `${position.left}px`,
        minWidth: `${position.anchorWidth}px`,
      }}
    >
      {options.length === 0 && (
        <li className="px-[8px] py-[6px] text-[length:var(--text-sm)] text-[color:var(--color-muted)]">{emptyText}</li>
      )}
      {options.map((option, index) => {
        const isSelected = option.value === selected
        return (
          <li
            key={option.value}
            id={optionId(id, index)}
            role="option"
            aria-selected={isSelected}
            aria-disabled={option.disabled || undefined}
            onPointerMove={() => !option.disabled && index !== highlighted && onHighlight(index)}
            onClick={() => !option.disabled && onSelect(option.value)}
            className={`flex min-h-[28px] cursor-pointer items-center justify-between gap-[var(--spacing-sm)] rounded-[var(--radius-small)] px-[8px] text-[length:var(--text-sm)] ${
              index === highlighted ? 'bg-[var(--color-hover-wash)]' : ''
            } ${option.disabled ? 'cursor-not-allowed text-[color:var(--color-muted)]' : isSelected ? 'text-[var(--color-ink)]' : 'text-[color:var(--color-control)]'} ${
              monospace ? 'font-[family-name:var(--font-mono)]' : ''
            }`}
          >
            <span className="min-w-0 truncate" title={option.label}>
              {option.label}
            </span>
            {isSelected && <Icon name="checkmark" size={14} />}
          </li>
        )
      })}
    </ul>,
    document.body,
  )
}
