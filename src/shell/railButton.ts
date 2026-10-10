/** A rail button's look, at rest or lit. Rail.tsx's buttons and the
 * connection indicator (#118) both draw with it, so the indicator can't
 * drift from the rail's own. */
export function railButtonClass(active: boolean): string {
  return `grid size-[40px] shrink-0 place-items-center rounded-[12px] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] ${
    active
      ? 'bg-[var(--color-wash-2)] text-[var(--color-ink)]'
      : 'text-[var(--color-ink-2)] hover:bg-[var(--color-wash)] hover:text-[var(--color-ink)]'
  }`
}
