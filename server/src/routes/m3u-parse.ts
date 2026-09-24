// Pure parsing for M3U/M3U8 import (#124) — no DB, no matching, so it can
// be unit-tested against fixture text alone. playlist-import.ts is the
// module that actually resolves these entries against the library.

export type M3UEntry = {
  /** 1-based order within the file — playlist_import_entries.position and,
   * for matched entries, the order tracks land in the created playlist. */
  position: number
  /** Exactly as written in the file, before any prefix remap. */
  rawPath: string
  /** Seconds from the preceding #EXTINF line, or null if that line was
   * absent or used the "-1" unknown-duration sentinel — either way there's
   * nothing to match on within ±2s. */
  extinfDurationSeconds: number | null
  /** "Artist" from an "Artist - Title" #EXTINF label, or null if the label
   * had no " - " separator to split on (freeform title, no artist given). */
  extinfArtist: string | null
  extinfTitle: string | null
}

// "#EXTINF:213,Artist Name - Track Title" — duration in seconds (an
// integer; some encoders emit "-1" for "unknown", a handful emit a
// trailing ".0"), then a comma, then a free-text label.
const EXTINF_PATTERN = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*,(.*)$/

// Splits "Artist - Title" on the first " - " only, so a title that itself
// contains " - " (a subtitle, a remix credit — "Song - Radio Edit") doesn't
// get chopped at the wrong dash. Labels with no " - " at all (a bare title,
// which extended M3U doesn't forbid) come back with a null artist rather
// than guessing.
function splitExtinfLabel(label: string): { artist: string | null; title: string | null } {
  const trimmed = label.trim()
  const dashIndex = trimmed.indexOf(' - ')
  if (dashIndex === -1) {
    return { artist: null, title: trimmed || null }
  }
  const artist = trimmed.slice(0, dashIndex).trim()
  const title = trimmed.slice(dashIndex + 3).trim()
  return { artist: artist || null, title: title || null }
}

export function parseM3U(content: string): M3UEntry[] {
  const entries: M3UEntry[] = []
  let pendingDuration: number | null = null
  let pendingArtist: string | null = null
  let pendingTitle: string | null = null

  // Strip a UTF-8 BOM (common in Windows-exported playlists — Windows
  // Media Player and iTunes both write one) so it doesn't end up glued to
  // the first line's "#", which would make "#EXTM3U" fail the '#' check
  // below and read as a path instead.
  const withoutBom = content.replace(/^\uFEFF/, '')
  // CRLF (the overwhelmingly common case for an M3U authored on Windows,
  // which is the whole cross-machine scenario this importer exists for)
  // and bare CR alike, not just LF.
  const lines = withoutBom.split(/\r\n|\r|\n/)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('#')) {
      const match = EXTINF_PATTERN.exec(line)
      if (match) {
        const seconds = Number(match[1])
        pendingDuration = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null
        const split = splitExtinfLabel(match[2])
        pendingArtist = split.artist
        pendingTitle = split.title
      }
      // Every other '#'-prefixed line — #EXTM3U itself, #EXTALB, #EXTGENRE,
      // #PLAYLIST, vendor extensions like #EXT-X-* — is metadata this
      // importer doesn't use yet. Skipped, not an error: an M3U with
      // directives this parser has never heard of is still a valid M3U.
      continue
    }

    entries.push({
      position: entries.length + 1,
      rawPath: line,
      extinfDurationSeconds: pendingDuration,
      extinfArtist: pendingArtist,
      extinfTitle: pendingTitle,
    })
    pendingDuration = null
    pendingArtist = null
    pendingTitle = null
  }

  return entries
}

// Windows paths ("D:\Music\Artist\Track.mp3") never legally contain a
// forward slash, and POSIX paths ("/Volumes/Music/...") never legally
// contain a backslash, so swapping every backslash for a forward slash is
// lossless for either style and puts both on the one separator every
// comparison below actually needs.
export function normalizeSeparators(rawPath: string): string {
  return rawPath.replace(/\\/g, '/')
}

// Longest common prefix of a set of (already-normalized) paths, trimmed
// back to the last '/' so the result names a whole directory rather than a
// truncated file or folder name — two paths sharing "Artist" up to
// "ArtistB"/"ArtistC" should suggest replacing their shared *directory*,
// not the string "Artist" itself. Empty input, or paths sharing no prefix
// at all, both return "".
export function longestCommonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return ''
  let prefix = paths[0]
  for (const candidate of paths.slice(1)) {
    let i = 0
    const max = Math.min(prefix.length, candidate.length)
    while (i < max && prefix[i] === candidate[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) return ''
  }
  const lastSlash = prefix.lastIndexOf('/')
  return lastSlash === -1 ? '' : prefix.slice(0, lastSlash + 1)
}
