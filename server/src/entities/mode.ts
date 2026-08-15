// Shared by entities/aggregate.ts (an album's primary artist) and
// entities/collaboration.ts (an album's dominant label) — same "most
// common value, ties broken by lowest id" rule in both places, so pulled
// out once rather than reimplemented twice.
export function pickMode(counts: Map<number, number>): number | null {
  let best: number | null = null;
  let bestCount = 0;
  for (const [id, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      bestCount = count;
      best = id;
    }
  }
  return best;
}
