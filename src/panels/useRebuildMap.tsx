import { useState } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { AlertDialog } from '../ui/Dialog'
import { useToast } from '../ui/toastContext'

/* Rebuild map layout, from Settings' map & motion card on the desktop and
 * on the phone (#389). #46: it regenerates the whole graph's layout (fresh
 * seed jitter, every manually-placed node's pin cleared) without touching
 * the library on disk. The server broadcasts "layout:rebuilt" when it's
 * done, which is what actually moves the running canvas (App.tsx remounts
 * it). This fires the request and clears the "in progress" state once the
 * response comes back, the same division of labour a rescan has with
 * scan:done.
 *
 * It asks first, in an AlertDialog since the gpui-kit port, and the outcome
 * is a toast: the caller's "rebuilding…" shimmer says the work is under
 * way, but once it stops there was nothing saying whether it worked — the
 * canvas remounting behind a panel reads the same as nothing happening.
 *
 * `dialog` is the confirmation, for the caller to render; `ask` opens it. */
export function useRebuildMap() {
  const [confirming, setConfirming] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const toast = useToast()

  const rebuild = async () => {
    setConfirming(false)
    setRebuilding(true)
    try {
      const res = await fetch(`${API}/layout/rebuild`, { method: 'POST' })
      toast.show(
        res.ok
          ? { title: 'map rebuilt', description: 'every node has a fresh place on the canvas.' }
          : { title: "couldn't rebuild the map", description: `legato-server answered ${res.status}.` },
      )
    } catch {
      toast.show({ title: "couldn't rebuild the map", description: "couldn't reach legato-server." })
    } finally {
      setRebuilding(false)
    }
  }

  const dialog = (
    <AlertDialog
      open={confirming}
      onCancel={() => setConfirming(false)}
      onConfirm={() => void rebuild()}
      title="rebuild the map"
      description="Every node gets freshly placed, including anywhere you've dragged one — that placement is gone. Your library on disk is untouched."
      confirmLabel="Rebuild"
      destructive
    />
  )

  return { ask: () => setConfirming(true), rebuilding, dialog }
}
