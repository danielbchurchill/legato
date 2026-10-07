/* LRCLIB's synced lyrics are LRC: one line per lyric, each led by one or
 * more [mm:ss.xx] stamps (a repeated chorus can carry several). This turns
 * that into time-ordered lines so the lyrics tab can mark the one being
 * sung. A blank stamped line is a real pause in the song and is kept, as a
 * gap. Metadata tags ([ar:…], [length:…]) carry no time and are dropped. */

export type LyricLine = { timeMs: number; text: string }

const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g

export function parseSyncedLyrics(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(STAMP)]
    if (stamps.length === 0) continue
    const text = raw.replace(STAMP, '').trim()
    for (const [, mm, ss, frac] of stamps) {
      // A fraction of "5" is half a second, "05" five hundredths, "050"
      // fifty thousandths: pad to three digits before reading it as ms.
      const ms = frac ? Number(frac.padEnd(3, '0')) : 0
      lines.push({ timeMs: Number(mm) * 60_000 + Number(ss) * 1000 + ms, text })
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

/** Index of the line being sung at `positionMs`, or -1 before the first. */
export function currentLyricIndex(lines: readonly LyricLine[], positionMs: number): number {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].timeMs <= positionMs) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}
