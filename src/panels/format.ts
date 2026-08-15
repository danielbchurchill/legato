// Pure formatting helpers for the collection panel's overview stats — split
// out so they're unit-testable without a DOM (root app's first real
// pure-logic test target, per CLAUDE.md: everything before this was a thin
// fetch-wrapper UI).

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function formatDurationHours(ms: number): string {
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.round(ms / 60_000)}m`
  return `~${hours.toFixed(1)}h`
}
