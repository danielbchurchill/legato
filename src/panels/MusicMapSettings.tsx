import { useState } from 'react'
import { Toggle } from '../ui/Toggle'
import { Slider } from '../ui/Slider'
import { ColorSwatch } from '../ui/ColorSwatch'
import { Button } from '../ui/Button'
import { CURATED_EDGE_HUES, edgeColorSettingKey, edgeTypes, isHueTooClose, type EdgeTypeInfo } from '../canvas/edgeTypes'
import { NODE_TYPES, nodeSizeSettingKey } from '../canvas/nodeTypes'
import {
  FORCE_SLIDER_LABELS,
  MAP_PRESET_IDS,
  MAP_PRESET_LABELS,
  type MapPresetId,
} from '../canvas/mapPresets'
import type { Settings } from '../hooks/useSettings'
import type { MapPresetHistory } from '../hooks/useMapPresetHistory'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'

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
 * the "images" row's per-tab meaning became per-node-type instead.
 *
 * #26/#29/#24: "nodes > size" was one global nodeSizeMultiplier slider
 * controlling every type at once — replaced with one slider per real node
 * type (src/canvas/nodeTypes.ts, the same canonical-list pattern edgeTypes.ts
 * already established for edge colors), each its own nodeSize:<type>
 * setting. "links > colours" and the new "nodes > size" both wrap onto more
 * than one line now, hence `align="start"` on their SettingsRow — see
 * SettingsPrimitives.tsx's own comment on why that matters; "colours" was
 * missing it outright (the actual misalignment #26 reported) alongside a
 * real logic bug in edgeTypes.ts's hue-clearance picker (see that file).
 * "nodes > producers" is new: #24 added seeding for 'credit' nodes
 * (producer/engineer credits — server/src/match/edges.ts,
 * server/src/enrich/credits.ts) to the combined graph, gated behind this
 * toggle since they're a new addition to an already-tuned graph. */

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

function LabeledToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex flex-col items-center gap-[var(--spacing-xs)]">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{label}</span>
    </div>
  )
}

/* #127/D19: the three preset pills. Selection reuses ColorSwatch's own
 * ring-1/ring-offset treatment (see that file) rather than inventing a
 * second "this is the selected one" language — no pill selected at all
 * means "custom", once a slider's been dragged off every named point. */
function PresetPicker({ activePreset, onApplyPreset }: { activePreset: MapPresetId | null; onApplyPreset: (id: MapPresetId) => void }) {
  return (
    <div className="flex flex-wrap gap-[var(--spacing-sm)]">
      {MAP_PRESET_IDS.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={activePreset === id}
          onClick={() => onApplyPreset(id)}
          className={`rounded-full border border-[var(--color-hairline)] px-[14px] py-[4px] text-[length:var(--text-sm)] text-[color:var(--color-control)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:bg-white/8 ${
            activePreset === id ? 'ring-1 ring-[var(--color-ink)] ring-offset-2 ring-offset-[var(--color-canvas)]' : ''
          }`}
        >
          {MAP_PRESET_LABELS[id]}
        </button>
      ))}
    </div>
  )
}

/* A "forces" slider row with D19's plain-language label as the primary
 * text and the technical name (what MusicMapSettings called this before
 * #127, and what forceSimulation.ts's own comments still call it) kept as
 * secondary text next to it — see FORCE_SLIDER_LABELS in mapPresets.ts. */
