import { type ReactNode, useState } from 'react'
import { Toggle } from '../ui/Toggle'
import { Slider } from '../ui/Slider'
import { ColorSwatch } from '../ui/ColorSwatch'
import { CURATED_EDGE_HUES, edgeColorSettingKey, edgeTypes, isHueTooClose, type EdgeTypeInfo } from '../canvas/edgeTypes'
import type { Settings } from '../hooks/useSettings'

/* The Music Map settings panel — DESIGN.md's "v2: settings primitives" and
 * "Edge palette" -> "v2: user-colorable types". Mounted by App.tsx into
 * InspectorPanel's 'graph' rail destination.
 *
 * 2026-08-29: "forces" and "links > distance" are now real, live physics —
 * src/canvas/forceSimulation.ts reads these settings every tick. They used
 * to be UI-only placeholders (this app's graph was a static one-shot
 * layout, server/src/layout/cluster.ts, "Deliberately NOT a global force
 * simulation") before Daniel asked for Obsidian-style live physics; see
 * Legato.md for the change. Same session removed the granularity tabs
 * (artists/albums/tracks are now one combined graph, not three switchable
 * ones), so this file also lost its "music map > default view" section and
 * the "images" row's per-tab meaning became per-node-type instead. */

function parseMultiplier(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value != null && Number.isFinite(n) ? n : fallback
}

/* Node-type image toggles — one flag per node type in the combined graph.
 * Same three settings keys the old per-granularity "images" toggle used
 * (showImagesArtists/Albums/Tracks): unchanged storage, just re-scoped from
 * "when this tab is active" to "for this node type, always". */
const NODE_TYPE_IMAGE_TOGGLES: { key: string; label: string }[] = [
  { key: 'showImagesArtists', label: 'artists' },
  { key: 'showImagesAlbums', label: 'releases' },
  { key: 'showImagesTracks', label: 'tracks' },
]

function GroupHeader({ title }: { title: string }) {
  return <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">{title}</p>
}

function SettingsRow({
  label,
  align = 'center',
  children,
}: {
  label: string
  /** 'start' for a row whose control can wrap to more than one line (the
   * color swatches below) — 'center' would otherwise vertically center the
   * label against the whole wrapped block instead of its first line. */
  align?: 'center' | 'start'
  children: ReactNode
}) {
  return (
    <div className={`flex gap-[var(--spacing-sm)] ${align === 'center' ? 'items-center' : 'items-start'}`}>
      <span className="w-[68px] shrink-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function LabeledToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex flex-col items-center gap-[var(--spacing-xs)]">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{label}</span>
    </div>
  )
}

function resolveEdgeHex(info: EdgeTypeInfo, settings: Settings): string {
  return settings[edgeColorSettingKey(info.type)] ?? info.defaultHex
}

function EdgeColorPicker({
  settings,
  updateSettings,
}: {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
}) {
  const [editingType, setEditingType] = useState<string | null>(null)
  const types = edgeTypes()
  const editingInfo = types.find((t) => t.type === editingType)

  return (
    <div className="flex flex-col gap-[var(--spacing-sm)]">
      <div className="flex flex-wrap gap-x-[var(--spacing-lg)] gap-y-[var(--spacing-sm)]">
        {types.map((info) => (
          <ColorSwatch
            key={info.type}
            color={resolveEdgeHex(info, settings)}
            label={info.label}
            selected={info.type === editingType}
            onClick={() => setEditingType(info.type === editingType ? null : info.type)}
          />
        ))}
      </div>
      {editingInfo && (
        <div className="flex flex-wrap gap-[var(--spacing-sm)] border-t border-[var(--color-divider)] pt-[var(--spacing-sm)]">
          {CURATED_EDGE_HUES.map(({ hue, hex }) => {
            const otherHexes = types.filter((t) => t.type !== editingInfo.type).map((t) => resolveEdgeHex(t, settings))
            const taken = isHueTooClose(hex, otherHexes)
            return (
              <ColorSwatch
                key={hue}
                color={hex}
                label={`${Math.round(hue)}°`}
                selected={hex.toLowerCase() === resolveEdgeHex(editingInfo, settings).toLowerCase()}
                disabled={taken}
                onClick={() => {
                  void updateSettings({ [edgeColorSettingKey(editingInfo.type)]: hex })
                  setEditingType(null)
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

type MusicMapSettingsProps = {
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
}

export function MusicMapSettings({ settings, updateSettings }: MusicMapSettingsProps) {
  const nodesLocked = settings.nodePositionsLocked === 'true'
  const nodeSize = parseMultiplier(settings.nodeSizeMultiplier, 1)
  const edgeThickness = parseMultiplier(settings.edgeThicknessMultiplier, 1)
  const linkDistance = parseMultiplier(settings.linkDistance, 80)
  const forceCenter = parseMultiplier(settings.forceCenterStrength, 0.03)
  const forceRepel = parseMultiplier(settings.forceRepelStrength, 150)
  const forceLink = parseMultiplier(settings.forceLinkStrength, 0.15)

  return (
    <div className="flex flex-col gap-[var(--spacing-lg)] pb-[var(--spacing-lg)]">
      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="nodes" />
        <SettingsRow label="lock">
          <Toggle
            checked={nodesLocked}
            onChange={(v) => void updateSettings({ nodePositionsLocked: v ? 'true' : 'false' })}
            label="lock node positions"
          />
        </SettingsRow>
        <SettingsRow label="size">
          <Slider
            value={nodeSize}
            onChange={(v) => void updateSettings({ nodeSizeMultiplier: v.toFixed(2) })}
            label="node size"
          />
        </SettingsRow>
        <SettingsRow label="images">
          <div className="flex items-center gap-[var(--spacing-lg)]">
            {NODE_TYPE_IMAGE_TOGGLES.map(({ key, label }) => (
              <LabeledToggle
                key={key}
                label={label}
                checked={settings[key] !== 'false'}
                onChange={(v) => void updateSettings({ [key]: v ? 'true' : 'false' })}
              />
            ))}
          </div>
        </SettingsRow>
      </div>

      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="links" />
        <SettingsRow label="colours">
          <EdgeColorPicker settings={settings} updateSettings={updateSettings} />
        </SettingsRow>
        <SettingsRow label="distance">
          <Slider
            value={linkDistance}
            onChange={(v) => void updateSettings({ linkDistance: v.toFixed(0) })}
            min={20}
            max={300}
            step={1}
            label="link distance"
          />
        </SettingsRow>
        <SettingsRow label="thickness">
          <Slider
            value={edgeThickness}
            onChange={(v) => void updateSettings({ edgeThicknessMultiplier: v.toFixed(2) })}
            label="edge thickness"
          />
        </SettingsRow>
      </div>

      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="forces" />
        <SettingsRow label="center">
          <Slider
            value={forceCenter}
            onChange={(v) => void updateSettings({ forceCenterStrength: v.toFixed(2) })}
            label="center force"
          />
        </SettingsRow>
        <SettingsRow label="repel">
          <Slider
            value={forceRepel}
            onChange={(v) => void updateSettings({ forceRepelStrength: v.toFixed(0) })}
            min={0}
            max={200}
            step={1}
            label="repel force"
          />
        </SettingsRow>
        <SettingsRow label="link">
          <Slider
            value={forceLink}
            onChange={(v) => void updateSettings({ forceLinkStrength: v.toFixed(2) })}
            label="link force"
          />
        </SettingsRow>
      </div>
    </div>
  )
}
