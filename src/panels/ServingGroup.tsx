import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Switch } from '../ui/Switch'
import { IS_TAURI } from '../config/runtime'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'

/* Issue #130: the desktop app keeps serving the library from the tray once
 * its window is closed. These are that mode's two settings. Both belong to
 * this machine, not the account, so they live in the Rust shell
 * (src-tauri/src/serving.rs), not in useSettings' server-backed store:
 * launch at login is the OS's own login item, and keep-awake is a file in
 * the shell's config dir. Desktop app only, the same way StreamQualityRow is
 * web only. */

// serving.rs's ServingSettingsView.
type ServingSettings = {
  launchAtLogin: boolean
  keepAwake: boolean
  keepAwakeAvailable: boolean
}

const NOTE = 'text-[length:var(--text-sm)] text-[color:var(--color-control)]'

export function ServingGroup() {
  const [settings, setSettings] = useState<ServingSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<ServingSettings>('serving_settings')
      .then(setSettings)
      .catch((e) => setError(String(e)))
  }, [])

  if (!IS_TAURI) return null

  // Not optimistic: a login item the OS refused to create must not look
  // switched on.
  const change = async (command: string, key: 'launchAtLogin' | 'keepAwake', enabled: boolean) => {
    setError(null)
    try {
      await invoke(command, { enabled })
      setSettings((s) => (s ? { ...s, [key]: enabled } : s))
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <SettingsGroup title="serving">
      <p className={NOTE}>
        Closing the window keeps your library playing on your other devices. Quit or pause it from Legato's icon in the
        menu bar or system tray.
      </p>
      {settings && (
        <>
          <SettingsRow label="login" align="start">
            <div className="flex flex-col gap-[var(--spacing-xs)]">
              <Switch
                checked={settings.launchAtLogin}
                onChange={(v) => void change('set_launch_at_login', 'launchAtLogin', v)}
                accessibilityLabel="open Legato when you log in"
              />
              <p className={NOTE}>Starts in the tray when you log in, without opening the window.</p>
            </div>
          </SettingsRow>
          <SettingsRow label="awake" align="start">
            <div className="flex flex-col gap-[var(--spacing-xs)]">
              <Switch
                checked={settings.keepAwake}
                disabled={!settings.keepAwakeAvailable}
                onChange={(v) => void change('set_keep_awake', 'keepAwake', v)}
                accessibilityLabel="keep this computer awake while serving"
              />
              {settings.keepAwakeAvailable ? (
                <p className={NOTE}>
                  Stops this computer going to sleep while someone is listening, and lets it sleep again 15 minutes
                  after the music stops. That costs battery: a laptop left awake on battery overnight can run most of
                  its charge down, where asleep it would barely lose any. The screen still turns off, and closing the
                  lid still puts it to sleep.
                </p>
              ) : (
                <p className={NOTE}>
                  Keeping this computer awake needs systemd-inhibit, which isn't installed here.
                </p>
              )}
            </div>
          </SettingsRow>
        </>
      )}
      {error && <p className={NOTE}>{error}</p>}
    </SettingsGroup>
  )
}
