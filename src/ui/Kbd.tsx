import type { ReactNode } from 'react'

/* A keycap — gpui-kit's Kbd (kbd.rs): 4px/2px padding, a 20px minimum
 * width so a single-character key ("/") doesn't collapse to a sliver next
 * to a word-length one ("space"), --radius-small, --text-sm.
 *
 * Rubik, not mono: a keybinding is the app's own UI, not data off a disk
 * file (DESIGN.md "The one rule"). Ink by default, because in a shortcut
 * list the key is the answer to the row's question; `muted` is gpui-kit's
 * borderless appearance for a key riding inside something else, like a
 * tooltip, where a second bordered box would crowd the first. */
export function Kbd({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <kbd
      className={`inline-flex min-w-[20px] items-center justify-center font-[family-name:var(--font-ui)] text-[length:var(--text-sm)] leading-none ${
        muted
          ? 'text-[color:var(--color-muted)]'
          : 'rounded-[var(--radius-small)] border border-[var(--color-hairline)] px-[4px] py-[2px] text-[var(--color-ink)]'
      }`}
    >
      {children}
    </kbd>
  )
}
