import { useState } from 'react'
import { useAccount } from '../auth/accountContext'
import { signOut } from '../auth/useAuth'
import { RELAY_SERVER_ID, SERVER_ORIGIN } from '../config/serverHost'
import { neverUseRelay, setNeverUseRelay } from '../connect/connectionPath'
import { readLastSeen } from '../connect/lastSeen'
import { openConnectScreen } from '../connect/openConnect'
import type { Settings } from '../hooks/useSettings'
import type { ThemePreference } from '../hooks/useTheme'
import { useLibraryChanges, useLibraryStats } from '../library/useLibraryChanges'
import { LegatoAccountRow } from '../panels/LegatoAccountRow'
import { useRebuildMap } from '../panels/useRebuildMap'
import { QUALITY_OPTIONS, readQualityPreference, storeQualityPreference } from '../playback/quality'
import { UpdateWording } from '../shell/ServerUpdateNotice'
import { dismissUpdate, useUpdateOffer } from '../shell/serverUpdate'
import { IconButton } from '../ui/IconButton'
import { SectionLabel } from '../ui/SectionLabel'
import { Shimmer } from '../ui/Skeleton'
import { StatusDot } from '../ui/StatusDot'
import { Switch } from '../ui/Switch'
import { Tabs } from '../ui/Tabs'
import { plural } from '../ui/format'
import { useAttention, worstStatus } from './libraryHealth'
import { pushPhonePage } from './navigation'
import { PageGroup, PageRow, RowValue } from './PageGroup'

/* Settings on the phone (#389, Legato Mobile v2's screen 9): a pushed page
 * of grouped cards. Appearance, library and playback are the handoff's;
 * the rest are the desktop Settings panel's groups that mean something on
 * a phone. Left out: the output device, launch at login, keep awake and the
 * tray (the desktop app's own), shortcuts (no keyboard), focus on hover (no
 * hover), volume levelling (only the native player applies ReplayGain), and
 * folder management, which wants a pointer and the server's file system;
 * Library health's Rescan reads the folders again. The handoff's gapless,
 * crossfade, lyrics and "download over cellular" switches have nothing
 * behind them yet, and DESIGN.md rules out a switch that does nothing. */

// The themes' own canvases, as the desktop's theme tiles draw them: a
// preview of paper has to stay paper while the app is in ink.
const THEME_OPTIONS = [
  { value: 'dark', label: 'ink', swatch: '#0f1214' },
  { value: 'light', label: 'paper', swatch: '#ebe6dc' },
  { value: 'system', label: 'system' },
] as const satisfies readonly { value: ThemePreference; label: string; swatch?: string }[]

type SettingsPageProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  themePreference: ThemePreference
  onSetThemePreference: (preference: ThemePreference) => void
}

export function SettingsPage({ settings, updateSettings, themePreference, onSetThemePreference }: SettingsPageProps) {
  const rebuildMap = useRebuildMap()
  // Missing means on, as the server reads it (server/src/enrich/queue.ts).
  const enrichmentEnabled = settings.enrichmentEnabled !== 'false'
  const reducedMotionForced = settings.reducedMotionForced === 'true'

  return (
    <div className="flex flex-col">
      <section className="flex flex-col">
        {/* The first group sits closer under the title. */}
        <SectionLabel className="px-[4px] pt-[8px] pb-[8px]">appearance</SectionLabel>
        <div className="flex flex-col gap-[14px] rounded-[16px] border border-[var(--color-line)] bg-[var(--color-solid)] p-[16px]">
          <Tabs label="Theme" size="xl" options={THEME_OPTIONS} value={themePreference} onChange={onSetThemePreference} />
          <p className="text-[13px] leading-[18px] text-[var(--color-ink-2)]">
            Stored on this device only, so your phone and laptop can differ.
          </p>
        </div>
      </section>

      <PageGroup label="library">
        <SourceRow />
        <UpdateRow />
        <PageRow label="Change server" onClick={() => openConnectScreen()} chevron />
        <HealthRow />
      </PageGroup>

      <PageGroup
        label="playback"
        note="With never use legato.fm on, this device only connects to a server directly. Away from home, a server on your home network is out of reach."
      >
        <QualityRow />
        <NeverRelayRow />
      </PageGroup>

      <PageGroup label="map & motion">
        <PageRow
          label="Reduce motion"
          trailing={
            <Switch
              size="xl"
              checked={reducedMotionForced}
              onChange={(v) => void updateSettings({ reducedMotionForced: v ? 'true' : 'false' })}
              accessibilityLabel="Reduce motion, whatever the system setting"
            />
          }
        />
        <PageRow
          label="Look up metadata online"
          trailing={
            <Switch
              size="xl"
              checked={enrichmentEnabled}
              onChange={(v) => void updateSettings({ enrichmentEnabled: v ? 'true' : 'false' })}
              accessibilityLabel="Look up MusicBrainz metadata and cover art automatically"
            />
          }
        />
        <PageRow
          label={rebuildMap.rebuilding ? <Shimmer>Rebuilding…</Shimmer> : 'Rebuild map layout'}
          onClick={rebuildMap.rebuilding ? undefined : rebuildMap.ask}
          chevron={!rebuildMap.rebuilding}
        />
        {rebuildMap.dialog}
      </PageGroup>

      <AccountGroup />
      <LegatoAccountRow />
    </div>
  )
}

