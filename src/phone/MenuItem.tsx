/** A row of a phone menu, 44px: node detail's "more", Now playing's and a
 * held track row's. */
export function MenuItem({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: string }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex h-[44px] w-full items-center rounded-[10px] px-[12px] text-left text-[length:var(--text-body)] text-[var(--color-ink)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)] disabled:text-[var(--color-ink-3)]"
      >
        {children}
      </button>
    </li>
  )
}
