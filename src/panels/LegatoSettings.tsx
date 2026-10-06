import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { Tabs } from '../ui/Tabs'
import { Select } from '../ui/Select'
import { Kbd } from '../ui/Kbd'
import { Progress } from '../ui/Progress'
import { Skeleton, Shimmer } from '../ui/Skeleton'
import { AlertDialog } from '../ui/Dialog'
import { useToast } from '../ui/toastContext'
import { useWsEvent } from '../hooks/useWs'
import type { Settings } from '../hooks/useSettings'
import type { ThemePreference } from '../hooks/useTheme'
import type { ReplayGainMode } from '../playback/usePlayback'
import { signOut } from '../auth/useAuth'
import { API_BASE as API } from '../config/serverHost'
import { IS_TAURI } from '../config/runtime'
import { FOLDER_PICKER } from '../library/folderPicker'
import { ServerFolderPicker } from '../library/ServerFolderPicker'
import { formatLongDuration } from '../ui/format'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'
import { StreamQualityRow } from './StreamQualityRow'
import { LegatoAccountRow } from './LegatoAccountRow'
import { ServingGroup } from './ServingGroup'
import { deviceForSaved, type AudioDevice } from '../playback/audioDevices'

/* The Legato settings panel — DESIGN.md's "The gpui-kit control set",
 * restyled onto the same GroupHeader/SettingsRow geometry MusicMapSettings.tsx
 * uses. Mounted by App.tsx into InspectorPanel's 'settings' rail destination,
 * replacing the old settings-gear modal (src/settings/SettingsView.tsx) —
 * DESIGN.md used to flag two settings entry points, one real and one
 * placeholder-only, as an open seam; this closes it by giving the real
 * content a home behind the rail's `sliders` destination instead. */

// watch_status/watch_fallback_reason are issue #122's fields — the watcher
// (server/src/scan/watcher.ts) writes them straight onto the row it
// already owns, independent of #123's scan-job/status work landing
// alongside this. 'fallback' means chokidar's watch either errored
// (ENOSPC/EMFILE) or came close to fs.inotify.max_user_watches, and the
// server has switched that root to periodic incremental rescans instead.
type LibraryRoot = {
  id: number
  path: string
  label: string | null
  enabled: number
  watch_status: 'watching' | 'fallback'
  watch_fallback_reason: 'enospc' | 'emfile' | 'near_limit' | null
}

const WATCH_LIMIT_DOCS_URL = 'https://github.com/danielbchurchill/legato/blob/main/docs/watch-limit.md'
type ScanStage = 'discover' | 'read_tags' | 'match' | 'collapse' | 'layout' | 'enrich_queued'
type ScanProgress = {
  jobId: number
  libraryRootId: number
  stage: ScanStage
  stageDone: number
  stageTotal: number | null
  filesScanned: number
  filesTotal: number
  filesAdded: number
  filesUpdated: number
  rate: number | null
  etaSeconds: number | null
}
// A run actively scanning (progress) vs. one a pause request stopped mid-way
// — the same job id, kept visible with a resume affordance rather than
// disappearing the way a genuinely finished run does (issue #123).
type RunningScan = { progress: ScanProgress; paused: boolean }
type ScanFileError = { file_path: string; stage: string; reason: string }

// Issue #123's own wording for the pipeline, reused verbatim as the stage
// list's labels.
const SCAN_STAGE_LABELS: Record<ScanStage, string> = {
  discover: 'discover',
  read_tags: 'read tags',
  match: 'match',
  collapse: 'collapse',
  layout: 'layout',
  enrich_queued: 'enrich queued',
}
const SCAN_STAGES: ScanStage[] = ['discover', 'read_tags', 'match', 'collapse', 'layout', 'enrich_queued']

// H1: "estimating…" rather than a guess — mirrors what RateEstimator itself
// withholds server-side (server/src/scan/rate.ts) until a stage has run long
// enough to trust.
function formatEta(etaSeconds: number | null): string {
  if (etaSeconds === null) return 'estimating…'
  if (etaSeconds < 60) return 'less than a minute left'
  return `${formatLongDuration(etaSeconds * 1000)} left`
}

