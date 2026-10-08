import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { ScrollArea } from '../ui/ScrollArea'
import { Surface } from './Surface'

/* The two side panels' frames. Content is the caller's; these own position,
 * material and scrolling.
 *
 * Left: 320px, beside the rail, full height. Right: 360px against the right
 * edge, full height too: the player centres on the free space between them
 * and is never wider than it, so it never reaches under the right panel, and
 * the panel doesn't jump when playback starts or stops (#288). Both are glass at
 * --radius-panel with their content in an overlay-scrollbar ScrollArea, x
 * pinned closed (#86). */

export function LeftPanel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Surface
      role="complementary"
      aria-label={label}
      className="absolute top-[var(--inset)] bottom-[var(--inset)] left-[calc(var(--inset)+var(--rail-width)+8px)] z-20 flex w-[var(--left-panel-width)] flex-col overflow-hidden rounded-[var(--radius-panel)]"
    >
      <ScrollArea className="flex-1" contentClassName="px-[20px] pt-[14px] pb-[20px]">
        {children}
      </ScrollArea>
    </Surface>
  )
}

export function RightPanel({ children, label, wash }: { children: ReactNode; label: string; wash?: string }) {
  return (
    <Surface
      role="complementary"
      aria-label={label}
      className="absolute top-[var(--inset)] right-[var(--inset)] bottom-[var(--inset)] z-20 flex w-[var(--right-panel-width)] flex-col overflow-hidden rounded-[var(--radius-panel)]"
      // The wash sits under the glass's own surface colour, so the panel keeps
      // its material and the cover colour reads as light falling through it.
      style={wash ? { background: `${wash}, var(--color-surface)` } : undefined}
    >
      <ScrollArea className="flex-1" contentClassName="p-[12px]">
        {children}
      </ScrollArea>
    </Surface>
  )
}

/* A panel's title row: the title in title style, ghost actions on the right,
 * 36px tall so the actions' 32px buttons sit centred on the title. */
export function PanelHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-[36px] items-center justify-between gap-[8px]">
      <h2 className="min-w-0 truncate text-title text-[var(--color-ink)]">{title}</h2>
      {actions && <div className="flex shrink-0 gap-[2px]">{actions}</div>}
    </div>
  )
}

/* A sub-page's way back: a chevron and the parent's name, secondary 500. */
export function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="-ml-[4px] flex h-[36px] items-center gap-[4px] text-[length:var(--text-secondary)] font-medium text-[var(--color-ink-2)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-ink)]"
    >
      <span className="inline-flex rotate-90">
        <Icon name="chevron-down" size={16} />
      </span>
      {label}
    </button>
  )
}
