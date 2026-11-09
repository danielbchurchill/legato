import { IS_TAURI } from '../config/runtime'
import { SERVER_ORIGIN } from '../config/serverHost'
import { AWAY_QUALITY_OPTIONS, awayFromHome, useAwayFromHome } from '../connect/awayFromHome'
import { serverWords } from '../connect/awayNotice'
import { readLastSeen } from '../connect/lastSeen'
import { Select } from '../ui/Select'
import { SettingsRow } from './SettingsPrimitives'

/** #412's Away from home, after the stream quality: what this device does
 * when the server sees it reach it over Tailscale from outside the home
 * network. Tell me (the notice), standard · 160 kbps while away, or the same
 * as at home. Stored per device, like the stream quality, and the notice's
 * own choices set it too, so it follows the store. Web player only: the
 * desktop app plays files from disk. */
export function AwayFromHomeRow() {
  const { quality } = useAwayFromHome()
  if (IS_TAURI) return null
  const server = serverWords(readLastSeen(SERVER_ORIGIN)?.name)

  return (
    <div className="flex flex-col gap-[var(--spacing-xs)]">
      <SettingsRow label="Away from home">
        <Select label="away from home" value={quality} options={AWAY_QUALITY_OPTIONS} onChange={awayFromHome.setQuality} />
      </SettingsRow>
      <p className="text-small [text-wrap:pretty] text-[var(--color-ink-3)]">
        When {server} sees this device reach it over Tailscale from outside your home network.
      </p>
    </div>
  )
}
