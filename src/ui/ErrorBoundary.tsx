import { Component, type ErrorInfo, type ReactNode } from 'react'

/* Keeps a render error from unmounting everything above it. Without one,
 * React 19 drops the whole tree and the window goes blank, with the reason
 * only in the web inspector, which a packaged build doesn't open.
 *
 * `fallback` gets the error and a reset, which re-renders the children.
 * A reset only helps when the cause has moved on (another node selected,
 * fresh data), so a panel's fallback offers it and the root's reloads. */

type ErrorBoundaryProps = {
  fallback: (error: Error, reset: () => void) => ReactNode
  children: ReactNode
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[legato] render error', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children
  }
}

/* What a fallback says: one line in plain words, then the error itself in
 * mono, selectable so it can be pasted into an issue. */
export function RenderError({ title, error, action }: { title: string; error: Error; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-[6px] text-left">
      <p className="text-[length:var(--text-secondary)] text-[var(--color-ink)]">{title}</p>
      <p data-selectable className="mono text-[11px] [overflow-wrap:anywhere] text-[var(--color-ink-3)]">
        {error.message}
      </p>
      {action}
    </div>
  )
}
