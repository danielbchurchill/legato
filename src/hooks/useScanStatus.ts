import { useEffect, useState } from 'react'
import { useWsEvent } from './useWs'
import { API_BASE as API } from '../config/serverHost'
import { noteLatestScan, useReconnectEpoch } from '../connect/reconnect'

type ScanJob = {
  id: number
  status: 'running' | 'paused' | 'canceled' | 'done' | 'error'
  error_message: string | null
}
type ScanStatus = { scanning: boolean; error: string | null }

/* The scan:progress payload (server/src/scan/scanner.ts's ScanProgress), the
 * fields the map's first-scan card reads. */
export type ScanStage = 'discover' | 'read_tags' | 'match' | 'collapse' | 'layout' | 'enrich_queued'
export type ScanProgress = { stage: ScanStage; filesScanned: number; filesTotal: number }

// The canvas's "why is this empty" signal — DESIGN.md's empty-state
// catalogue splits "scan running, no nodes yet" from "scan failed" from a
// plain empty library, and all three need to be told apart from one
// number (nodes.length === 0) plus this. Global across every library root
// rather than per-root: the canvas shows one graph, not one per root, so
// "is anything explaining the empty graph happening right now" is
// necessarily a single answer too.
export function useScanStatus(): ScanStatus & { retry: () => void; progress: ScanProgress | null; firstScan: boolean } {
  const [status, setStatus] = useState<ScanStatus>({ scanning: false, error: null })
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  // A library whose scans have never once finished is still being built for
  // the first time: the map shows what's matched so far under a progress
  // card, rather than presenting a half-drawn map as the whole library.
  const [firstScan, setFirstScan] = useState(false)

  const checkLatest = () => {
    fetch(`${API}/scan-jobs`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`scan-jobs returned ${r.status}`))))
      .then((jobs: ScanJob[]) => {
        const latest = jobs[0]
        noteLatestScan(latest ?? null)
        setFirstScan(!jobs.some((job) => job.status === 'done'))
        // Progress is only ever for a run under way. A run the server's
        // restart stopped (it's paused now), or one that ended while its
        // events had nowhere to go (#119), leaves none.
        if (latest?.status !== 'running') setProgress(null)
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

  // Again after an outage (#119): a scan that started, finished or failed
  // meanwhile sent its event to a socket that wasn't there.
  const reconnects = useReconnectEpoch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(checkLatest, [reconnects])
  // Each event also keeps the latest scan job reconnect.ts compares against
  // after an outage, so one that ran its course while this client listened
  // isn't taken for news (#119). A pause and a cancel share one handler (and
  // one socket), so either is noted as "stopped", which no job on the server
  // reads as: the next outage reads everything again, to be safe.
  const noteJob = (payload: unknown, status: ScanJob['status'] | 'stopped') => {
    const jobId = (payload as { jobId?: number | null } | undefined)?.jobId
    if (typeof jobId === 'number') noteLatestScan({ id: jobId, status })
  }
  useWsEvent(['scan:progress'], (payload) => {
    noteJob(payload, 'running')
    setStatus({ scanning: true, error: null })
    setProgress(payload as ScanProgress)
  })
  useWsEvent(['scan:done'], (payload) => {
    noteJob(payload, 'done')
    setStatus({ scanning: false, error: null })
    setProgress(null)
    setFirstScan(false)
  })
  // Issue #123: a paused or canceled run also stops without ever reaching
  // scan:done (that event means the pipeline actually finished) — without
  // this, the canvas's "scan running, no nodes yet" empty state would stay
  // stuck showing forever after a pause.
  useWsEvent(['scan:paused', 'scan:canceled'], (payload) => {
    noteJob(payload, 'stopped')
    setStatus({ scanning: false, error: null })
  })
  useWsEvent(['scan:error'], (payload) => {
    noteJob(payload, 'error')
    const p = payload as { error: string }
    setStatus({ scanning: false, error: p.error })
  })

  const retry = () => {
    setStatus((s) => ({ ...s, error: null }))
    fetch(`${API}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(
      () => undefined,
    )
  }

  return { ...status, retry, progress, firstScan }
}
