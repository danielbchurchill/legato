/* Split out of Canvas.tsx so that file stays component-only (mixing a
 * default-exported component with value exports like these breaks Vite fast
 * refresh for the whole file). Shared by Canvas.tsx's G-8 free-canvas math
 * and App.tsx's panel-resize logic — both need the exact same P-8 default,
 * not two copies that could drift.
 *
 * P-8: panel width scales with the window above the 1440px reference, which
 * stays its floor — a 2560-wide window no longer strands a 360px ribbon in
 * a sea of empty canvas. This used to live only in tokens.css's CSS
 * `calc()`; App.tsx needs the same number in JS to know how far a resize
 * drag is allowed to shrink a panel, and Canvas.tsx needs it as the default
 * width of a panel nothing has dragged yet. */
export const PANEL_WIDTH_MIN_PX = 360
export const PANEL_REFERENCE_WIDTH_PX = 1440

export function defaultPanelWidthPx(windowWidthPx: number): number {
  return Math.max(PANEL_WIDTH_MIN_PX, (windowWidthPx * PANEL_WIDTH_MIN_PX) / PANEL_REFERENCE_WIDTH_PX)
}
