import { useState } from 'react'
import { neverUseRelay, setNeverUseRelay } from '../connect/connectionPath'
import { SERVED_BY_SERVER } from '../config/serverHost'
import { Switch } from '../ui/Switch'
import { SettingsRow } from './SettingsPrimitives'

/* #118's pinned path: "never use the relay", for this device only, the way
 * the stream quality is (StreamQualityRow.tsx). It's checked where the
 * server base resolves (config/serverHost.ts), and the rail's connection
 * indicator says when it's on.
 *
 * Not on a page a Legato server served: that page only ever talks to the
 * server that served it, so there's no relay to rule out. */
export function NeverRelayRow() {
  const [on, setOn] = useState(neverUseRelay)
  if (SERVED_BY_SERVER) return null

  return (
    <SettingsRow label="Never use the relay" align="start">
      <div className="flex flex-col gap-[var(--spacing-xs)]">
        <Switch
          checked={on}
          onChange={(next) => {
            setNeverUseRelay(next)
            setOn(next)
          }}
          accessibilityLabel="never connect through legato.fm's relay on this device"
        />
        <p className="text-small [text-wrap:pretty] text-[var(--color-ink-3)]">
          This device only connects to a server directly, never through legato.fm. Away from home, a server on your home
          network is out of reach.
        </p>
      </div>
    </SettingsRow>
  )
}
