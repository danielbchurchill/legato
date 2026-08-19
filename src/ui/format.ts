/* Value formatting shared by every surface that shows library data: the
 * now-playing panel, the node inspector, and the canvas's selected-node card.
 *
 * The em dash is the app's single answer to "there is no value here", already
 * what the metadata panel writes inline for a missing track number. It stays
 * an ink value rather than a muted one: DataRow renders every value in ink,
 * and a lone grey one would read as a different kind of thing rather than as
 * an absent one. */

export const NO_VALUE = '—'

/** m:ss. Used for a single track's length. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return NO_VALUE
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/* A release runs to tens of minutes and a catalogue to hours, so m:ss stops
 * being readable well before either — "45mins" is what the Figma card draws,
 * and 1:07:30 is what an hour-long record needs. Rounded to the minute
 * throughout: nobody reads an album's length to the second. */
export function formatLongDuration(ms: number | null | undefined): string {
  if (ms == null) return NO_VALUE
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}mins`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}hr` : `${hours}hr ${rest}mins`
}
