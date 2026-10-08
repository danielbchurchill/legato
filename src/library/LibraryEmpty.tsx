import type { ReactNode } from 'react'

/* A library layout with nothing to show: DESIGN.md's empty pattern as the
 * v2 frames draw it, what's true as a heading and what to do in one
 * sentence, centred 120px under the header where LibraryStageV2 centres its
 * own empty state. An action, when there is one, goes under the sentence. */
export function LibraryEmpty({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div role="status" className="mx-auto mt-[120px] flex max-w-[440px] flex-col items-center gap-[8px] text-center">
      <span className="text-heading text-[var(--color-ink)]">{title}</span>
      <p className="text-[length:var(--text-secondary)] leading-[18px] [overflow-wrap:anywhere] [text-wrap:pretty] text-[var(--color-ink-2)]">
        {body}
      </p>
      {children && <div className="mt-[6px] flex gap-[8px]">{children}</div>}
    </div>
  )
}
