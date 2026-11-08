import type { Settings } from '../hooks/useSettings'

/* Which kinds of node the map shows, as saved settings. The map options'
 * "show" chips toggle them, and so do the phone's chips over the map
 * (#389). Producers are stored under their older key: hiding them takes
 * them out of the physics as well, which the other three don't. */
export const SHOW = [
  { key: 'showArtists', label: 'artists', defaultOn: true, kind: 'artist' },
  { key: 'showReleases', label: 'albums', defaultOn: true, kind: 'release' },
  { key: 'showTracks', label: 'tracks', defaultOn: true, kind: 'recording' },
  { key: 'showCreditNodes', label: 'producers', defaultOn: false, kind: 'credit' },
] as const

export type ShowKey = (typeof SHOW)[number]['key']

/** A map switch's saved value, or its default before it's ever been set. */
export function isOn(settings: Settings, key: string, defaultOn: boolean): boolean {
  const raw = settings[key]
  return raw == null ? defaultOn : raw === 'true'
}

/** Whether the show switches let the map draw a kind of node (#482).
 * Labels and years have no switch: the map never has a place for them, so
 * they're left off by not being in the graph at all. */
export function mapDraws(settings: Settings, type: string): boolean {
  const show = SHOW.find((item) => item.kind === type)
  return show ? isOn(settings, show.key, show.defaultOn) : true
}
