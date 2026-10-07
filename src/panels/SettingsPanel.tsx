import type { ComponentProps } from 'react'
import { PanelHeader } from '../shell/SidePanel'
import { LegatoSettings } from './LegatoSettings'

/* The Settings left panel: its title over the settings cards. */
export function SettingsPanel(props: ComponentProps<typeof LegatoSettings>) {
  return (
    <div className="flex flex-col gap-[14px]">
      <PanelHeader title="Settings" />
      <LegatoSettings {...props} />
    </div>
  )
}
