import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { useWsEvent } from '../hooks/useWs'
import type { Settings } from '../hooks/useSettings'
import type { ReplayGainMode } from '../playback/usePlayback'
import { SERVER_HOST } from '../config/serverHost'
import { IS_TAURI } from '../config/runtime'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* The Legato settings panel — DESIGN.md's "v2: settings primitives",
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
type ScanProgress = {
  jobId: number
  libraryRootId: number
  filesScanned: number
  filesTotal: number
  filesAdded: number
  filesUpdated: number
}

const REPLAYGAIN_OPTIONS = [
  { value: 'track', label: 'track' },
  { value: 'album', label: 'album' },
  { value: 'off', label: 'off' },
] as const satisfies readonly { value: ReplayGainMode; label: string }[]

/* A row-scale tab group — the settings-primitive family (Toggle/Slider) is
 * all binary or continuous; replaygain's three-way choice doesn't reduce to
 * either, so this borrows the old modal's tablist shape but at the same
 * --text-sm/--color-control scale as everything else in a SettingsRow. */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div role="tablist" className="flex gap-[var(--spacing-sm)]">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`text-[length:var(--text-sm)] transition-colors duration-150 ${
              active ? 'text-[var(--color-ink)]' : 'text-[var(--color-control)] hover:text-[var(--color-muted-hi)]'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// Same shape as MusicMapSettings.tsx's DataRow-adjacent rows: real data
// (a keybinding) gets Rubik ink, not mono — it's the answer to the row's own
// question rather than a value describing something else.
function ShortcutRow({ action, keys }: { action: string; keys: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{action}</span>
      <span className="text-[length:var(--text-sm)] text-[var(--color-ink)]">{keys}</span>
    </div>
  )
}

type AccountUser = {
  id: number
  provider: 'google' | 'github'
  email: string | null
  displayName: string | null
  avatarUrl: string | null
}
type MeResponse = { user: AccountUser | null; configured: { google: boolean; github: boolean } }

// Rough OAuth account provisioning (server/src/routes/auth.ts) — this is
// provisioning plumbing, not a login wall: every other panel in the app
// works identically whether or not anyone has ever signed in here.
// "Sign in with..." opens the provider flow in its own window rather than
// navigating this one away, since there's no fixed frontend origin the
// server's callback page could redirect back into (Vite dev port, a Tauri
// bundle, a future remote client). Refreshing on window focus is how this
// panel notices a sign-in completed in that other window.
function AccountGroup() {
  const [me, setMe] = useState<MeResponse | null>(null)

  const loadMe = () => {
    fetch(`${API}/auth/me`, { credentials: 'include' })
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ user: null, configured: { google: false, github: false } }))
  }

  useEffect(() => {
    loadMe()
    window.addEventListener('focus', loadMe)
    return () => window.removeEventListener('focus', loadMe)
  }, [])

  const signOut = async () => {
    await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include' })
    loadMe()
  }

  if (me === null) {
    return (
      <SettingsGroup title="account">
        <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">loading…</p>
      </SettingsGroup>
    )
  }

  if (me.user) {
    const { user } = me
    return (
      <SettingsGroup title="account">
        <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
          <div className="flex min-w-0 items-center gap-[var(--spacing-sm)]">
            {user.avatarUrl && <img src={user.avatarUrl} alt="" className="h-[24px] w-[24px] shrink-0 rounded-full" />}
            <div className="min-w-0">
              <p className="truncate text-[length:var(--text-sm)] text-[var(--color-ink)]">
                {user.displayName ?? user.email ?? 'signed in'}
              </p>
              <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                signed in with {user.provider}
              </p>
            </div>
          </div>
          <Button onClick={() => void signOut()}>sign out</Button>
        </div>
      </SettingsGroup>
    )
  }

  if (!me.configured.google && !me.configured.github) {
    return (
      <SettingsGroup title="account">
        <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
          OAuth isn't configured on this server.
        </p>
      </SettingsGroup>
    )
  }

  return (
    <SettingsGroup title="account">
      <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">not signed in</p>
      <div className="flex items-center gap-[var(--spacing-sm)]">
        {me.configured.google && (
          <Button onClick={() => window.open(`${API}/auth/google`, '_blank')}>sign in with google</Button>
        )}
        {me.configured.github && (
          <Button onClick={() => window.open(`${API}/auth/github`, '_blank')}>sign in with github</Button>
        )}
      </div>
    </SettingsGroup>
  )
}

type LegatoSettingsProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  onSetAudioDevice: (name: string | null) => Promise<void>
}

export function LegatoSettings({ settings, updateSettings, onSetAudioDevice }: LegatoSettingsProps) {
  const [roots, setRoots] = useState<LibraryRoot[] | null>(null)
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState<Record<number, ScanProgress>>({})
  const [devices, setDevices] = useState<string[] | null>(null)
  const [confirmingRebuild, setConfirmingRebuild] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)

  const loadRoots = () => {
    fetch(`${API}/library-roots`)
      .then((r) => r.json())
      .then(setRoots)
  }

  useEffect(() => {
    loadRoots()
    if (IS_TAURI) {
      invoke<string[]>('list_audio_devices')
        .then(setDevices)
        .catch(() => setDevices([]))
    } else {
      setDevices([])
    }
  }, [])

  useWsEvent(['scan:progress'], (payload) => {
    const p = payload as ScanProgress
    setScanning((s) => ({ ...s, [p.libraryRootId]: p }))
  })
  useWsEvent(['scan:done', 'scan:error'], (payload) => {
    const p = payload as { libraryRootId: number }
    setScanning((s) => {
      const next = { ...s }
      delete next[p.libraryRootId]
      return next
    })
    loadRoots()
  })
  // watch:status (issue #122) fires whenever a root's watcher falls back
  // to polling, or comes back once it's re-watched — a plain "go refetch"
  // is simpler than patching one row in place, and this only fires on a
  // real state change, not on every tick of the fallback timer.
  useWsEvent(['watch:status'], () => loadRoots())

  const addFolder = async () => {
    if (!IS_TAURI) return
    setError(null)
    const selected = await open({ directory: true, multiple: false })
    if (!selected || Array.isArray(selected)) return
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
  const rebuildMap = async () => {
    setConfirmingRebuild(false)
    setRebuilding(true)
    try {
      await fetch(`${API}/layout/rebuild`, { method: 'POST' })
    } finally {
      setRebuilding(false)
    }
  }

  // Key/semantics match server/src/enrich/queue.ts's isEnrichmentEnabled —
  // missing the setting entirely means enabled, same default this toggle
  // must preserve rather than invent a second on/off convention.
  const enrichmentEnabled = settings.enrichmentEnabled !== 'false'
  const replaygainMode: ReplayGainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  const audioDevice = settings.audioDevice || ''
  const hoverDimEnabled = settings.hoverDimEnabled !== 'false'
  const reducedMotionForced = settings.reducedMotionForced === 'true'

  return (
    <div className="flex flex-col gap-[var(--spacing-sm)]">
      <SettingsGroup
        title="library"
        action={
          <Button onClick={() => void addFolder()} disabled={!IS_TAURI}>
            + add folder
          </Button>
        }
      >
        {!IS_TAURI && (
          <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
            Adding a library folder needs the desktop app — this preview reads whatever's already configured.
          </p>
        )}
        {roots === null ? (
          <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">loading…</p>
        ) : roots.length === 0 ? (
          <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">no folders configured</p>
        ) : (
          <ul className="flex flex-col gap-[var(--spacing-sm)]">
            {roots.map((r) => {
              const progress = scanning[r.id]
              const confirming = confirmingRemoveId === r.id
              return (
                <li key={r.id} className="flex flex-col gap-[var(--spacing-xs)]">
                  {confirming ? (
                    <>
                      {/* #86: the non-confirming row below (r.label ?? r.path,
                       * same fallback) truncates to one line on purpose — this
                       * sentence is meant to wrap instead, but a real
                       * filesystem path or a user-typed label can still be one
                       * unbroken run with nowhere to break, e.g. a Windows
                       * path's backslashes carry no browser line-break
                       * opportunity the way "/" does. wrap-anywhere only
                       * kicks in once normal wrapping runs out of room, so
                       * "Legato stops watching it" still breaks at spaces
                       * first. */}
                      <p className="wrap-anywhere text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                        Remove {r.label ?? r.path}? Legato stops watching it — already-scanned tracks stay in your
                        library.
                      </p>
                      <div className="flex items-center gap-[var(--spacing-sm)]">
                        <Button variant="destructive" onClick={() => void removeRoot(r.id)}>
                          remove
                        </Button>
                        <button
                          type="button"
                          onClick={() => setConfirmingRemoveId(null)}
                          className="text-[length:var(--text-sm)] text-[color:var(--color-control)] hover:text-[var(--color-muted-hi)]"
                        >
                          cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
                      <div className="min-w-0">
                        <p className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] text-[var(--color-ink)]">
                          {r.label ?? r.path}
                        </p>
                        {progress && (
                          <div className="flex items-center gap-[var(--spacing-xs)] py-[2px]">
                            <p className="shrink-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                              {progress.filesScanned}/{progress.filesTotal}
                            </p>
                            {/* MO-11: determinate progress is data, not decoration — stepped
                             * not eased, same as MusicMapSettings' peers respect for live data. */}
                            <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-[var(--color-divider)]">
                              <div
                                className="h-full rounded-full bg-[var(--color-signal)]"
                                style={{
                                  width: `${progress.filesTotal > 0 ? Math.min(100, (progress.filesScanned / progress.filesTotal) * 100) : 0}%`,
                                }}
                              />
                            </div>
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
                      </div>
                      <div className="flex shrink-0 items-center gap-[var(--spacing-sm)]">
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
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {/* DESIGN.md's error-state rule is deliberately quiet — Rubik muted,
         * one sentence — not a red/alert color the tokens don't define. */}
        {error && <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{error}</p>}
      </SettingsGroup>

      <SettingsGroup title="enrichment">
        <SettingsRow label="lookup">
          <Toggle
            checked={enrichmentEnabled}
            onChange={(v) => void updateSettings({ enrichmentEnabled: v ? 'true' : 'false' })}
            label="look up MusicBrainz metadata and cover art automatically"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="playback">
        <SettingsRow label="gain">
          <SegmentedControl
            options={REPLAYGAIN_OPTIONS}
            value={replaygainMode}
            onChange={(v) => void updateSettings({ replaygainMode: v })}
          />
        </SettingsRow>
        <SettingsRow label="device">
          {IS_TAURI ? (
            <select
              value={audioDevice}
              onChange={(e) => {
                const name = e.target.value || null
                void updateSettings({ audioDevice: name ?? '' })
                void onSetAudioDevice(name)
              }}
              className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] text-[var(--color-ink)] outline-none [&>option]:bg-[var(--color-canvas)]"
            >
              <option value="">system default</option>
              {(devices ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
              Audio device selection is only available in the desktop app.
            </p>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="canvas">
        <SettingsRow label="hover">
          <Toggle
            checked={hoverDimEnabled}
            onChange={(v) => void updateSettings({ hoverDimEnabled: v ? 'true' : 'false' })}
            label="dim other nodes on hover"
          />
        </SettingsRow>
        <SettingsRow label="motion">
          <Toggle
            checked={reducedMotionForced}
            onChange={(v) => void updateSettings({ reducedMotionForced: v ? 'true' : 'false' })}
            label="reduce motion, regardless of system setting"
          />
        </SettingsRow>
        <SettingsRow label="layout" align="start">
          {confirmingRebuild ? (
            <div className="flex flex-col gap-[var(--spacing-xs)]">
              <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                Rebuild the map? Every node gets freshly placed, including anywhere you've dragged one — that
                placement is gone. Your library on disk is untouched.
              </p>
              <div className="flex items-center gap-[var(--spacing-sm)]">
                <Button variant="destructive" onClick={() => void rebuildMap()}>
                  rebuild
                </Button>
                <button
                  type="button"
                  onClick={() => setConfirmingRebuild(false)}
                  className="text-[length:var(--text-sm)] text-[color:var(--color-control)] hover:text-[var(--color-muted-hi)]"
                >
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setConfirmingRebuild(true)} disabled={rebuilding}>
              {rebuilding ? 'rebuilding…' : 'rebuild map'}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="shortcuts">
        <ShortcutRow action="play / pause" keys="space" />
        <ShortcutRow action="focus search" keys="/" />
        <ShortcutRow action="deselect / close" keys="esc" />
      </SettingsGroup>

      <AccountGroup />
    </div>
  )
}
