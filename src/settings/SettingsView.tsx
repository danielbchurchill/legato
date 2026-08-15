import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { Icon } from '../ui/Icon'
import { Surface } from '../shell/Surface'
import { SectionHeader } from '../ui/DataRow'
import { Button } from '../ui/Button'
import { useWsEvent } from '../hooks/useWs'
import { useModalTransition } from '../hooks/useModalTransition'
import type { Settings } from '../hooks/useSettings'
import type { ReplayGainMode } from '../playback/usePlayback'

const API = 'http://127.0.0.1:8899/api/v1'

type LibraryRoot = { id: number; path: string; label: string | null; enabled: number }
type ScanProgress = {
  jobId: number
  libraryRootId: number
  filesScanned: number
  filesTotal: number
  filesAdded: number
  filesUpdated: number
}

/* The maintenance-view overlay's twin — same fixed-inset Surface modal, same
 * header bar. See DESIGN.md; this is the first surface built directly
 * against the design system with no inline-style predecessor to convert. */

function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div role="tablist" className="flex gap-[16px]">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`text-[length:var(--text-base)] transition-colors duration-150 ${
              active ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

const REPLAYGAIN_OPTIONS = [
  { value: 'track', label: 'track' },
  { value: 'album', label: 'album' },
  { value: 'off', label: 'off' },
] as const satisfies readonly { value: ReplayGainMode; label: string }[]

type SettingsViewProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  onSetAudioDevice: (name: string | null) => Promise<void>
  onClose: () => void
}

export function SettingsView({ settings, updateSettings, onSetAudioDevice, onClose }: SettingsViewProps) {
  const { phase, requestClose } = useModalTransition(onClose)
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

  // Arriving is slower than leaving (MO-8: --motion-base in, --motion-exit
  // out) — the scrim and panel share one duration class so both layers
  // move together.
  const duration = phase === 'exiting' ? 'duration-[var(--motion-exit)]' : 'duration-[var(--motion-base)]'
  const entered = phase === 'entered'

  return (
    <div
      className={`fixed inset-0 z-30 flex items-center justify-center bg-[var(--color-canvas)]/40 p-[60px] backdrop-blur-[var(--blur-glass)] transition-opacity ${duration} ease-[var(--ease-out)] ${entered ? 'opacity-100' : 'opacity-0'}`}
    >
      <Surface
        className={`flex max-h-full w-full max-w-[640px] flex-col overflow-hidden transition-all ${duration} ease-[var(--ease-out)] motion-reduce:scale-100 ${entered ? 'scale-100 opacity-100' : 'scale-[0.985] opacity-0'}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-divider)] px-[var(--spacing-panel)] py-[21px]">
          <h2 className="text-[length:var(--text-base)] font-normal text-[var(--color-muted)]">settings</h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close settings"
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
          >
            <Icon name="cancel" size={24} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[var(--spacing-panel)] pb-[var(--spacing-panel)]">
          <SectionHeader
            title="library"
            action={<Button onClick={() => void addFolder()}>+ add folder</Button>}
          />
          <div className="mt-[8px]">
            {roots === null ? (
              <p className="py-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">loading…</p>
            ) : roots.length === 0 ? (
              <p className="py-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">
                no library folders configured
              </p>
            ) : (
              <ul className="flex flex-col gap-[8px]">
                {roots.map((r) => {
                  const progress = scanning[r.id]
                  const confirming = confirmingRemoveId === r.id
                  return (
                    <li key={r.id} className="flex items-center justify-between gap-[12px]">
                      {confirming ? (
                        <>
                          <p className="min-w-0 truncate text-[length:var(--text-base)] text-[var(--color-muted)]">
                            Remove {r.label ?? r.path}? Legato stops watching it — already-scanned tracks stay in
                            your library.
                          </p>
                          <div className="flex shrink-0 items-center gap-[16px]">
                            <Button variant="destructive" onClick={() => void removeRoot(r.id)}>
                              remove
                            </Button>
                            <button
                              type="button"
                              onClick={() => setConfirmingRemoveId(null)}
                              className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]"
                            >
                              cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="min-w-0">
                            <p className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                              {r.label ?? r.path}
                            </p>
                            {progress && (
                              <div className="flex items-center gap-[8px] py-[2px]">
                                <p className="shrink-0 text-[length:var(--text-base)] text-[var(--color-muted)]">
                                  scanning{' '}
                                  <span className="font-[family-name:var(--font-mono)] text-[var(--color-muted-hi)]">
                                    {progress.filesScanned}/{progress.filesTotal}
                                  </span>
                                </p>
                                {/* MO-11: determinate progress is data, not decoration — a
                                 * real fraction of a known total, stepped not eased (DESIGN.md
                                 * Motion's "never animate live data" applies here same as playback position). */}
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
                          <div className="flex shrink-0 items-center gap-[12px]">
                            <Button onClick={() => void rescanRoot(r.id)}>rescan</Button>
                            <button
                              type="button"
                              onClick={() => setConfirmingRemoveId(r.id)}
                              aria-label={`Remove ${r.label ?? r.path}`}
                              className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                            >
                              <Icon name="cancel" size={18} />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {/* DESIGN.md's error-state rule is deliberately quiet — Rubik
             * muted, one sentence — not a red/alert color the tokens don't
             * define. */}
            {error && <p className="pt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">{error}</p>}
          </div>

          <SectionHeader title="enrichment" />
          <div className="mt-[8px] flex items-center justify-between">
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
              look up MusicBrainz metadata and cover art automatically
            </p>
            <Toggle
              options={[
                { value: 'on', label: 'on' },
                { value: 'off', label: 'off' },
              ]}
              value={enrichmentEnabled ? 'on' : 'off'}
              onChange={(v) => void updateSettings({ enrichmentEnabled: v === 'on' ? 'true' : 'false' })}
            />
          </div>

          <SectionHeader title="replaygain" />
          <div className="mt-[8px] flex items-center justify-between">
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">volume-normalize playback</p>
            <Toggle
              options={REPLAYGAIN_OPTIONS}
              value={replaygainMode}
              onChange={(v) => void updateSettings({ replaygainMode: v })}
            />
          </div>

          <SectionHeader title="audio device" />
          <div className="mt-[8px]">
            <select
              value={audioDevice}
              onChange={(e) => {
                const name = e.target.value || null
                void updateSettings({ audioDevice: name ?? '' })
                void onSetAudioDevice(name)
              }}
              className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none [&>option]:bg-[var(--color-canvas)]"
            >
              <option value="">system default</option>
              {(devices ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Surface>
    </div>
  )
}
