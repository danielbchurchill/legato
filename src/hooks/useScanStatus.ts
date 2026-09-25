import { useEffect, useState } from 'react'
import { useWsEvent } from './useWs'
import { SERVER_HOST } from '../config/serverHost'

const API = `http://${SERVER_HOST}:8899/api/v1`

type ScanJob = {
  status: 'running' | 'paused' | 'canceled' | 'done' | 'error'
  error_message: string | null
}
type ScanStatus = { scanning: boolean; error: string | null }

// The canvas's "why is this empty" signal — DESIGN.md's empty-state
// catalogue splits "scan running, no nodes yet" from "scan failed" from a
// plain empty library, and all three need to be told apart from one
// number (nodes.length === 0) plus this. Global across every library root
// rather than per-root: the canvas shows one graph, not one per root, so
// "is anything explaining the empty graph happening right now" is
// necessarily a single answer too.
export function useScanStatus(): ScanStatus & { retry: () => void } {
  const [status, setStatus] = useState<ScanStatus>({ scanning: false, error: null })

  const checkLatest = () => {
    fetch(`${API}/scan-jobs`)
      .then((r) => r.json())
      .then((jobs: ScanJob[]) => {
        const latest = jobs[0]
        if (!latest) {
          setStatus({ scanning: false, error: null })
          return
        }
        setStatus({
          scanning: latest.status === 'running',
          error: latest.status === 'error' ? (latest.error_message ?? 'scan failed') : null,
        })
      })
      .catch(() => undefined)
  }

  useEffect(checkLatest, [])
  useWsEvent(['scan:progress'], () => setStatus({ scanning: true, error: null }))
  // Issue #123: a paused or canceled run also stops without ever reaching
  // scan:done (that event means the pipeline actually finished) — without
  // this, the canvas's "scan running, no nodes yet" empty state would stay
  // stuck showing forever after a pause.
  useWsEvent(['scan:done', 'scan:paused', 'scan:canceled'], () => setStatus({ scanning: false, error: null }))
  useWsEvent(['scan:error'], (payload) => {
    const p = payload as { error: string }
    setStatus({ scanning: false, error: p.error })
  })

  const retry = () => {
    setStatus((s) => ({ ...s, error: null }))
    fetch(`${API}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(
      () => undefined,
    )
  }

  return { ...status, retry }
}
