// Last.fm's own scrobble rule, adopted so this ports to the deferred
// Last.fm/ListenBrainz work for free: a play counts once the listener
// reaches 50% of the track's duration or 4 minutes, whichever comes
// first. A track with no known duration (rare — files.duration_ms is
// populated for every parseable file) falls back to the 4-minute floor
// alone, since 50% of "unknown" isn't a real threshold.
const MIN_SCROBBLE_MS = 4 * 60 * 1000;
const SCROBBLE_FRACTION = 0.5;

export function shouldScrobble(msPlayed: number, durationMs: number | null): boolean {
  if (msPlayed <= 0) return false;
  if (durationMs == null || durationMs <= 0) return msPlayed >= MIN_SCROBBLE_MS;
  return msPlayed >= Math.min(durationMs * SCROBBLE_FRACTION, MIN_SCROBBLE_MS);
}