function ForceSliderRow({
  plain,
  technical,
  value,
  onChange,
  min,
  max,
  step,
}: {
  plain: string
  technical: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <div className="flex flex-col gap-[var(--spacing-xs)]">
      <div className="flex flex-wrap items-baseline gap-x-[var(--spacing-xs)]">
        <span className="text-[length:var(--text-sm)] text-[color:var(--color-control)]">{plain}</span>
        <span className="text-[length:var(--text-sm)] text-[color:var(--color-muted)]">{technical}</span>
      </div>
      <Slider value={value} onChange={onChange} min={min} max={max} step={step} label={technical} />
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
  /** #127: session preset/undo state — held in App.tsx (see
   * useMapPresetHistory's own comment for why it can't live here), passed
   * down rather than recomputed so this panel and the canvas's "map spread
   * out of view" recovery banner both undo/restore-defaults the same
   * session history. */
  mapPresets: MapPresetHistory
}

export function MusicMapSettings({ settings, updateSettings, mapPresets }: MusicMapSettingsProps) {
  const nodesLocked = settings.nodePositionsLocked === 'true'
  const showCreditNodes = settings.showCreditNodes === 'true'
  const edgeThickness = parseMultiplier(settings.edgeThicknessMultiplier, 1)
  const linkDistance = parseMultiplier(settings.linkDistance, 80)
  const forceCenter = parseMultiplier(settings.forceCenterStrength, 0.03)
  const forceRepel = parseMultiplier(settings.forceRepelStrength, 150)
  const forceLink = parseMultiplier(settings.forceLinkStrength, 0.15)

  return (
    <div className="flex flex-col gap-[var(--spacing-sm)]">
      <SettingsGroup title="layout">
        <SettingsRow label="preset" align="start">
          <PresetPicker activePreset={mapPresets.activePreset} onApplyPreset={mapPresets.applyPreset} />
        </SettingsRow>
        <SettingsRow label="history">
          <div className="flex items-center gap-[var(--spacing-lg)]">
            <Button onClick={mapPresets.undo} disabled={!mapPresets.canUndo}>
              undo
            </Button>
            <Button onClick={mapPresets.restoreDefaults}>restore defaults</Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="nodes">
        <SettingsRow label="lock">
          <Toggle
            checked={nodesLocked}
            onChange={(v) => void updateSettings({ nodePositionsLocked: v ? 'true' : 'false' })}
            label="lock node positions"
          />
        </SettingsRow>
        <SettingsRow label="producers">
          <Toggle
            checked={showCreditNodes}
            onChange={(v) => void updateSettings({ showCreditNodes: v ? 'true' : 'false' })}
            label="show producer nodes"
          />
        </SettingsRow>
        <SettingsRow label="size" align="start">
          <div className="flex flex-col gap-[var(--spacing-xs)]">
            {NODE_TYPES.map(({ type, label }) => (
              <div key={type} className="flex items-center gap-[var(--spacing-sm)]">
                <span className="w-[60px] shrink-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">
                  {label}
                </span>
                <Slider
                  value={parseMultiplier(settings[nodeSizeSettingKey(type)], 1)}
                  onChange={(v) => void updateSettings({ [nodeSizeSettingKey(type)]: v.toFixed(2) })}
                  label={`${label} node size`}
                />
              </div>
            ))}
          </div>
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
      </SettingsGroup>

      <SettingsGroup title="links">
        <SettingsRow label="colours" align="start">
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
      </SettingsGroup>

      {/* #127/D19: plain-language primary label, technical name secondary —
       * "link force" / "repel" / "center" are still what forceSimulation.ts
       * and this settings store's own keys call these, just no longer the
       * first thing a person reads here. No `align="start"` SettingsRow
       * wrapper — each row now owns its full label-above-slider layout via
       * ForceSliderRow, since the plain-language text is too long for the
       * shared 68px label column every other row in this panel uses. */}
      <SettingsGroup title="forces">
        <ForceSliderRow
          plain={FORCE_SLIDER_LABELS.forceCenterStrength.plain}
          technical={FORCE_SLIDER_LABELS.forceCenterStrength.technical}
          value={forceCenter}
          onChange={(v) => void updateSettings({ forceCenterStrength: v.toFixed(2) })}
        />
        <ForceSliderRow
          plain={FORCE_SLIDER_LABELS.forceRepelStrength.plain}
          technical={FORCE_SLIDER_LABELS.forceRepelStrength.technical}
          value={forceRepel}
          onChange={(v) => void updateSettings({ forceRepelStrength: v.toFixed(0) })}
          min={0}
          max={200}
          step={1}
        />
        <ForceSliderRow
          plain={FORCE_SLIDER_LABELS.forceLinkStrength.plain}
          technical={FORCE_SLIDER_LABELS.forceLinkStrength.technical}
          value={forceLink}
          onChange={(v) => void updateSettings({ forceLinkStrength: v.toFixed(2) })}
        />
      </SettingsGroup>
    </div>
  )
}
