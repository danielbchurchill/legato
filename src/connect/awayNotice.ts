/* The away-from-home notice's words and figures (#412), kept apart from
 * drawing it, as unreachable.ts's are, so they can be checked without a DOM.
 * The copy is the Claude Design handoff's (legato-plans
 * design/away-from-home/handoff), word for word. */

/** Standard's bitrate, whichever codec carries it (AAC on an iPhone, Opus
 * in Chrome). */
export const STANDARD_KBPS = 160

/** Under this the notice isn't shown: standard saves too little, and a
 * 128 kbps MP3 uses less than standard does. Twice standard. */
export const NOTICE_MIN_KBPS = 320

/** What a file plays at, as the scan read it: the container music-metadata
 * named, its average bitrate in bits a second, and its sample rate in Hz. */
export type FileFacts = { format: string | null; bitrate: number | null; sampleRate: number | null }

/** A file's average bitrate in kbps, or null when the scan didn't read one. */
export function fileKbps(file: Pick<FileFacts, 'bitrate'>): number | null {
  return file.bitrate != null && file.bitrate > 0 ? file.bitrate / 1000 : null
}

/** About how much an hour at `avgKbps` uses, in decimal MB and GB: the
 * figure ("400 MB") and the same spoken ("400 megabytes").
 *   under 100 MB    to the nearest 1 MB         "72 MB"
 *   100 to 949 MB   to the nearest 50 MB        "400 MB", "550 MB"
 *   950 MB and up   GB to one decimal, no ".0"  "1 GB", "1.3 GB" */
export function perHour(avgKbps: number): { figure: string; spoken: string } {
  // kbps × 1000 / 8 bytes a second × 3600 seconds / 1,000,000 bytes.
  const mb = avgKbps * 0.45
  if (mb < 100) {
    const n = Math.round(mb)
    return { figure: `${n} MB`, spoken: `${n} megabytes` }
  }
  if (mb < 950) {
    const n = Math.round(mb / 50) * 50
    return { figure: `${n} MB`, spoken: `${n} megabytes` }
  }
  const gb = (mb / 1000).toFixed(1).replace(/\.0$/, '')
  return { figure: `${gb} GB`, spoken: `${gb} ${gb === '1' ? 'gigabyte' : 'gigabytes'}` }
}

/** "about 400 MB": the handoff's formatPerHour. */
export function formatPerHour(avgKbps: number): string {
  return `about ${perHour(avgKbps).figure}`
}

type Codec = { name: string; lossless: boolean }

// The codec a container stands for. The scan keeps music-metadata's
// container, not the codec inside it, so an MP4 is told apart by its
// bitrate: AAC never gets near 500 kbps, and ALAC is rarely under it.
function codecOf(format: string, kbps: number | null): Codec {
  const container = format.trim()
  const upper = container.toUpperCase()
  if (upper === 'FLAC') return { name: 'FLAC', lossless: true }
  if (upper === 'WAVE') return { name: 'WAV', lossless: true }
  if (upper.startsWith('AIFF')) return { name: 'AIFF', lossless: true }
  if (upper === "MONKEY'S AUDIO") return { name: 'APE', lossless: true }
  if (upper === 'WAVPACK') return { name: 'WavPack', lossless: true }
  if (upper === 'DSF' || upper.startsWith('DSDIFF')) return { name: 'DSD', lossless: true }
  if (upper === 'MPEG') return { name: 'MP3', lossless: false }
  if (upper.startsWith('ADTS')) return { name: 'AAC', lossless: false }
  if (/^(M4A|M4B|MP4|MP41|MP42|ISOM|ISO2|DASH)\b/.test(upper)) {
    return kbps != null && kbps >= 500 ? { name: 'ALAC', lossless: true } : { name: 'AAC', lossless: false }
  }
  if (upper === 'OGG') return { name: 'Ogg', lossless: false }
  if (upper.startsWith('ASF')) return { name: 'WMA', lossless: false }
  return { name: upper.split('/')[0] || upper, lossless: false }
}

function khz(sampleRate: number): string {
  const value = sampleRate / 1000
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** The playing file's format, as the notice's original row shows it.
 * Lossless: the codec, then the sample rate ("FLAC 44.1 kHz"). Lossy: the
 * codec and bitrate ("MP3 320 kbps"). The handoff's " · 24-bit" is left out:
 * the scan doesn't keep a file's bit depth. */
export function formatFileFormat(file: FileFacts): string {
  return describeFormat(file, 'kHz', 'kbps')
}

/** The same, spelled out for a screen reader: "FLAC 44.1 kilohertz". */
export function spokenFileFormat(file: FileFacts): string {
  return describeFormat(file, 'kilohertz', 'kilobits a second')
}

function describeFormat(file: FileFacts, khzUnit: string, kbpsUnit: string): string {
  const kbps = fileKbps(file)
  if (!file.format) return kbps != null ? `${Math.round(kbps)} ${kbpsUnit}` : ''
  const codec = codecOf(file.format, kbps)
  if (codec.lossless) return file.sampleRate ? `${codec.name} ${khz(file.sampleRate)} ${khzUnit}` : codec.name
  return kbps != null ? `${codec.name} ${Math.round(kbps)} ${kbpsUnit}` : codec.name
}

/** `{server}` in the copy: the server's own name, else "your server". */
export function serverWords(name: string | null | undefined): string {
  return name?.trim() || 'your server'
}

export const NOTICE_TITLE = 'Still streaming originals'
export const noticeBody = (server: string) =>
  `This device is away from home, and ${server} is still sending each track as its original file.`
export const NOTICE_PRIMARY = 'standard while away'
export const NOTICE_SECONDARY = 'keep original'
export const NOTICE_CLOSE = 'Close'

/** What a polite live region says after each choice. Closing without
 * choosing says nothing. */
export const ANNOUNCE_STANDARD = `standard while away is on. The next track streams at ${STANDARD_KBPS} kbps.`
export const ANNOUNCE_KEEP = 'This notice is off. Settings → playback turns it back on.'

/** The notice's two rows, as drawn and as a screen reader hears each. */
export type NoticeRow = {
  label: 'original' | 'standard'
  format: string
  figure: string
  /** "original, FLAC 44.1 kilohertz: about 400 megabytes an hour." */
  spoken: string
  /** How much of the row's width its bar fills, 0 to 1. */
  share: number
}

export function noticeRows(file: FileFacts): NoticeRow[] | null {
  const kbps = fileKbps(file)
  if (kbps == null) return null
  const original = perHour(kbps)
  const standard = perHour(STANDARD_KBPS)
  const format = formatFileFormat(file)
  return [
    {
      label: 'original',
      format,
      figure: original.figure,
      spoken: `original, ${spokenFileFormat(file)}: about ${original.spoken} an hour.`,
      share: 1,
    },
    {
      label: 'standard',
      format: `${STANDARD_KBPS} kbps`,
      figure: standard.figure,
      spoken: `standard, ${STANDARD_KBPS} kilobits a second: about ${standard.spoken} an hour.`,
      share: Math.min(1, STANDARD_KBPS / kbps),
    },
  ]
}
