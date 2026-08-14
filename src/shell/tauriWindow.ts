import { getCurrentWindow } from '@tauri-apps/api/window'

/* Every window call is wrapped because the app also runs in a plain browser
 * tab (`npm run dev`, and the ?debug spikes), where the Tauri IPC does not
 * exist and these reject. Same defensive shape usePlayback already uses for
 * invoke/listen — the chrome renders and simply does nothing when there is no
 * real window behind it. */

type AppWindow = ReturnType<typeof getCurrentWindow>

async function withWindow<T>(fn: (win: AppWindow) => Promise<T>): Promise<T | null> {
  try {
    return await fn(getCurrentWindow())
  } catch {
    return null
  }
}

export const appWindow = {
  minimize: () => withWindow((w) => w.minimize()),
  toggleMaximize: () => withWindow((w) => w.toggleMaximize()),
  close: () => withWindow((w) => w.close()),
  isMaximized: () => withWindow((w) => w.isMaximized()),
  onResized: async (handler: () => void): Promise<() => void> => {
    const unlisten = await withWindow((w) => w.onResized(handler))
    return unlisten ?? (() => {})
  },
}
