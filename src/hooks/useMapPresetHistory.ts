import { useCallback, useEffect, useRef, useState } from 'react'
import {
  canUndoForceChange,
  forceSettingsEqual,
  forceSettingsFromSettings,
  forceSettingsToPartialSettings,
  initForceHistory,
  matchPreset,
  MAP_PRESETS,
  recordForceChange,
  undoForceChange,
  type ForceHistoryState,
  type MapPresetId,
} from '../canvas/mapPresets'
import type { Settings } from './useSettings'

/* #127: lives beside useSettings() in App.tsx, not inside MusicMapSettings.tsx
 * itself — that panel unmounts every time the rail switches to another
 * destination (InspectorPanel only ever mounts the active one), so history
 * kept as that component's own state would be wiped out by clicking over to
 * "search" and back. Held here, undo survives a tab switch and Cmd/Ctrl+Z
 * (wired in App.tsx's existing global shortcut handler) works regardless of
 * which rail destination is currently open. */
export function useMapPresetHistory(settings: Settings, updateSettings: (partial: Settings) => Promise<void>) {
  const current = forceSettingsFromSettings(settings)

  const [history, setHistory] = useState<ForceHistoryState>(() => initForceHistory(current))

  // Set just before undo() pushes its own restored value back through
  // updateSettings — otherwise the settings-change effect below would see
  // that arrive and record it as a brand new forward change, burying the
  // checkpoint undo just popped instead of leaving it available to redo-by-
  // undoing-again... except there is no redo here, so double-recording it
  // would instead silently make undo one step "shorter" every time it's
  // pressed (each undo would re-push what it just removed).
  const suppressNextRecordRef = useRef(false)

  useEffect(() => {
    if (suppressNextRecordRef.current) {
      suppressNextRecordRef.current = false
      return
    }
    setHistory((prev) => (forceSettingsEqual(prev.present, current) ? prev : recordForceChange(prev, current, Date.now())))
    // current's fields, not the object itself — settings is a fresh object
    // from every fetch/update round trip (useSettings.ts), so its identity
    // never repeats even when the four values this hook cares about don't
    // change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.forceCenterStrength, current.forceRepelStrength, current.forceLinkStrength, current.linkDistance])

  const applyPreset = useCallback(
    (id: MapPresetId) => {
      void updateSettings(forceSettingsToPartialSettings(MAP_PRESETS[id]))
    },
    [updateSettings],
  )

  const restoreDefaults = useCallback(() => applyPreset('balanced'), [applyPreset])

  const undo = useCallback(() => {
    setHistory((prev) => {
      const next = undoForceChange(prev, Date.now())
      if (next === prev) return prev
      suppressNextRecordRef.current = true
      void updateSettings(forceSettingsToPartialSettings(next.present))
      return next
    })
  }, [updateSettings])

  return {
    current,
    activePreset: matchPreset(current),
    applyPreset,
    restoreDefaults,
    undo,
    canUndo: canUndoForceChange(history),
  }
}

export type MapPresetHistory = ReturnType<typeof useMapPresetHistory>
