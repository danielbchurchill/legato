import type { LyricsData } from './useNodeDetail'

/* The lyrics page's body, and only the body — no header, since the two
 * hosts (NodeDetailPages' pager page, NowPlayingSections' lyrics disclosure)
 * each supply their own title chrome. Presentational only; useLyrics.ts
 * owns the fetch and the MO-11 wait timing this renders. */
type LyricsContentProps = {
  lyrics: LyricsData | 'loading' | null
  lyricsWaitVisible: boolean
  lyricsWaitLong: boolean
}

export function LyricsContent({ lyrics, lyricsWaitVisible, lyricsWaitLong }: LyricsContentProps) {
  if (lyrics === 'loading') {
    if (!lyricsWaitVisible) return null
    return (
      <p
        className={`mt-[8px] text-[length:var(--text-base)] transition-colors duration-[var(--motion-fast)] ${
          lyricsWaitLong ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)]'
        }`}
      >
        loading lyrics…
      </p>
    )
  }
  if (lyrics === null) return null
  if (!lyrics.found) return <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">no lyrics found</p>
  if (lyrics.instrumental) return <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">instrumental</p>
  return (
    <pre className="mt-[8px] whitespace-pre-wrap text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]">
      {lyrics.plainLyrics}
    </pre>
  )
}
