/* Listbox.tsx's pure helpers — option ids and keyboard stepping — split
 * out so that file exports only components (react/only-export-components).
 * Select and Combobox import these directly. */

export type ListboxOption<T extends string> = { value: T; label: string; disabled?: boolean }

export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`
}

/* Next enabled option from `from` in `direction`, stopping at the ends
 * rather than wrapping — gpui-kit's list does the same, so holding an arrow
 * key parks on the last option instead of cycling back to the top. */
export function stepHighlight<T extends string>(
  options: readonly ListboxOption<T>[],
  from: number,
  direction: 1 | -1,
): number {
  for (let i = from + direction; i >= 0 && i < options.length; i += direction) {
    if (!options[i].disabled) return i
  }
  return from
}

export function firstEnabled<T extends string>(options: readonly ListboxOption<T>[], fromEnd = false): number {
  const indices = options.map((_, i) => i)
  if (fromEnd) indices.reverse()
  return indices.find((i) => !options[i].disabled) ?? -1
}
