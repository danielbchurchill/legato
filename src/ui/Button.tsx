import type { ReactNode, Ref } from 'react'
import { Icon, type IconName } from './Icon'

/* Text buttons, v2. Four shapes, by how much the action matters:
 *
 *  - `primary`: the legato.fm gradient, dark on-accent text. The one thing a
 *    surface is for — play, Write to 9 files, Add connection. At most one per
 *    group.
 *  - `secondary`: a --color-wash-2 pill in ink. Its sibling — shuffle,
 *    cancel-shaped actions that still deserve a button.
 *  - `link`: 13/500 ink-2 text stepping to ink on hover. Navigation and small
 *    reversible actions: "see all", "clear", "details ›".
 *  - `destructive`: the pre-v2 name for a consequential action that isn't
 *    the primary one. v2 has no separate destructive shape, so it renders as
 *    secondary; kept so older call sites keep a meaningful name.
 *
 * Pills at 32px (28 inside a dense row, 36 for a hero action), 13/500, with an optional 16px icon —
 * filled, since an outline glyph on the gradient reads as a hole. An icon
 * with no label is a circle, named by aria-label. */

type ButtonVariant = 'primary' | 'secondary' | 'link' | 'destructive'
type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'rounded-full bg-[image:var(--accent-fill)] text-[var(--color-on-accent)] hover:brightness-110 disabled:opacity-40',
  secondary: 'rounded-full bg-[var(--color-wash-2)] text-[var(--color-ink)] hover:bg-[var(--color-line-strong)] disabled:opacity-40',
  destructive: 'rounded-full bg-[var(--color-wash-2)] text-[var(--color-ink)] hover:bg-[var(--color-line-strong)] disabled:opacity-40',
  link: 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-40',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-[28px]',
  md: 'h-[32px]',
  lg: 'h-[36px]',
}

type ButtonProps = {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading glyph, drawn filled at 16px. */
  icon?: IconName
  type?: 'button' | 'submit'
  onClick?: () => void
  disabled?: boolean
  className?: string
  /** Left out for an icon alone, which then needs an aria-label. */
  children?: ReactNode
  'aria-label'?: string
  /** AlertDialog points its initial focus at its cancel button. */
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'link',
  size = 'md',
  icon,
  type = 'button',
  onClick,
  disabled,
  className = '',
  children,
  'aria-label': ariaLabel,
  ref,
}: ButtonProps) {
  const pill = variant !== 'link'
  const iconOnly = icon != null && children == null
  const padding = pill ? (iconOnly ? 'aspect-square' : icon ? 'pl-[10px] pr-[14px]' : 'px-[16px]') : ''
  return (
    <button
      ref={ref}
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`inline-flex shrink-0 items-center justify-center gap-[6px] text-[length:var(--text-secondary)] leading-none font-medium whitespace-nowrap transition-[color,background-color,filter] duration-[var(--motion-fast)] ease-[var(--ease-out)] disabled:pointer-events-none ${
        pill ? SIZE_CLASSES[size] : ''
      } ${padding} ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {icon && <Icon name={icon} size={16} filled={variant === 'primary'} />}
      {children}
    </button>
  )
}
