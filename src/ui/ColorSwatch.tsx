/* v2's color swatch — the per-type edge-color picker. See DESIGN.md "Edge
 * palette" -> "v2: user-colorable types" and "Controls" -> "v2: settings
 * primitives". A plain square, no radius — confirmed against Figma
 * dev-mode, not the rounded shape it first looks like in a screenshot.
 * Consistent with "artwork is reproduced, not styled" elsewhere in the
 * design: a swatch is a sample of a color, not a UI chip. */

type ColorSwatchProps = {
  color: string
  label: string
  selected?: boolean
  onClick?: () => void
  className?: string
}

export function ColorSwatch({ color, label, selected, onClick, className = '' }: ColorSwatchProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
      className={`flex flex-col items-center gap-[var(--spacing-xs)] ${className}`}
    >
      <span
        className={`size-[15px] ${selected ? 'ring-1 ring-[var(--color-ink)] ring-offset-2 ring-offset-[var(--color-canvas)]' : ''}`}
        style={{ backgroundColor: color }}
      />
      <span className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{label}</span>
    </button>
  )
}
