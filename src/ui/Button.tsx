import type { ReactNode, Ref } from 'react'

/* Two control shapes (C-3). Every button in the app used to be underlined
 * text regardless of what it did — "approve — write to file", the one
 * irreversible action in the product, looked exactly like "cancel". See
 * DESIGN.md "Controls".
 *
 * The split is by consequence, not by prominence: `link` covers anything
 * reversible — navigation, retry, resubmit, undo itself — and `destructive`
 * is for the rare action with no undo. It's distinguished by shape, not
 * color: DESIGN.md's palette has no danger token, deliberately (the same
 * constraint NowPlayingPanel's error text already respects), so a bordered
 * pill carries the weight color can't.
 *
 * `link` no longer underlines (#30) — the underline read badly wherever it
 * appeared, and every other "click this text" affordance in the app had
 * already settled on a plain hover color-shift with no underline (see
 * DESIGN.md "v2: panels without a frame"), so this brings the shared
 * component in line with its own siblings rather than inventing a new
 * treatment. The color shift already here is the real state feedback. */

type ButtonVariant = 'link' | 'destructive'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  link: 'text-[var(--color-ink)] hover:text-[var(--color-muted-hi)]',
  destructive:
    'rounded-full border border-[var(--color-hairline)] px-[14px] py-[4px] text-[var(--color-ink)] hover:bg-[var(--color-hover-wash)]',
}

type ButtonProps = {
  variant?: ButtonVariant
  type?: 'button' | 'submit'
  onClick?: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
  /** AlertDialog points its initial focus at its cancel button. */
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'link', type = 'button', onClick, disabled, className = '', children, ref }: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`text-[length:var(--text-base)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] disabled:pointer-events-none disabled:opacity-40 ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </button>
  )
}
