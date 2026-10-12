import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { popPhonePage, usePhonePages, type PhonePage } from './navigation'
import type { PhonePlatform } from './phoneLayout'

/* Pushed pages on the phone (#389): full screen and opaque over the map,
 * with the platform's own top bar. iOS has a 44px bar with the back label
 * in the accent, and Settings its 34/600 large title under it. Android has
 * a 64px app bar with its back button and a 22/500 title. Back pops the
 * page, as the system's back does (navigation.ts).
 *
 * Settings and Library health are built in a later step (#389, step 6).
 * Until then each page is its title over the desktop panel's own content,
 * as the sheet's tabs show theirs, so nothing the desktop reaches is out of
 * reach on a phone. */

const PAGE_TITLE: Record<PhonePage, string> = {
  settings: 'Settings',
  health: 'Library health',
}

type PhonePagesProps = {
  platform: PhonePlatform
  content: Record<PhonePage, ReactNode>
}

export function PhonePages({ platform, content }: PhonePagesProps) {
  const pages = usePhonePages()
  const page = pages[pages.length - 1]
  if (page == null) return null
  const back = pages.length > 1 ? PAGE_TITLE[pages[pages.length - 2]] : 'Map'
  return (
    <PageFrame key={pages.length} page={page} platform={platform} back={back}>
      {content[page]}
    </PageFrame>
  )
}

function PageFrame({ page, platform, back, children }: { page: PhonePage; platform: PhonePlatform; back: string; children: ReactNode }) {
  const title = PAGE_TITLE[page]
  const ref = useRef<HTMLElement>(null)
  const ios = platform === 'ios'
  // A new page takes the focus, so a screen reader starts there.
  useEffect(() => ref.current?.focus(), [])

  return (
    <section ref={ref} tabIndex={-1} aria-label={title} className="absolute inset-0 z-30 bg-[var(--color-canvas)] outline-none">
      {ios ? (
        <header className="absolute inset-x-0 top-[env(safe-area-inset-top)] grid h-[44px] grid-cols-[1fr_auto_1fr] items-center px-[8px]">
          <button
            type="button"
            aria-label={`Back to ${back}`}
            onClick={popPhonePage}
            className="flex h-[44px] items-center gap-[2px] justify-self-start rounded-[10px] pr-[8px] text-[17px] text-[var(--color-accent)]"
          >
            <span className="inline-flex rotate-90">
              <Icon name="chevron-down" size={26} />
            </span>
            {back}
          </button>
          {/* Settings' title is the large one under the bar. */}
          {page !== 'settings' && <h1 className="text-[17px] font-semibold text-[var(--color-ink)]">{title}</h1>}
        </header>
      ) : (
        <header className="absolute inset-x-0 top-[env(safe-area-inset-top)] flex h-[64px] items-center gap-[8px] px-[8px]">
          <button
            type="button"
            aria-label={`Back to ${back}`}
            onClick={popPhonePage}
            className="grid size-[48px] place-items-center rounded-full text-[var(--color-ink)]"
          >
            <span className="inline-flex rotate-90">
              <Icon name="chevron-down" size={24} />
            </span>
          </button>
          <h1 className="text-[22px] leading-[28px] font-medium text-[var(--color-ink)]">{title}</h1>
        </header>
      )}
      <div
        className={`absolute inset-x-0 bottom-0 overflow-y-auto overscroll-contain px-[16px] pb-[calc(env(safe-area-inset-bottom)+20px)] ${
          ios ? 'top-[calc(env(safe-area-inset-top)+44px)]' : 'top-[calc(env(safe-area-inset-top)+64px)]'
        }`}
      >
        {ios && page === 'settings' && (
          <h1 className="px-[4px] pb-[12px] text-[34px] leading-[41px] font-semibold text-[var(--color-ink)]">{title}</h1>
        )}
        {children}
      </div>
    </section>
  )
}
