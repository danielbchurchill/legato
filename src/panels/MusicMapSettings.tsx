import { useState, type ReactNode } from 'react'
import { Toggle } from '../ui/Toggle'
import { Slider } from '../ui/Slider'
import { RadioGroup } from '../ui/RadioGroup'
import { ColorSwatch } from '../ui/ColorSwatch'
import { GRANULARITIES, GRANULARITY_LABELS, SHOW_IMAGES_SETTING_KEY, type Granularity } from '../shell/granularity'
import { CURATED_EDGE_HUES, edgeColorSettingKey, edgeTypesForGranularity, isHueTooClose, type EdgeTypeInfo } from '../canvas/edgeTypes'
import type { Settings } from '../hooks/useSettings'

/* The Music Map settings panel — DESIGN.md's "v2: settings primitives" and
 * "Edge palette" -> "v2: user-colorable types". Mounted by App.tsx into
 * InspectorPanel's 'graph' rail destination.
 *
 * "forces" (center/repel/link, bottom of this file) is UI ONLY. This app's
 * graph layout is a static one-shot computation (server/src/layout/cluster.ts,
 * whose own comment reads "Deliberately NOT a global force simulation") —
 * there is no running physics to wire these sliders to, and building fake
 * ones that looked wired would be a worse outcome than three sliders that
 * visibly just move. Same treatment for "links > distance": it only means
 * something in a live force layout, so it's local-only state too, right
 * alongside forces below rather than up with the real "links" controls it
 * sits next to in the mockup. */

function isGranularity(value: string | undefined): value is Granularity {
  return (GRANULARITIES as readonly string[]).includes(value ?? '')
}

function parseMultiplier(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value != null && Number.isFinite(n) ? n : fallback
}

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
  granularity,
  settings,
  updateSettings,
}: {
  granularity: Granularity
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
}) {
  const [editingType, setEditingType] = useState<string | null>(null)
  const types = edgeTypesForGranularity(granularity)
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
  /** The canvas's CURRENT active granularity (GraphToggle) — the edge-color
   * section shows whichever types belong to this graph, not the "default
   * view" preference below. */
  granularity: Granularity
}

export function MusicMapSettings({ settings, updateSettings, granularity }: MusicMapSettingsProps) {
  const defaultGranularity = isGranularity(settings.defaultGranularity) ? settings.defaultGranularity : 'albums'
  const nodesLocked = settings.nodePositionsLocked === 'true'
  const nodeSize = parseMultiplier(settings.nodeSizeMultiplier, 1)
  const edgeThickness = parseMultiplier(settings.edgeThicknessMultiplier, 1)

  // Local-only, not persisted — see this file's top comment.
  const [distance, setDistance] = useState(1)
  const [forceCenter, setForceCenter] = useState(1)
  const [forceRepel, setForceRepel] = useState(1)
  const [forceLink, setForceLink] = useState(1)

  return (
    <div className="flex flex-col gap-[var(--spacing-lg)] pb-[var(--spacing-lg)]">
      <div>
        <p className="text-[length:var(--text-base)] text-[var(--color-ink)]">music map</p>
        <RadioGroup
          className="mt-[var(--spacing-sm)]"
          options={GRANULARITIES}
          value={defaultGranularity}
          labels={GRANULARITY_LABELS}
          onChange={(v) => void updateSettings({ defaultGranularity: v })}
        />
      </div>

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
            {GRANULARITIES.map((g) => (
              <LabeledToggle
                key={g}
                label={GRANULARITY_LABELS[g]}
                checked={settings[SHOW_IMAGES_SETTING_KEY[g]] !== 'false'}
                onChange={(v) => void updateSettings({ [SHOW_IMAGES_SETTING_KEY[g]]: v ? 'true' : 'false' })}
              />
            ))}
          </div>
        </SettingsRow>
      </div>

      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="links" />
        <SettingsRow label="colours">
          <EdgeColorPicker granularity={granularity} settings={settings} updateSettings={updateSettings} />
        </SettingsRow>
        {/* distance only means something in a live force-directed layout —
         * this app's is a static one-shot computation, so this slider moves
         * and nothing else. See this file's top comment. */}
        <SettingsRow label="distance">
          <Slider value={distance} onChange={setDistance} label="edge distance" />
        </SettingsRow>
        <SettingsRow label="thickness">
          <Slider
            value={edgeThickness}
            onChange={(v) => void updateSettings({ edgeThicknessMultiplier: v.toFixed(2) })}
            label="edge thickness"
          />
        </SettingsRow>
      </div>

      {/* UI shell only — not wired to real physics. See this file's top
       * comment for why. */}
      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <GroupHeader title="forces" />
        <SettingsRow label="center">
          <Slider value={forceCenter} onChange={setForceCenter} label="center force" />
        </SettingsRow>
        <SettingsRow label="repel">
          <Slider value={forceRepel} onChange={setForceRepel} label="repel force" />
        </SettingsRow>
        <SettingsRow label="link">
          <Slider value={forceLink} onChange={setForceLink} label="link force" />
        </SettingsRow>
      </div>
    </div>
  )
}
