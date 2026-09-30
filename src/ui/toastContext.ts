import { createContext, useContext, type ReactNode } from 'react'

/* The toast queue's context, split from Toast.tsx so that file exports only
 * components (react/only-export-components, .oxlintrc.json). */

export type ToastInput = {
  title: string
  description?: ReactNode
  /** One follow-up action — "undo", "show". Clicking it also dismisses. */
  action?: { label: string; onClick: () => void }
  /** ms before it dismisses itself; `null` to stay until closed. */
  duration?: number | null
}

export type ToastApi = {
  show: (toast: ToastInput) => number
  dismiss: (id: number) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api == null) throw new Error('useToast() called outside <ToastProvider> — mount one near the app root (App.tsx)')
  return api
}
