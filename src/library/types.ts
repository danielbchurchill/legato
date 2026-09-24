/* Mirrors server/src/routes/library.ts's row shapes and sort keys. Kept as
 * a plain duplicate rather than a shared import — the frontend has no
 * existing precedent for importing server/src types (every other panel just
 * shapes its own fetch response inline), and the two are small enough that
 * drifting out of sync would show up immediately as a type error at the one
 * call site that spreads a row's fields. */

export type AlbumRow = {
  id: number
  title: string
  artistId: number | null
  artistName: string | null
  year: number | null
  trackCount: number
  totalDurationMs: number
  dateAdded: string
  coverHash: string | null
}

export type TrackRow = {
  id: number
  title: string
  artistId: number | null
  artistName: string | null
  albumId: number | null
  albumTitle: string | null
  durationMs: number | null
  format: string | null
  dateAdded: string
}

export type AlbumSort = 'artist' | 'title' | 'year' | 'dateAdded' | 'recentlyPlayed'
export type TrackSort = 'title' | 'artist' | 'album' | 'duration' | 'format' | 'dateAdded'
export type SortDir = 'asc' | 'desc'

export const ALBUM_SORT_OPTIONS: { id: AlbumSort; label: string }[] = [
  { id: 'artist', label: 'artist' },
  { id: 'title', label: 'title' },
  { id: 'year', label: 'year' },
  { id: 'dateAdded', label: 'date added' },
  { id: 'recentlyPlayed', label: 'recently played' },
]

export const TRACK_SORT_OPTIONS: { id: TrackSort; label: string }[] = [
  { id: 'title', label: 'title' },
  { id: 'artist', label: 'artist' },
  { id: 'album', label: 'album' },
  { id: 'duration', label: 'duration' },
  { id: 'format', label: 'format' },
  { id: 'dateAdded', label: 'date added' },
]
