import type { CSSProperties, ReactNode, Ref } from 'react'

/* A floating glass surface: the rail, both side panels, the capsule, the
 * player, the map's card, toolbar and legend. The material is the `glass`
 * utility (index.css); everything about shape — radius, padding, position —
 * is the caller's, because v2's surfaces share a material, not a geometry.
 *
 * Blur is load-bearing, not decoration: the map running underneath is the
 * whole concept, so these never become opaque. See DESIGN.md "Glass". */

type SurfaceProps = {
  children?: ReactNode
  className?: string
  style?: CSSProperties
  ref?: Ref<HTMLDivElement>
  /** Landmark role for the shell's own regions (`navigation`, `complementary`). */
  role?: string
  'aria-label'?: string
}

export function Surface({ children, className = '', style, ref, role, 'aria-label': ariaLabel }: SurfaceProps) {
  return (
    <div ref={ref} role={role} aria-label={ariaLabel} className={`glass ${className}`} style={style}>
      {children}
    </div>
  )
}
