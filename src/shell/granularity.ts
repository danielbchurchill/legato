/* Kept out of GraphToggle.tsx so that file exports only its component —
 * mixing constants with components breaks React fast refresh. Shared by
 * GraphToggle (the active-view pill) and MusicMapSettings (the default-view
 * preference and the per-granularity image toggles), which is why the
 * display-label map lives here rather than duplicated in either. */

export const GRANULARITIES = ['artists', 'albums', 'tracks'] as const

export type Granularity = (typeof GRANULARITIES)[number]

// Display text only — the underlying granularity value stays 'albums'
// (query param, positions.granularity, GRANULARITIES) to avoid a DB/API
// rename; the mockups call this level "releases".
export const GRANULARITY_LABELS: Record<Granularity, string> = {
  artists: 'artists',
  albums: 'releases',
  tracks: 'tracks',
}

// Music Map settings' "nodes > images" toggles — one per granularity,
// keyed into the shared settings store (src/hooks/useSettings.ts). Absence
// means on, matching every other boolean setting's default in this app
// (see SettingsView.tsx's enrichmentEnabled).
export const SHOW_IMAGES_SETTING_KEY: Record<Granularity, string> = {
  artists: 'showImagesArtists',
  albums: 'showImagesAlbums',
  tracks: 'showImagesTracks',
}