/* The server this device uses: what it calls itself, else its address, and
 * how many tracks it holds. */
function SourceRow() {
  const stats = useLibraryStats(useLibraryChanges())
  const name = readLastSeen(SERVER_ORIGIN)?.name ?? (RELAY_SERVER_ID ? 'legato.fm' : new URL(SERVER_ORIGIN).host)
  return (
    <PageRow
      label="Source"
      trailing={
        <RowValue mono>
          <span className="truncate">{name}</span>
          {stats && <span className="shrink-0">· {plural(stats.tracks, 'track')}</span>}
        </RowValue>
      }
    />
  )
}

/* A newer legato-server release, under the server it's for (#405): the
 * desktop's update pill, which the phone doesn't draw over the map. The
 * same words and dismissal, without the install command, which the phone
 * can't run; the app on the phone updates itself once the server has. */
function UpdateRow() {
  const offer = useUpdateOffer()
  if (!offer) return null
  return (
    <PageRow
      label={<UpdateWording offer={offer} />}
      trailing={
        <IconButton
          icon="cancel"
          label="Dismiss until a newer release"
          size={44}
          iconSize={20}
          tone="ink-3"
          tooltip={false}
          className="-mr-[12px]"
          onClick={() => dismissUpdate(offer.latestVersion)}
        />
      }
    />
  )
}

/* Library health's row: a dot for the worst of what needs attention and how
 * many kinds of it there are, pushing the page that lists them. */
function HealthRow() {
  const { rows } = useAttention()
  return (
    <PageRow
      label="Library health"
      onClick={() => pushPhonePage('health')}
      chevron
      trailing={
        rows && (
          <RowValue>
            <StatusDot status={worstStatus(rows)} />
            {rows.length === 0 ? 'all clear' : plural(rows.length, 'issue')}
          </RowValue>
        )
      }
    />
  )
}

/* The stream quality, as a row naming the choice. The platform's own picker
 * opens from a native select laid over the whole row. Stored per device,
 * so it applies from the next track on this one (playback/quality.ts). */
function QualityRow() {
  const [preference, setPreference] = useState(readQualityPreference)
  const label = QUALITY_OPTIONS.find((option) => option.value === preference)?.label ?? preference
  return (
    <div className="relative has-[select:focus-visible]:outline-3 has-[select:focus-visible]:outline-[color-mix(in_srgb,var(--color-ring)_50%,transparent)]">
      <PageRow
        label="Stream quality"
        chevron
        trailing={
          <RowValue mono>
            <span className="truncate">{label}</span>
          </RowValue>
        }
      />
      <select
        aria-label="Stream quality"
        value={preference}
        onChange={(event) => {
          const value = QUALITY_OPTIONS.find((option) => option.value === event.target.value)?.value
          if (!value) return
          storeQualityPreference(value)
          setPreference(value)
        }}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {QUALITY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/* #118's pin, for this device only. Shown on every phone, unlike the
 * desktop's row: since #365 a page a server served can take its route
 * through legato.fm, and the pin is what stops it (serverHost.ts). */
function NeverRelayRow() {
  const [on, setOn] = useState(neverUseRelay)
  return (
    <PageRow
      label="Never use legato.fm"
      trailing={
        <Switch
          size="xl"
          checked={on}
          onChange={(next) => {
            setNeverUseRelay(next)
            setOn(next)
          }}
          accessibilityLabel="Never connect through legato.fm's relay on this device"
        />
      }
    />
  )
}

/* Who this device is signed in to the server as, and the way out. */
function AccountGroup() {
  const user = useAccount()
  const name = user?.displayName ?? user?.email ?? (user?.role === 'owner' ? 'owner' : 'signed in')
  return (
    <PageGroup label="account">
      <PageRow label={name} detail={user?.role === 'owner' ? "this server's owner" : `signed in with ${user?.provider ?? 'unknown'}`} />
      <PageRow label={<span className="text-[var(--color-accent)]">Sign out</span>} onClick={() => void signOut()} />
    </PageGroup>
  )
}
