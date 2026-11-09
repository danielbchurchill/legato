import { NOTICE_PRIMARY, NOTICE_SECONDARY, type NoticeRow } from './awayNotice'

/* What the away-from-home notice (#412) says under its body, the same on
 * the phone's sheet and the desktop's dialog: the two rows, original and
 * standard, and the sentence over the buttons. The words are awayNotice.ts's. */

/** The two rows, 12px apart. Each reads "original · FLAC 44.1 kHz" on the
 * left and "about 400 MB an hour" on the right, over a 4px bar: original
 * fills its width, standard its share of it. A screen reader hears each as
 * one sentence with the units spelled out; the bars are hidden from it. */
export function NoticeRows({ rows, id }: { rows: NoticeRow[]; id?: string }) {
  return (
    <div id={id} className="flex flex-col gap-[12px]">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-[6px]">
          <span className="sr-only">{row.spoken}</span>
          {/* 20px, the body's line: Rubik and the mono figure on one
           * baseline would otherwise make the line a pixel taller. */}
          <div aria-hidden="true" className="flex h-[20px] items-baseline justify-between gap-[12px]">
            <span className="flex min-w-0 items-baseline gap-[8px]">
              <span className="text-body font-medium text-[var(--color-ink)]">{row.label}</span>
              <span className="mono truncate text-mono text-[var(--color-ink-2)]">{row.format}</span>
            </span>
            <span className="flex shrink-0 items-baseline gap-[4px] whitespace-nowrap">
              <span className="text-secondary text-[var(--color-ink-2)]">about</span>
              <span className="mono text-heading text-[var(--color-ink)]">{row.figure}</span>
              <span className="text-secondary text-[var(--color-ink-2)]">an hour</span>
            </span>
          </div>
          <div aria-hidden="true" className="h-[4px] overflow-hidden rounded-full bg-[var(--color-wash-2)]">
            <div
              className={`h-full rounded-full ${row.label === 'original' ? 'bg-[var(--color-ink-2)]' : 'bg-[var(--color-accent)]'}`}
              style={{ width: `max(4px, ${row.share * 100}%)` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/** The sentence over the buttons, naming both in ink. */
export function NoticeExplanation() {
  return (
    <p className="text-secondary [text-wrap:pretty] text-[var(--color-ink-2)]">
      <span className="font-medium text-[var(--color-ink)]">{NOTICE_PRIMARY}</span> starts with the next track and changes nothing at home.{' '}
      <span className="font-medium text-[var(--color-ink)]">{NOTICE_SECONDARY}</span> turns this notice off. Settings → playback has both.
    </p>
  )
}

/** A polite live region for what each choice did, outside the shell so the
 * notice's inert never covers it. It's always there, so a message put in it
 * is read out. */
export function NoticeAnnouncer({ message }: { message: string }) {
  return (
    <div aria-live="polite" className="sr-only">
      {message}
    </div>
  )
}
