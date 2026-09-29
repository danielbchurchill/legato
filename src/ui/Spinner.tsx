import { Icon } from './Icon'

/* gpui-kit's Spinner (crates/component/src/spinner.rs): proicons' own
 * "Spinner" arc — a three-quarter circle — turning once every
 * --motion-spinner. It inherits colour and size from where it sits, like
 * every other glyph (DESIGN.md "Iconography").
 *
 * DESIGN.md's progress rule still decides when one belongs: not for a wait
 * under ~400ms (say nothing), and never where the real count is known (use
 * Progress). A spinner is for a genuinely unknown, genuinely long wait
 * next to the control that started it. Reduced motion freezes the arc. */
export function Spinner({ size = 16, label, className = '' }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      className={`inline-flex animate-[spinner-spin_var(--motion-spinner)_linear_infinite] ${className}`}
    >
      <Icon name="spinner" size={size} />
    </span>
  )
}
