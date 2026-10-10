import type { QualityPreference, StreamQuality } from '../playback/quality'
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

/** One sentence on what the path means. `name` is what the server calls
 * itself, once known. */
export function pathSentence(path: ServerPath, name: string | null): string {
  const server = name ?? 'your server'
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
      return `Connected to ${server} directly, at an address that works away from home too, such as a Tailscale address or a domain.`
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
}

/** The stream quality as a short label and a sentence. `stream` is null in
 * the desktop app, which plays files from disk and streams nothing. */
export function describeQuality(path: ServerPath, stream: StreamFacts | null): { label: string; sentence: string } {
  if (!stream) return { label: 'original', sentence: 'Plays files straight from your library, at their original quality.' }
  const why =
    stream.drops > 0
      ? 'lowered after the connection dropped'
      : stream.preference !== 'auto'
        ? 'as set in Settings'
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
