// What a row in plays stands for, in one place (#133).
//
// Since migration 0056 a row is one of two things:
//   - a play Legato recorded (routes/plays.ts): play_count 1, started_at
//     when it began;
//   - one track's total imported from Apple Music (applemusic/import.ts):
//     source 'apple-music', play_count Music's total, started_at Music's
//     "Play Date UTC", or '' when Music had a count but no date.
//
// So nothing counts rows. Every query that reads plays builds its count,
// its time and its window from these fragments, and playCounts.spec.ts
// fails on a query in server/src that counts plays' rows or reads
// started_at bare. Each takes the table's alias in the query, if it has
// one.

/** The sources whose rows are totals rather than single plays. */
export const IMPORTED_PLAY_SOURCES = ["apple-music"] as const;
export type ImportedPlaySource = (typeof IMPORTED_PLAY_SOURCES)[number];

function column(alias: string | undefined, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

/** How many plays a group of rows stands for. Imported totals count in
 *  full: they're what "most played" and "top artist" mean. */
export function playTotal(alias?: string): string {
  return `SUM(${column(alias, "play_count")})`;
}

/** When a row's play was, or NULL when nobody knows: an imported total
 *  that Music had no play date for. Its MAX is when a track was last
 *  played, so an undated total never sorts as recently played. */
export function playedAt(alias?: string): string {
  return `NULLIF(${column(alias, "started_at")}, '')`;
}

/** A row that is one play at a known time. Anything counted inside a window
 *  ("on repeat": plays in the last 30 days) takes only these: an imported
 *  total's plays happened at times nobody knows, so a total whose last play
 *  fell inside the window can't say how many others did. */
export function singlePlay(alias?: string): string {
  return `${column(alias, "source")} NOT IN (${IMPORTED_PLAY_SOURCES.map((s) => `'${s}'`).join(", ")})`;
}
