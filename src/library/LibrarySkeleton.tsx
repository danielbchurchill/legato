import { Skeleton } from '../ui/Skeleton'

/* Loading: placeholders in the grid's exact shape — cover, title line,
 * artist line — so nothing jumps when the albums land. They fade from full
 * to a quarter across the twelve, so the block reads as "more below" rather
 * than as a wall. Breathing opacity only, never a travelling shimmer
 * (DESIGN.md Motion). */
export function GridSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading albums"
      className="mt-[28px] grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-[24px] gap-y-[28px]"
    >
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex flex-col gap-[10px]" style={{ opacity: Math.max(0.25, 1 - i * 0.07) }}>
          <Skeleton className="aspect-square w-full rounded-[var(--radius-art)]" />
          <Skeleton className="h-[12px] w-[72%] rounded-[6px]" />
          <Skeleton tone="faint" className="h-[10px] w-[48%] rounded-[6px]" />
        </div>
      ))}
    </div>
  )
}

export function RowsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading tracks" className="flex flex-col">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex h-[48px] items-center gap-[14px] px-[12px]" style={{ opacity: Math.max(0.25, 1 - i * 0.07) }}>
          <Skeleton tone="faint" className="h-[10px] w-[24px] rounded-[4px]" />
          <Skeleton className="size-[36px] rounded-[var(--radius-art-sm)]" />
          <Skeleton className="h-[12px] w-[30%] rounded-[6px]" />
          <Skeleton tone="faint" className="h-[10px] w-[18%] rounded-[6px]" />
        </div>
      ))}
    </div>
  )
}
