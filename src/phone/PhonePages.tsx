import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Settings } from '../hooks/useSettings'
import type { ThemePreference } from '../hooks/useTheme'
import type { GapField } from '../panels/healthData'
import { Worklist } from '../panels/Worklists'
import { Icon } from '../ui/Icon'
import { TouchLayoutContext } from '../ui/touchLayout'
import { HealthPage } from './HealthPage'
import { SettingsPage } from './SettingsPage'
import { closePhonePages, popPhonePage, pushPhonePage, usePhonePages, worklistOf, type PhonePage } from './navigation'
import type { PhonePlatform } from './phoneLayout'

/* Pushed pages on the phone (#389): full screen and opaque over the map,
 * with the platform's own top bar. iOS has a 44px bar with the back label
 * in the accent, and Settings its 34/600 large title under it. Android has
 * a 64px app bar with its back arrow and a 22/500 title. Back pops the
 * page, as the system's back does (navigation.ts).
 *
 * Settings pushes from the button over the map, Library health from
 * Settings, and each of health's lists from health, as the desktop's
 * worklists open from its panel. Inside a page the layout is for a finger
 * (TouchLayoutContext): the desktop controls a page borrows, its worklists
 * and the legato.fm account group, take 44px targets there. */

/* Now playing draws itself (NowPlayingScreen.tsx); these are the rest. */
type PushedPage = Exclude<PhonePage, 'now-playing'>

const PAGE_TITLE: Record<PushedPage, string> = {
  settings: 'Settings',
  health: 'Library health',
  'worklist:duplicates': 'Possible duplicates',
  'worklist:missing': 'Missing files',
  'worklist:enrichment': 'Enrichment to confirm',
  'worklist:tag-writes': 'Tag writes',
  'worklist:gaps': 'Metadata gaps',
}

type PhonePagesProps = {
  platform: PhonePlatform
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  themePreference: ThemePreference
  onSetThemePreference: (preference: ThemePreference) => void
  /** Select a node and show it on the map. */
  onShowOnMap: (id: number) => void
}

export function PhonePages({ platform, settings, updateSettings, themePreference, onSetThemePreference, onShowOnMap }: PhonePagesProps) {
  const pages = usePhonePages()
  // Which field the gaps list shows. Kept here, under the pages, so it
  // survives the list being popped and pushed again, as the desktop's does.
  const [gapField, setGapField] = useState<GapField>('unmatched')
  const page = pages[pages.length - 1]
  if (page == null || page === 'now-playing') return null
  const below = pages[pages.length - 2]
  const back = below == null || below === 'now-playing' ? 'Map' : PAGE_TITLE[below]

  // Anything a list opens on the map shows the map: every page closes.
  const showOnMap = (id: number) => {
    closePhonePages()
    onShowOnMap(id)
  }

  const worklist = worklistOf(page)
  let content: ReactNode
  if (worklist) {
    content = (
      <div className="pt-[8px]">
        <Worklist kind={worklist} gapField={gapField} onGapFieldChange={setGapField} onFocusNode={showOnMap} />
      </div>
    )
  } else if (page === 'settings') {
    content = (
      <SettingsPage
        settings={settings}
        updateSettings={updateSettings}
        themePreference={themePreference}
        onSetThemePreference={onSetThemePreference}
      />
    )
  } else {
    content = (
      <HealthPage
        onOpen={(list, field) => {
          if (field) setGapField(field)
          pushPhonePage(`worklist:${list}`)
        }}
      />
    )
  }

  return (
    <PageFrame key={pages.length} page={page} platform={platform} back={back}>
      {content}
    </PageFrame>
  )
}

function PageFrame({ page, platform, back, children }: { page: PushedPage; platform: PhonePlatform; back: string; children: ReactNode }) {
  const title = PAGE_TITLE[page]
  const ref = useRef<HTMLElement>(null)
  const ios = platform === 'ios'
  // A new page takes the focus, so a screen reader starts there.
  useEffect(() => ref.current?.focus(), [])

  // iOS says "Back" when the previous page's title doesn't fit beside this
  // one's, rather than cutting it short. Its accessible name keeps it.
  const backLabel = useRef<HTMLSpanElement>(null)
  const [backFits, setBackFits] = useState(true)
  useLayoutEffect(() => {
    const label = backLabel.current
    if (label && label.scrollWidth > label.clientWidth) setBackFits(false)
  }, [])

  return (
    <section ref={ref} tabIndex={-1} aria-label={title} className="absolute inset-0 z-30 bg-[var(--color-canvas)] outline-none">
      {ios ? (
        <header className="absolute inset-x-0 top-[env(safe-area-inset-top)] grid h-[44px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-[8px]">
          <button
            type="button"
            aria-label={`Back to ${back}`}
            onClick={popPhonePage}
            className="flex h-[44px] max-w-full min-w-0 items-center gap-[2px] justify-self-start rounded-[10px] pr-[8px] text-[17px] text-[var(--color-accent)]"
          >
            <span className="inline-flex shrink-0 rotate-90">
              <Icon name="chevron-down" size={26} />
            </span>
            <span ref={backLabel} className="truncate">
              {backFits ? back : 'Back'}
            </span>
          </button>
          {/* Settings' title is the large one under the bar. */}
          {page !== 'settings' && (
            <h1 className="max-w-[calc(100vw-112px)] truncate text-[17px] font-semibold text-[var(--color-ink)]">{title}</h1>
          )}
        </header>
      ) : (
        <header className="absolute inset-x-0 top-[env(safe-area-inset-top)] flex h-[64px] items-center gap-[8px] px-[8px]">
          <button
            type="button"
            aria-label={`Back to ${back}`}
            onClick={popPhonePage}
            className="grid size-[48px] shrink-0 place-items-center rounded-full text-[var(--color-ink)]"
          >
            <Icon name="arrow-left" size={24} />
          </button>
          <h1 className="truncate text-[22px] leading-[28px] font-medium text-[var(--color-ink)]">{title}</h1>
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
        <TouchLayoutContext.Provider value={true}>{children}</TouchLayoutContext.Provider>
      </div>
    </section>
  )
}
