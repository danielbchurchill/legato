import type { ReactNode } from 'react'

/* A whole-window message: the server starting, the sign-in check, the
 * owner gate. The one layout in the app that isn't the shell, used only
 * before there's a shell to show. */
export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-[12px] bg-[var(--color-canvas)] p-[24px] text-center text-[length:var(--text-body)] text-[var(--color-ink)]">
      {children}
    </div>
  )
}