const REPLAYGAIN_OPTIONS = [
  { value: 'track', label: 'track' },
  { value: 'album', label: 'album' },
  { value: 'off', label: 'off' },
] as const satisfies readonly { value: ReplayGainMode; label: string }[]

// #136: per-device, not per-account — see useTheme.ts. 'system' rather
// than the resolved theme itself is the value this control edits, so
// picking it doesn't need to know or care which way prefers-color-scheme
// currently leans.
const THEME_OPTIONS = [
  { value: 'dark', label: 'dark' },
  { value: 'light', label: 'light' },
  { value: 'system', label: 'system' },
] as const satisfies readonly { value: ThemePreference; label: string }[]

// A keybinding is the answer to the row's own question, so it's ink — in a
// Kbd keycap since the gpui-kit port, still Rubik rather than mono: it's the
// app's own UI, not data off a disk file.
function ShortcutRow({ action, keys }: { action: string; keys: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{action}</span>
      <Kbd>{keys}</Kbd>
    </div>
  )
}

type AccountUser = {
  id: number
  provider: 'local' | 'google' | 'github'
  role: 'owner' | 'legacy'
  email: string | null
  displayName: string | null
  avatarUrl: string | null
}
type MeResponse = { user: AccountUser | null }

// Who this client is signed in as (issue #112). Everything in the app is
// behind the owner gate now (App.tsx's OwnerGated), so this panel is only
// ever seen signed in; the sign-in forms, including the Google/GitHub
// buttons for accounts from before the owner existed, live on the gate
// screen itself (src/auth/OwnerGate.tsx).
function AccountGroup() {
  const [me, setMe] = useState<MeResponse | null>(null)

  useEffect(() => {
    fetch(`${API}/auth/me`)
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ user: null }))
  }, [])

  if (me === null) {
    return (
      <SettingsGroup title="account">
        <Skeleton className="h-[12px] w-[140px] rounded-full" />
      </SettingsGroup>
    )
  }

  const { user } = me
  const name = user?.displayName ?? user?.email ?? (user?.role === 'owner' ? 'owner' : 'signed in')
  return (
    <SettingsGroup title="account">
      <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
        <div className="flex min-w-0 items-center gap-[var(--spacing-sm)]">
          {user?.avatarUrl && <img src={user.avatarUrl} alt="" className="h-[24px] w-[24px] shrink-0 rounded-full" />}
          <div className="min-w-0">
            <p className="truncate text-[length:var(--text-sm)] text-[var(--color-ink)]" title={name}>
              {name}
            </p>
            <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
              {user?.role === 'owner' ? "this server's owner" : `signed in with ${user?.provider ?? 'unknown'}`}
            </p>
          </div>
        </div>
        <Button onClick={() => void signOut()}>sign out</Button>
      </div>
    </SettingsGroup>
  )
}

type LegatoSettingsProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  onSetAudioDevice: (name: string | null) => Promise<void>
  /** #136: deliberately not part of `settings` above — that's the
   * server-backed, per-account store (useSettings.ts), and this preference
   * is per-device (useTheme.ts, localStorage). Threaded down from App.tsx's
   * own useTheme() call rather than this panel calling the hook a second
   * time, so there's exactly one source of truth for the resolved theme. */
  themePreference: ThemePreference
  onSetThemePreference: (preference: ThemePreference) => void
}

