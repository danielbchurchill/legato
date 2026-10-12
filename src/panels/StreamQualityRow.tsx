import { useState } from 'react'
import { Select } from '../ui/Select'
import { IS_TAURI } from '../config/runtime'
import { QUALITY_OPTIONS, readQualityPreference, storeQualityPreference } from '../playback/quality'
import { SettingsRow } from './SettingsPrimitives'

/** #120's user override for the stream quality ladder (playback/quality.ts).
 * Web player only. The desktop app plays files straight from disk, so a
 * stream quality would mean nothing there and the row isn't shown. Stored
 * per device, so it applies from the next track on this one. */
export function StreamQualityRow() {
  const [preference, setPreference] = useState(readQualityPreference)
  if (IS_TAURI) return null

  return (
    <SettingsRow label="Stream quality">
      <Select
        label="stream quality"
        value={preference}
        options={QUALITY_OPTIONS}
        onChange={(value) => {
          storeQualityPreference(value)
          setPreference(value)
        }}
      />
    </SettingsRow>
  )
}
