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
import { GroupHeader, SettingsRow } from './SettingsPrimitives'

const API = `http://${SERVER_HOST}:8899/api/v1`

/* The Legato settings panel — DESIGN.md's "v2: settings primitives",
 * restyled onto the same GroupHeader/SettingsRow geometry MusicMapSettings.tsx
 * uses. Mounted by App.tsx into InspectorPanel's 'settings' rail destination,
 * replacing the old settings-gear modal (src/settings/SettingsView.tsx) —
 * DESIGN.md used to flag two settings entry points, one real and one
 * placeholder-only, as an open seam; this closes it by giving the real
 * content a home behind the rail's `sliders` destination instead. */

type LibraryRoot = { id: number; path: string; label: string | null; enabled: number }
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

  const loadRoots = () => {
    fetch(`${API}/library-roots`)
      .then((r) => r.json())
      .then(setRoots)
  }

  useEffect(() => {
    loadRoots()
    invoke<string[]>('list_audio_devices')
      .then(setDevices)
      .catch(() => setDevices([]))
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

  const addFolder = async () => {
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

  // Key/semantics match server/src/enrich/queue.ts's isEnrichmentEnabled —
  // missing the setting entirely means enabled, same default this toggle
  // must preserve rather than invent a second on/off convention.
  const enrichmentEnabled = settings.enrichmentEnabled !== 'false'
  const replaygainMode: ReplayGainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  const audioDevice = settings.audioDevice || ''
  const hoverDimEnabled = settings.hoverDimEnabled !== 'false'
  const reducedMotionForced = settings.reducedMotionForced === 'true'

  return (
    <div className="flex flex-col gap-[var(--spacing-lg)] pb-[var(--spacing-lg)]">
      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="library" action={<Button onClick={() => void addFolder()}>+ add folder</Button>} />
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
                      <p className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">
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
                      </div>
                      <div className="flex shrink-0 items-center gap-[var(--spacing-sm)]">
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
      </div>

      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="enrichment" />
        <SettingsRow label="lookup">
          <Toggle
            checked={enrichmentEnabled}
            onChange={(v) => void updateSettings({ enrichmentEnabled: v ? 'true' : 'false' })}
            label="look up MusicBrainz metadata and cover art automatically"
          />
        </SettingsRow>
      </div>

      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="playback" />
        <SettingsRow label="gain">
          <SegmentedControl
            options={REPLAYGAIN_OPTIONS}
            value={replaygainMode}
            onChange={(v) => void updateSettings({ replaygainMode: v })}
          />
        </SettingsRow>
        <SettingsRow label="device">
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
        </SettingsRow>
      </div>

      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="canvas" />
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
      </div>

      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="shortcuts" />
        <ShortcutRow action="play / pause" keys="space" />
        <ShortcutRow action="focus search" keys="/" />
        <ShortcutRow action="deselect / close" keys="esc" />
      </div>
    </div>
  )
}
