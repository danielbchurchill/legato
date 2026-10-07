import { Button } from '../ui/Button'
import { useShellLayout } from '../shell/layout'

/* The map's notices: a scan that failed, a map with nothing on it, and a
 * layout that pushed everything off screen. Each is one glass card in the
 * middle of the free space, saying what's true and what to do. */

type NoticeAction = { label: string; onClick: () => void; primary?: boolean }

export function MapNotice({ title, body, actions = [] }: { title: string; body: string; actions?: NoticeAction[] }) {
  const layout = useShellLayout()
  return (
    <div
      role="status"
      className="glass absolute z-10 flex w-[380px] -translate-x-1/2 -translate-y-1/2 flex-col gap-[8px] rounded-[var(--radius-rail)] p-[20px]"
      style={{ left: layout.cx, top: '46%' }}
    >
      <span className="text-heading text-[var(--color-ink)]">{title}</span>
      <p className="text-[length:var(--text-secondary)] leading-[18px] [overflow-wrap:anywhere] text-[var(--color-ink-2)]">{body}</p>
      {actions.length > 0 && (
        <div className="mt-[6px] flex gap-[8px]">
          {actions.map((action) => (
            <Button key={action.label} variant={action.primary ? 'primary' : 'secondary'} onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
