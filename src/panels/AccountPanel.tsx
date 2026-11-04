import { PanelHeader } from '../shell/SidePanel'
import { AccountSettings } from './AccountSettings'

/* The Account left panel (#470), behind the avatar at the rail's foot: its
 * title over the account cards. */
export function AccountPanel() {
  return (
    <div className="flex flex-col gap-[14px]">
      <PanelHeader title="Account" />
      <AccountSettings />
    </div>
  )
}
