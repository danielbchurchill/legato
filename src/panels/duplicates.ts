import { formatBitrate, formatBytes, formatFormat } from './format'

/* Library health's possible duplicates (#469): what the card says about
 * each side of a pair, and which file a merge would play. */

/* Mirrors server/src/hygiene.ts's DuplicatePair. */
export type DuplicateFile = {
  id: number
  path: string
  format: string | null
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  size: number
  missing: boolean
}
export type DuplicatePair = {
  file: DuplicateFile
  candidate: DuplicateFile[]
  playsAfterMerge: number | null
  reason: 'bitrate' | 'first' | 'only' | null
}

/** "44.1 kHz", "96 kHz". */
export function formatSampleRate(hz: number | null): string | null {
  if (!hz) return null
  const khz = hz / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

/** A file's facts: format, bitrate, sample rate, bit depth where it has
 * one, and size. */
export function fileFactList(file: DuplicateFile): string[] {
  return [
    formatFormat(file.format),
    formatBitrate(file.bitrate),
    formatSampleRate(file.sampleRate),
    file.bitDepth ? `${file.bitDepth}-bit` : null,
    formatBytes(file.size),
  ].filter((fact): fact is string => fact != null)
}

/** The same facts on one line. */
export function fileFacts(file: DuplicateFile): string {
  return fileFactList(file).join(' · ')
}

/** The sentence under a pair that says which file plays after a merge, by
 * the server's rule (server/src/playbackFile.ts). */
export function playsAfterMergeLine(pair: DuplicatePair): string {
  const winner = pair.playsAfterMerge
  if (winner == null) return 'Neither file is on disk right now, so nothing plays until one is back.'
  const side = winner === pair.file.id ? 'left' : 'right'
  const format = formatFormat([pair.file, ...pair.candidate].find((f) => f.id === winner)?.format)
  const which = `the ${format ? `${format} ` : ''}file on the ${side}`
  if (pair.reason === 'only') return `After a merge the track plays ${which}, the only one on disk.`
  if (pair.reason === 'first') return `After a merge the track plays ${which}: the bitrates match, so it's the one Legato found first.`
  return `After a merge the track plays ${which}, which has the higher bitrate.`
}