export function LegatoSettings({
  settings,
  updateSettings,
  onSetAudioDevice,
  themePreference,
  onSetThemePreference,
}: LegatoSettingsProps) {
  const [roots, setRoots] = useState<LibraryRoot[] | null>(null)
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<number | null>(null)
  const removingRoot = roots?.find((r) => r.id === confirmingRemoveId) ?? null
  const [error, setError] = useState<string | null>(null)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [scanning, setScanning] = useState<Record<number, RunningScan>>({})
  const [scanErrors, setScanErrors] = useState<Record<number, ScanFileError[]>>({})
  // Outside Tauri there's no native output to list, so it starts empty
  // instead of being emptied by the effect below.
  const [devices, setDevices] = useState<AudioDevice[] | null>(IS_TAURI ? null : [])
  const [confirmingRebuild, setConfirmingRebuild] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const toast = useToast()

  const loadRoots = () => {
    fetch(`${API}/library-roots`)
      .then((r) => r.json())
      .then(setRoots)
  }

  useEffect(() => {
    loadRoots()
    if (IS_TAURI) {
      invoke<AudioDevice[]>('list_audio_devices')
        .then(setDevices)
        .catch(() => setDevices([]))
    }
  }, [])

  // Per-file problems the scan noticed and moved past rather than stopping
  // for (H9) — fetched once a run stops (paused, canceled, done, or error),
  // since scan_file_errors isn't itself broadcast live over the socket.
  const loadScanErrors = (jobId: number, libraryRootId: number) => {
    fetch(`${API}/scan-jobs/${jobId}`)
      .then((r) => r.json())
      .then((job: { errors: ScanFileError[] }) => {
        if (job.errors?.length > 0) setScanErrors((s) => ({ ...s, [libraryRootId]: job.errors }))
      })
      .catch(() => undefined)
  }

  useWsEvent(['scan:progress'], (payload) => {
    const p = payload as ScanProgress
    setScanning((s) => ({ ...s, [p.libraryRootId]: { progress: p, paused: false } }))
    // A fresh run's errors, if any, haven't happened yet — last run's list
    // would otherwise sit there looking like it's about this one.
    setScanErrors((s) => {
      if (!(p.libraryRootId in s)) return s
      const next = { ...s }
      delete next[p.libraryRootId]
      return next
    })
  })
  useWsEvent(['scan:paused'], (payload) => {
    const p = payload as { jobId: number; libraryRootId: number }
    setScanning((s) => {
      const existing = s[p.libraryRootId]
      if (!existing) return s
      return { ...s, [p.libraryRootId]: { ...existing, paused: true } }
    })
    loadScanErrors(p.jobId, p.libraryRootId)
  })
  useWsEvent(['scan:done', 'scan:error', 'scan:canceled'], (payload) => {
    const p = payload as { jobId: number | null; libraryRootId: number }
    setScanning((s) => {
      const next = { ...s }
      delete next[p.libraryRootId]
      return next
    })
    if (p.jobId != null) loadScanErrors(p.jobId, p.libraryRootId)
    loadRoots()
  })
  // watch:status (issue #122) fires whenever a root's watcher falls back
  // to polling, or comes back once it's re-watched — a plain "go refetch"
  // is simpler than patching one row in place, and this only fires on a
  // real state change, not on every tick of the fallback timer.
  useWsEvent(['watch:status'], () => loadRoots())

  const pauseScan = (jobId: number) => fetch(`${API}/scan-jobs/${jobId}/pause`, { method: 'POST' })
  const resumeScan = (jobId: number) => fetch(`${API}/scan-jobs/${jobId}/resume`, { method: 'POST' })
  const cancelScan = (jobId: number) => fetch(`${API}/scan-jobs/${jobId}/cancel`, { method: 'POST' })

  // Same choice as LibrarySetup's: the native dialog only when the server
  // is on this machine (issue #121, library/folderPicker.ts).
  const addFolder = async () => {
    setError(null)
    if (FOLDER_PICKER === 'server') {
      setFolderPickerOpen(true)
      return
    }
    const selected = await open({ directory: true, multiple: false })
    if (!selected || Array.isArray(selected)) return
    await addRoot(selected)
  }

  const addRoot = async (selected: string) => {
    const res = await fetch(`${API}/library-roots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selected }),
    })
    if (!res.ok) {
      const body = await res.json()
      setError(body.error ?? `server returned ${res.status}`)
      return
    }
    loadRoots()
  }

  const removeRoot = async (id: number) => {
    setConfirmingRemoveId(null)
    await fetch(`${API}/library-roots/${id}`, { method: 'DELETE' })
    loadRoots()
  }

  const rescanRoot = async (id: number) => {
    await fetch(`${API}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryRootId: id }),
    })
  }

  // Issue #122's manual "check for new music" — the same incremental mode
  // (server/src/scan/scanner.ts) the fallback timer runs on its own every
  // 30 minutes, just triggered on demand for whoever doesn't want to wait.
  // Only offered while a root is actually in fallback: a live watcher
  // already notices new files itself, so the button would have nothing to
  // do for anyone not affected by this.
  const checkForNewMusic = async (id: number) => {
    await fetch(`${API}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryRootId: id, mode: 'incremental' }),
    })
  }

  // #46 — regenerates the whole graph's layout (fresh seed jitter, every
  // manually-placed node's pin cleared) without touching the library on
  // disk. The server broadcasts "layout:rebuilt" when it's done, which is
  // what actually moves the running canvas (App.tsx remounts it) — this
  // just fires the request and clears the local "in progress" state once
  // the response comes back, same division of labor rescanRoot above
  // already has with scan:done.
  //
  // The outcome is a toast (gpui-kit port): the button's own "rebuilding…"
  // shimmer says the work is under way, but once it stops there was nothing
  // saying whether it worked — the canvas remounting behind a panel reads
  // the same as nothing happening.
  const rebuildMap = async () => {
    setConfirmingRebuild(false)
    setRebuilding(true)
    try {
      const res = await fetch(`${API}/layout/rebuild`, { method: 'POST' })
      toast.show(
        res.ok
          ? { title: 'map rebuilt', description: 'every node has a fresh place on the canvas.' }
          : { title: "couldn't rebuild the map", description: `legato-server answered ${res.status}.` },
      )
    } catch {
      toast.show({ title: "couldn't rebuild the map", description: "couldn't reach legato-server." })
    } finally {
      setRebuilding(false)
    }
  }

  // Key/semantics match server/src/enrich/queue.ts's isEnrichmentEnabled —
  // missing the setting entirely means enabled, same default this toggle
  // must preserve rather than invent a second on/off convention.
  const enrichmentEnabled = settings.enrichmentEnabled !== 'false'
  const replaygainMode: ReplayGainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  // A preference saved before device ids is an old name; show it as the
  // device it still resolves to, so the picker and the player agree. Picking
  // again saves the id.
  const audioDevice = deviceForSaved(settings.audioDevice || '', devices ?? [])?.id ?? (settings.audioDevice || '')
  const hoverDimEnabled = settings.hoverDimEnabled !== 'false'
  const reducedMotionForced = settings.reducedMotionForced === 'true'

  return (
    <div className="flex flex-col gap-[var(--spacing-sm)]">
      <SettingsGroup title="appearance">
        <SettingsRow label="theme">
          <Tabs label="theme" options={THEME_OPTIONS} value={themePreference} onChange={onSetThemePreference} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="library"
        action={
          <Button onClick={() => void addFolder()}>+ add folder</Button>
        }
      >
        <ServerFolderPicker
          open={folderPickerOpen}
          onClose={() => setFolderPickerOpen(false)}
          onChoose={(path) => {
            setFolderPickerOpen(false)
            void addRoot(path)
          }}
        />
        {roots === null ? (
          <div className="flex flex-col gap-[var(--spacing-sm)]" aria-label="loading library folders">
            <Skeleton className="h-[12px] w-[200px] rounded-full" />
            <Skeleton className="h-[12px] w-[160px] rounded-full" />
          </div>
        ) : roots.length === 0 ? (
          <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">no folders configured</p>
        ) : (
          <ul className="flex flex-col gap-[var(--spacing-sm)]">
            {roots.map((r) => {
              const run = scanning[r.id]
              const errors = scanErrors[r.id]
              return (
                <li key={r.id} className="flex flex-col gap-[var(--spacing-xs)]">
                  <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
                    <div className="min-w-0">
                      {/* The full path, not the label, in the title: a
                       * label is the short name the user chose, the path is
                       * what's actually cut off and what you'd need to read. */}
                      <p
                        className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] text-[var(--color-ink)]"
                        title={r.path}
                      >
                        {r.label ?? r.path}
                      </p>
                      {run && (
                        <div className="flex flex-col gap-[2px] py-[2px]">
                          {/* Issue #123: discover → read tags → match →
                           * collapse → layout → enrich queued, the current
                           * stage in ink, everything else in control-color —
                           * same active/inactive contrast the theme and
                           * replaygain Tabs above use. */}
                          <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                            {SCAN_STAGES.map((stage, i) => (
                              <span key={stage}>
                                {i > 0 && ' → '}
                                <span
                                  className={
                                    stage === run.progress.stage ? 'text-[var(--color-ink)]' : undefined
                                  }
                                >
                                  {SCAN_STAGE_LABELS[stage]}
                                </span>
                              </span>
                            ))}
                          </p>
                          <div className="flex items-center gap-[var(--spacing-xs)]">
                            <p className="shrink-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                              {run.progress.stageDone}
                              {run.progress.stageTotal != null ? `/${run.progress.stageTotal}` : ''}
                            </p>
                            {/* MO-11: determinate progress is data, not decoration.
                             * A stage with no total yet (discovery walking the
                             * tree) is honestly indeterminate, so it sweeps
                             * rather than sitting at a fake 0%. */}
                            <Progress
                              size="xs"
                              label={`${SCAN_STAGE_LABELS[run.progress.stage]} progress`}
                              value={
                                run.progress.stageTotal
                                  ? (run.progress.stageDone / run.progress.stageTotal) * 100
                                  : undefined
                              }
                              className="flex-1"
                            />
                          </div>
                          <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                            {run.paused
                              ? 'paused'
                              : run.progress.rate != null
                                ? `${Math.round(run.progress.rate)}/s · ${formatEta(run.progress.etaSeconds)}`
                                : formatEta(run.progress.etaSeconds)}
                          </p>
                        </div>
                      )}
                      {/* Issue #122: no red/alert token exists in DESIGN.md's
                       * palette on purpose (see Button.tsx's note on
                       * `destructive`) — muted control-color text, same
                       * shape as this group's own error paragraph below,
                       * carries this the same way. */}
                      {r.watch_status === 'fallback' && (
                        <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                          Watching for changes isn't available on this system, so Legato checks every 30
                          minutes.{' '}
                          <a
                            href={WATCH_LIMIT_DOCS_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--color-ink)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-muted-hi)]"
                          >
                            Raise the limit
                          </a>
                          .
                        </p>
                      )}
                      {!run && errors && errors.length > 0 && (
                        <details className="py-[2px]">
                          {/* H9: per-file problems the scan moved past rather
                           * than stopping for — named with a reason, not just
                           * a count, once expanded. */}
                          <summary className="cursor-pointer text-[length:var(--text-sm)] text-[color:var(--color-control)] hover:text-[var(--color-muted-hi)]">
                            {errors.length} file{errors.length === 1 ? '' : 's'} couldn't be read
                          </summary>
                          <ul className="flex flex-col gap-[2px] pt-[2px]">
                            {errors.map((e, i) => (
                              <li key={i} className="wrap-anywhere text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                                <span className="font-[family-name:var(--font-mono)]">{e.file_path}</span> —{' '}
                                {e.reason}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-[var(--spacing-sm)]">
                      {run ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void (run.paused ? resumeScan(run.progress.jobId) : pauseScan(run.progress.jobId))
                            }
                            aria-label={
                              run.paused
                                ? `Resume scanning ${r.label ?? r.path}`
                                : `Pause scanning ${r.label ?? r.path}`
                            }
                            className="text-[var(--color-control)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                          >
                            <Icon name={run.paused ? 'play' : 'pause'} size={16} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void cancelScan(run.progress.jobId)}
                            aria-label={`Cancel scanning ${r.label ?? r.path}`}
                            className="text-[var(--color-control)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                          >
                            <Icon name="cancel" size={16} />
                          </button>
                        </>
                      ) : (
                        <>
                          {r.watch_status === 'fallback' && (
                            <Button onClick={() => void checkForNewMusic(r.id)}>check for new music</Button>
                          )}
                          <Button onClick={() => void rescanRoot(r.id)}>rescan</Button>
                          <button
                            type="button"
                            onClick={() => setConfirmingRemoveId(r.id)}
                            aria-label={`Remove ${r.label ?? r.path}`}
                            className="text-[var(--color-control)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                          >
                            <Icon name="cancel" size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {/* DESIGN.md's error-state rule is deliberately quiet — Rubik muted,
         * one sentence — not a red/alert color the tokens don't define. */}
        {error && <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{error}</p>}
        {/* Was an inline sentence swapped into the folder's own row; an
         * AlertDialog since the gpui-kit port — removing a watched folder is
         * the kind of question gpui-kit asks in one. The sentence is
         * unchanged. wrap-anywhere is #86's: a path can be one unbroken run
         * (a Windows path's backslashes offer no break), and it only kicks
         * in once normal wrapping at spaces runs out of room. */}
        <AlertDialog
          open={removingRoot != null}
          onCancel={() => setConfirmingRemoveId(null)}
          onConfirm={() => removingRoot && void removeRoot(removingRoot.id)}
          title="remove folder"
          description={
            <p className="wrap-anywhere">
              Remove {removingRoot?.label ?? removingRoot?.path}? Legato stops watching it — already-scanned tracks
              stay in your library.
            </p>
          }
          confirmLabel="remove"
          destructive
        />
      </SettingsGroup>

      <ServingGroup />

      <SettingsGroup title="enrichment">
        <SettingsRow label="lookup">
          <Switch
            checked={enrichmentEnabled}
            onChange={(v) => void updateSettings({ enrichmentEnabled: v ? 'true' : 'false' })}
            accessibilityLabel="look up MusicBrainz metadata and cover art automatically"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="playback">
        <SettingsRow label="gain">
          <Tabs
            label="replaygain"
            options={REPLAYGAIN_OPTIONS}
            value={replaygainMode}
            onChange={(v) => void updateSettings({ replaygainMode: v })}
          />
        </SettingsRow>
        <StreamQualityRow />
        <SettingsRow label="device">
          {IS_TAURI ? (
            <Select
              label="audio output device"
              monospace
              value={audioDevice}
              options={[{ value: '', label: 'system default' }, ...(devices ?? []).map((d) => ({ value: d.id, label: d.label }))]}
              onChange={(value) => {
                const name = value || null
                void updateSettings({ audioDevice: name ?? '' })
                void onSetAudioDevice(name)
              }}
            />
          ) : (
            <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
              Audio device selection is only available in the desktop app.
            </p>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="canvas">
        <SettingsRow label="hover">
          <Switch
            checked={hoverDimEnabled}
            onChange={(v) => void updateSettings({ hoverDimEnabled: v ? 'true' : 'false' })}
            accessibilityLabel="dim other nodes on hover"
          />
        </SettingsRow>
        <SettingsRow label="motion">
          <Switch
            checked={reducedMotionForced}
            onChange={(v) => void updateSettings({ reducedMotionForced: v ? 'true' : 'false' })}
            accessibilityLabel="reduce motion, regardless of system setting"
          />
        </SettingsRow>
        <SettingsRow label="layout" align="start">
          {/* The rebuild confirmation was an inline paragraph in this row;
           * an AlertDialog since the gpui-kit port, same sentence. While it
           * runs, the label shimmers — an indeterminate, often multi-second
           * wait (DESIGN.md Motion, "Indeterminate and long"). */}
          <Button onClick={() => setConfirmingRebuild(true)} disabled={rebuilding}>
            {rebuilding ? <Shimmer>rebuilding…</Shimmer> : 'rebuild map'}
          </Button>
          <AlertDialog
            open={confirmingRebuild}
            onCancel={() => setConfirmingRebuild(false)}
            onConfirm={() => void rebuildMap()}
            title="rebuild the map"
            description="Every node gets freshly placed, including anywhere you've dragged one — that placement is gone. Your library on disk is untouched."
            confirmLabel="rebuild"
            destructive
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="shortcuts">
        <ShortcutRow action="play / pause" keys="space" />
        <ShortcutRow action="focus search" keys="/" />
        <ShortcutRow action="deselect / close" keys="esc" />
      </SettingsGroup>

      <AccountGroup />
      <LegatoAccountRow />
    </div>
  )
}
