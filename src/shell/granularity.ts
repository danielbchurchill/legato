/* Kept out of GraphToggle.tsx so that file exports only its component —
 * mixing constants with components breaks React fast refresh. */

export const GRANULARITIES = ['artists', 'albums', 'tracks'] as const

export type Granularity = (typeof GRANULARITIES)[number]
