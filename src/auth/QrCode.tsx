import { useMemo } from 'react'
import type { ResolvedTheme } from '../hooks/useTheme'
import { qrPath } from './qrPath'

/* Always dark modules on a light plate, whichever theme is active: plenty
 * of phone scanners still can't read an inverted code. Neither color token
 * is the same in both themes, so this picks the pair by theme, the same
 * whole-asset exception as the wordmark (DESIGN.md "Type"). */
export function QrCode({ value, theme, label }: { value: string; theme: ResolvedTheme; label: string }) {
  const { path, size } = useMemo(() => qrPath(value), [value])
  const plate = theme === 'light' ? 'var(--color-canvas)' : 'var(--color-ink)'
  const modules = theme === 'light' ? 'var(--color-ink)' : 'var(--color-canvas)'
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="h-[168px] w-[168px]"
    >
      <rect width={size} height={size} fill={plate} />
      <path d={path} fill={modules} />
    </svg>
  )
}
