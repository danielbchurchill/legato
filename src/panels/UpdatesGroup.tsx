import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Switch } from '../ui/Switch'
import { IS_TAURI } from '../config/runtime'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'

/* Issue #497: the desktop app's own update check (src-tauri/src/updater.rs)
 * can be switched off. It belongs to this install, not the account, so it
 * lives in the Rust shell beside keep-awake (ServingGroup.tsx), not in
 * useSettings' server-backed store, which may be a server on another
 * machine. The app's own server never runs the server's check (it's
 * spawned with LEGATO_INSTALL_CHANNEL=desktop, server/src/update/check.ts),
 * so this switch covers the app's only contact with GitHub.
 * LEGATO_UPDATE_CHECK=off in the app's
 * environment turns it off whatever the switch says, as it does the
 * server's. Desktop app only. */

// updater.rs's UpdateCheckView.
type UpdateCheck = {
  enabled: boolean
  offByEnvironment: boolean
}

const NOTE = 'text-[length:var(--text-sm)] text-[color:var(--color-control)]'

export function UpdatesGroup() {
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<UpdateCheck>('update_check_settings')
      .then(setCheck)
      .catch((e) => setError(String(e)))
  }, [])

  if (!IS_TAURI) return null

  // Not optimistic, as ServingGroup isn't: a switch whose file didn't save
  // must not look changed.
  const change = async (enabled: boolean) => {
    setError(null)
    try {
      await invoke('set_update_check', { enabled })
      setCheck((c) => (c ? { ...c, enabled } : c))
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <SettingsGroup title="updates">
      {check && (
        <SettingsRow label="check" align="start">
          <div className="flex flex-col gap-[var(--spacing-xs)]">
            <Switch
              checked={check.enabled && !check.offByEnvironment}
              disabled={check.offByEnvironment}
              onChange={(v) => void change(v)}
              accessibilityLabel="check for Legato updates"
            />
            {check.offByEnvironment ? (
              <p className={NOTE}>
                Off, because <span className="mono">LEGATO_UPDATE_CHECK=off</span> is set where Legato starts.
              </p>
            ) : (
              <p className={NOTE}>
                Asks GitHub for a newer Legato when the app opens and once a day, and downloads it in the background.
                Nothing installs until you choose restart to update. GitHub sees this computer's IP address and nothing
                about your library. This is the app's only request to GitHub: its server never checks for updates of
                its own. Off, the app asks GitHub nothing, and you update by downloading the next release yourself.
              </p>
            )}
          </div>
        </SettingsRow>
      )}
      {error && <p className={NOTE}>{error}</p>}
    </SettingsGroup>
  )
}
