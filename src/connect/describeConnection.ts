import type { QualityPreference, StreamQuality } from '../playback/quality'
import type { Whereabouts } from './awayFromHome'
import type { ServerPath } from './serverPath'

/* What the rail's connection indicator says (issue #118, plan 03's
 * connection-path indicator): the path, why it's that path, and the stream
 * quality. Kept apart from ConnectionIndicator.tsx, as unreachable.ts's
 * words are kept apart from their state, so they can be checked without
 * drawing anything. */

/** The path's name: the tooltip's first half and the popover's heading. */
export const PATH_LABEL: Record<ServerPath, string> = {
  embedded: 'This computer',
  'this-device': 'This computer',
  home: 'Home network',
  relay: 'Through legato.fm',
  custom: 'Custom address',
}

/** What the indicator says in place of the path while the server says this
 * device is away from home (#495). */
export const AWAY_LABEL = 'Away from home'

/** The tooltip's first half and the popover's heading: the path's name, or
 * "Away from home" while the server's answer for this device is `away`
 * (#412, awayFromHome.ts). A Tailscale address counts as the home path
 * (serverPath.ts) wherever the device is, so the answer is what tells a
 * train from the sofa. `home` and `unknown` leave the path's name. Like the
 * quality ladder's standard while away, it doesn't look at the path: the
 * server only says `away` for a device it sees on the tailnet. */
export function placeLabel(path: ServerPath, where: Whereabouts): string {
  return where === 'away' ? AWAY_LABEL : PATH_LABEL[path]
}

/** One sentence on what the path means. `name` is what the server calls
 * itself, once known. While the server's answer is `away` (#495) it says
 * that instead, in the words of the phone's Away from home note (DESIGN.md),
 * since a heading of "Away from home" over "on your home network" would
 * contradict itself. */
export function pathSentence(path: ServerPath, name: string | null, where: Whereabouts = 'unknown'): string {
  const server = name ?? 'your server'
  if (where === 'away') return `Connected to ${server} over Tailscale, from outside your home network.`
  switch (path) {
    case 'embedded':
      return "Connected to Legato's own server, running on this computer."
    case 'this-device':
      return `Connected to ${server} directly, on this computer.`
    case 'home':
      return `Connected to ${server} directly, on your home network.`
    case 'relay':
      return `Connected to ${server} over the internet, through legato.fm's relay.`
    case 'custom':
      return `Connected to ${server} directly, at an address that works away from home too, such as a domain.`
  }
}

// Each quality's codec and bitrate. 'original' has neither: it's the file
// as it is (a FLAC passes through, anything else keeps its own container).
const ENCODED: Record<Exclude<StreamQuality, 'original'>, { codec: string; kbps: number }> = {
  opus96: { codec: 'Opus', kbps: 96 },
  opus160: { codec: 'Opus', kbps: 160 },
  opus256: { codec: 'Opus', kbps: 256 },
  aac160: { codec: 'AAC', kbps: 160 },
  aac256: { codec: 'AAC', kbps: 256 },
}

/** A quality as the tooltip's second half: "original", "Opus 160 kbps". */
export function qualityLabel(quality: StreamQuality): string {
  if (quality === 'original') return 'original'
  const { codec, kbps } = ENCODED[quality]
  return `${codec} ${kbps} kbps`
}

function qualityPhrase(quality: StreamQuality): string {
  if (quality === 'original') return 'at original quality'
  const { codec, kbps } = ENCODED[quality]
  return `as ${codec} at ${kbps} kbps`
}

// Why the ladder starts where it does (quality.ts's DEFAULT_RUNG). This
// computer counts as the home network there.
const DEFAULT_WHERE: Record<ServerPath, string> = {
  embedded: 'on this computer',
  'this-device': 'on this computer',
  home: 'on your home network',
  relay: 'through legato.fm',
  custom: 'for an address away from home',
}

export type StreamFacts = {
  /** What the playing track was asked for, or null with nothing playing. */
  playing: StreamQuality | null
  /** What the next stream will be asked for. */
  next: StreamQuality
  preference: QualityPreference
  /** Rungs given up after drops so far (quality.ts). */
  drops: number
  /** #412's standard while away is what sets the next stream's start
   * (quality.ts awayCapsQuality). */
  awayCapped?: boolean
  /** The server's answer for this device is `away` (#495). With nothing
   * else moving the ladder, the start is the same as at home. */
  away?: boolean
}

/** Why the next stream is standard while this device is away (#412). */
export const AWAY_WHY = 'while this device is away from home, as set in Settings'

/** Why it's the path's default while this device is away and nothing else
 * moved it (#495): "the default on your home network" would say the device
 * is at home. */
export const AWAY_SAME_WHY = 'the same as at home'

/** The stream quality as a short label and a sentence. `stream` is null in
 * the desktop app, which plays files from disk, and streams the original
 * of one that isn't on this computer (#185): `nativeStreaming` says the
 * track playing is one of those. */
export function describeQuality(
  path: ServerPath,
  stream: StreamFacts | null,
  nativeStreaming = false,
): { label: string; sentence: string } {
  if (!stream) {
    return {
      label: 'original',
      sentence: nativeStreaming
        ? "This track streams from the server at its original quality, because its file isn't on this computer."
        : 'Plays files straight from your library, at their original quality.',
    }
  }
  const why =
    stream.drops > 0
      ? 'lowered after the connection dropped'
      : stream.awayCapped
        ? AWAY_WHY
        : stream.preference !== 'auto'
          ? 'as set in Settings'
          : stream.away
            ? AWAY_SAME_WHY
            : `the default ${DEFAULT_WHERE[path]}`
  const { playing, next } = stream
  // A drop or a new pick changes the next track, never the one playing
  // (#120), so the two can differ for a while.
  if (playing && playing !== next) {
    return {
      label: qualityLabel(playing),
      sentence: `This track streams ${qualityPhrase(playing)}. The next one streams ${qualityPhrase(next)}, ${why}.`,
    }
  }
  return { label: qualityLabel(next), sentence: `Streams ${qualityPhrase(next)}, ${why}.` }
}
