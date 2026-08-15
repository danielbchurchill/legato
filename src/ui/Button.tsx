import type { ReactNode } from 'react'

/* Two control shapes (C-3). Every button in the app used to be underlined
 * text regardless of what it did — "approve — write to file", the one
 * irreversible action in the product, looked exactly like "cancel". See
 * DESIGN.md "Controls".
 *
 * The split is by consequence, not by prominence: `link` covers anything
 * reversible — navigation, retry, resubmit, undo itself — and stays the
 * underlined shape the app already had, since most actions here genuinely
 * are this. `destructive` is for the rare action with no undo. It's
 * distinguished by shape, not color: DESIGN.md's palette has no danger
 * token, deliberately (the same constraint NowPlayingPanel's error text
 * already respects), so a bordered pill carries the weight color can't. */

type ButtonVariant = 'link' | 'destructive'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  link: 'text-[var(--color-ink)] underline decoration-[var(--color-hairline)] underline-offset-2 hover:text-[var(--color-muted-hi)]',
  destructive: 'rounded-full border border-[var(--color-hairline)] px-[14px] py-[4px] text-[var(--color-ink)] hover:bg-white/8',
}

type ButtonProps = {
  variant?: ButtonVariant
  type?: 'button' | 'submit'
  onClick?: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}

export function Button({ variant = 'link', type = 'button', onClick, disabled, className = '', children }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`text-[length:var(--text-base)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] disabled:pointer-events-none disabled:opacity-40 ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </button>
  )
}
