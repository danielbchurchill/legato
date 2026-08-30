import { isTauri } from '@tauri-apps/api/core'

// Every module that needs to know whether it's running inside the Tauri
// desktop shell (native invoke/dialog available) or a plain browser tab (the
// web preview reached via `npm run dev:remote` — see README.md) reads this
// instead of calling isTauri() itself. Tauri injects window.isTauri
// synchronously before any page script runs, so computing this once at
// module load is safe — it never changes for the life of the tab.
export const IS_TAURI = isTauri()
