/* v2's toggle switch — settings/nodes/lock, settings/nodes/images-per-type.
 * See DESIGN.md "Controls" -> "v2: settings primitives". State reads from
 * knob position, not a color change: track and knob share one resting
 * color (--color-control) at every state. */

type ToggleProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  className?: string
}

export function Toggle({ checked, onChange, disabled, label, className = '' }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[10px] w-[20px] shrink-0 disabled:pointer-events-none disabled:opacity-40 ${className}`}
    >
      {/* Track is a sibling of the knob, not its bordered parent — nesting the
       * knob inside a bordered button ate 1px of the button's own border-box
       * into the knob's coordinate space each axis, so the knob overflowed the
       * track by 1px (visible in the rendered app, absent from the Figma
       * source, which draws them exactly this way: two siblings sharing one
       * unbordered 20x10 frame). */}
      <span className="absolute inset-0 rounded-full border border-[var(--color-control)]" />
      <span
        className={`absolute top-0 size-[10px] rounded-full bg-[var(--color-control)] transition-[left] duration-[var(--motion-fast)] ease-[var(--ease-out)] ${
          checked ? 'left-[10px]' : 'left-0'
        }`}
      />
    </button>
  )
}
