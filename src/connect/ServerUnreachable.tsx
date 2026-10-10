import whiteWordmarkSrc from '../assets/brand/white-wordmark.svg'
import blackWordmarkSrc from '../assets/brand/black-wordmark.svg'
import type { ResolvedTheme } from '../hooks/useTheme'
import { Button } from '../ui/Button'
import type { OutageCopy } from './unreachable'

/* The server-unreachable state (issue #119): what happened as the title,
 * the likely why under it, and one action, "try again". There's no spinner:
 * the client keeps checking in the background and the footer says so, so
 * the state never has to pretend to be busy.
 *
 * Two forms, the same words in both:
 *   - over the shell, once the app has been running. The shell stays mounted
 *     underneath, so the queue and the web player survive, and the player
 *     stays above the wash: whatever's buffered keeps playing and can be
 *     paused. The map shows through, as it does behind a dialog.
 *   - the whole window, on the bare canvas with the wordmark, when there's
 *     no shell: a launch with the server already gone, or the sign-in check
 *     still waiting. */

export type UnreachableView = OutageCopy & {
  /** Says the client keeps trying, and when a "try again" last failed. */
  footer: string
  retrying: boolean
  onRetry: () => void
  onConnectElsewhere: () => void
}

function Content({ view, heading: Heading }: { view: UnreachableView; heading: 'h1' | 'h2' }) {
  return (
    <>
      <Heading className="text-title text-[var(--color-ink)]">{view.title}</Heading>
      <div role="alert" className="flex flex-col gap-[6px]">
        <p className="text-body [text-wrap:pretty] text-[var(--color-ink-2)]">{view.why}</p>
        {view.hint && <p className="text-secondary [text-wrap:pretty] text-[var(--color-ink-3)]">{view.hint}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-[var(--spacing-lg)] gap-y-[8px] pt-[6px]">
        <Button variant="primary" size="lg" onClick={view.onRetry} disabled={view.retrying}>
          {view.retrying ? 'trying…' : 'try again'}
        </Button>
        <Button onClick={view.onConnectElsewhere}>connect to a different server</Button>
      </div>
      <p className="text-small [text-wrap:pretty] text-[var(--color-ink-3)]">{view.footer}</p>
    </>
  )
}

export function ServerUnreachableWindow({ view, theme }: { view: UnreachableView; theme: ResolvedTheme }) {
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-[var(--color-canvas)] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-full max-w-[440px] flex-col items-center justify-center gap-[14px] px-[24px] py-[56px] text-center">
        <img
          src={theme === 'light' ? blackWordmarkSrc : whiteWordmarkSrc}
          alt="legato"
          className="mb-[6px] h-[var(--text-wordmark)] w-auto select-none"
        />
        <Content view={view} heading="h1" />
      </div>
    </div>
  )
}

/** Over the shell: covers the stage and the panels, and sits under the
 * player, which the shell draws after it. */
export function ServerUnreachableOverShell({ view }: { view: UnreachableView }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-[color-mix(in_srgb,var(--color-canvas)_60%,transparent)] p-[24px]">
      <section
        aria-label="Server unreachable"
        className="glass flex max-w-[440px] flex-col items-center gap-[14px] rounded-[var(--radius-panel)] p-[var(--spacing-panel)] text-center"
      >
        <Content view={view} heading="h2" />
      </section>
    </div>
  )
}
