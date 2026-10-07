import type { ComponentProps } from 'react'
import { PanelHeader } from '../shell/SidePanel'
import type { MapPresetHistory } from '../hooks/useMapPresetHistory'
import { LegatoSettings } from './LegatoSettings'
import { MusicMapSettings } from './MusicMapSettings'

/* Settings, for now: the app's settings, then the map's own, which live
 * here until the map gets a toolbar of its own. */
export function SettingsPanel({ mapPresets, ...props }: ComponentProps<typeof LegatoSettings> & { mapPresets: MapPresetHistory }) {
  return (
    <div className="flex flex-col gap-[14px]">
      <PanelHeader title="Settings" />
      <LegatoSettings {...props} />
      <MusicMapSettings settings={props.settings} updateSettings={props.updateSettings} mapPresets={mapPresets} />
    </div>
  )
}
