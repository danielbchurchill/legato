import { CoverArt } from './CoverArt'

/* A collection's cover: a 2×2 grid of the first four member covers, clipped
 * by the outer radius so the four read as one object. Fewer than four
 * members leave quiet wash cells rather than repeating a cover — repetition
 * would claim the playlist is more uniform than it is.
 *
 * Without a size it fills the box its className gives it, as the phone's
 * collections grid does, and `gap` parts the four cells with whatever is
 * behind showing through, that grid's 2px (#389). */

export function Mosaic({
  nodeIds,
  size,
  radius = 6,
  gap = 0,
  className = '',
}: {
  nodeIds: number[]
  size?: number
  radius?: number
  gap?: number
  className?: string
}) {
  const cells = [0, 1, 2, 3].map((i) => nodeIds[i] ?? null)
  return (
    <div
      aria-hidden="true"
      className={`grid shrink-0 grid-cols-2 grid-rows-2 overflow-hidden shadow-[var(--shadow-art-edge)] ${gap > 0 ? '' : 'bg-[var(--color-wash)]'} ${className}`}
      style={{ width: size, height: size, borderRadius: radius, gap }}
    >
      {cells.map((id, i) =>
        id == null ? (
          <div key={i} className="bg-[var(--color-wash)]" />
        ) : (
          <CoverArt key={i} nodeId={id} size="thumb" radius="none" edge={false} className="size-full" />
        ),
      )}
    </div>
  )
}
