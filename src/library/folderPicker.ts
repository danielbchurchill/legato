import { IS_TAURI } from '../config/runtime'
import { SERVER_HOST } from '../config/serverHost'
import { isLoopbackHost } from '../connect/address'

/* Which folder picker "add folder" opens (issue #121).
 *
 * Tauri's native dialog browses the disks of the machine the window runs
 * on, so it's only right when the server is on that same machine: the
 * desktop app with its built-in server, which keeps the dialog people know
 * from every other app on their OS. Anywhere else (a browser tab, or the
 * desktop app pointed at a Pi) the folders that matter are the server's,
 * and only the server can list them.
 *
 * "This machine" means a loopback address. A server reached by this
 * machine's own LAN or Tailscale address is treated as remote: the server
 * picker is correct everywhere, the native one only sometimes, so the
 * doubtful case goes to the one that can't be wrong. */

export type FolderPickerKind = 'native' | 'server'

export function folderPickerKind({ isTauri, serverHost }: { isTauri: boolean; serverHost: string }): FolderPickerKind {
  return isTauri && isLoopbackHost(serverHost) ? 'native' : 'server'
}

export const FOLDER_PICKER: FolderPickerKind = folderPickerKind({ isTauri: IS_TAURI, serverHost: SERVER_HOST })
