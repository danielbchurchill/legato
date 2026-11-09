import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IS_TAURI } from '../config/runtime'
import { SERVER_ORIGIN } from '../config/serverHost'
import { useWsEvent } from '../hooks/useWs'
import { streamQualitySnapshot, subscribeStreamQuality } from '../playback/quality'
import type { usePlayback } from '../playback/usePlayback'
import { awayFromHome, noticeDue, useAwayFromHome, WHEREABOUTS_EVENT, type AwayQuality, type Whereabouts } from './awayFromHome'
import { ANNOUNCE_KEEP, ANNOUNCE_STANDARD, fileKbps, noticeRows, serverWords, type NoticeRow } from './awayNotice'
import { readLastSeen } from './lastSeen'

/* The away-from-home notice (#412) as either layout draws it: whether it's
 * open, what it says, and what its controls do. It reads the server's answer
 * (awayFromHome.ts's store, fed from the WebSocket here), the playing track
 * and its stream, the page's visibility, and whether anything it waits for
 * is going on, and opens on the first frame where the rule says so.
 *
 * Never in the desktop app, which plays files from disk. */

type Playback = ReturnType<typeof usePlayback>

export type AwayNoticeView = {
  open: boolean
  /** The server's own name, else "your server". */
  server: string
  rows: NoticeRow[]
  /** standard while away. */
  onStandard: () => void
  /** keep original. */
  onKeep: () => void
  /** Closed without choosing: the ×, Escape, back, a swipe or the wash. */
  onDismiss: () => void
}

const WHEREABOUTS: readonly Whereabouts[] = ['home', 'away', 'unknown']

/** Feeds the server's home/away answer for this device into the store. The
 * server sends it as the socket connects and whenever it changes. */
export function useWhereaboutsFeed(): void {
  useWsEvent(IS_TAURI ? [] : [WHEREABOUTS_EVENT], (payload) => {
    const where = (payload as { where?: unknown } | undefined)?.where
    const known = WHEREABOUTS.find((w) => w === where)
    if (known) awayFromHome.setWhereabouts(known)
  })
}

/* ---- What the notice waits for ------------------------------------------ */

// Pointers held down right now: a drag of the sheet or the map, a held row.
const pressed = new Set<number>()
let tracking = false

function trackPresses() {
  if (tracking || typeof window === 'undefined') return
  tracking = true
  const down = (e: PointerEvent) => pressed.add(e.pointerId)
  const up = (e: PointerEvent) => pressed.delete(e.pointerId)
  window.addEventListener('pointerdown', down, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  // A press the page never sees end (the app switched away mid-drag).
  window.addEventListener('blur', () => pressed.clear())
}

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

// What's open that the notice waits for: a menu, a picker or a select (its
// trigger says it's expanded, or its list is up), an AlertDialog, another
// dialog, the desktop's search palette, the connect screen. Not now playing
// on the phone, which the notice goes over.
const OPEN_ELSEWHERE = [
  '[aria-haspopup][aria-expanded="true"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="alertdialog"]',
  '[data-connect-screen]',
  '[role="dialog"][aria-modal="true"]:not([data-now-playing])',
].join(', ')

/** Whether something the notice waits for is going on now. */
export function interruptedNow(doc: Document = document, held: number = pressed.size): boolean {
  if (held > 0) return true
  const el = doc.activeElement
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type)) return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return doc.querySelector(OPEN_ELSEWHERE) != null
}

// A menu closing changes nothing the events below hear, so it's looked at
// this often too, while the notice is waiting.
const WAIT_CHECK_MS = 400

/** Whether the notice has to wait, looked at while `waiting`. */
function useInterrupted(waiting: boolean): boolean {
  const [interrupted, setInterrupted] = useState(false)
  useEffect(() => {
    trackPresses()
  }, [])
  useEffect(() => {
    if (!waiting) return
    // After the event's own handlers, so a press that ends a drag counts
    // as ended.
    const check = () => setTimeout(() => setInterrupted(interruptedNow()), 0)
    const events = ['pointerup', 'pointercancel', 'focusin', 'focusout', 'keyup', 'click'] as const
    for (const event of events) window.addEventListener(event, check, true)
    const timer = setInterval(check, WAIT_CHECK_MS)
    check()
    return () => {
      for (const event of events) window.removeEventListener(event, check, true)
      clearInterval(timer)
    }
  }, [waiting])
  return waiting && interrupted
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

const pageVisible = () => document.visibilityState === 'visible'

/* ---- The notice ---------------------------------------------------------- */

/** What NoticeAnnouncer (AwayNoticeParts.tsx) says, and what sets it. The
 * same message twice is read twice: it's cleared first, then set on the
 * next frame. */
export function useNoticeAnnouncement(): [string, (message: string) => void] {
  const [message, setMessage] = useState('')
  const announce = useCallback((next: string) => {
    setMessage('')
    requestAnimationFrame(() => setMessage(next))
  }, [])
  return [message, announce]
}

/** The notice's state and its actions, or null where it never shows (the
 * desktop app). `announce` says each choice in a polite live region. */
export function useAwayNotice(playback: Playback, announce: (message: string) => void): AwayNoticeView | null {
  const away = useAwayFromHome()
  const stream = useSyncExternalStore(subscribeStreamQuality, streamQualitySnapshot)
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, () => true)

  const fileId = playback.status.currentFileId
  const file = playback.playingFile
  const streamingOriginal = !IS_TAURI && fileId != null && stream.last?.fileId === fileId && stream.last.quality === 'original'
  const kbps = file ? fileKbps(file) : null

  const rule = { quality: away.quality, trip: away.trip, snoozedOn: away.snoozedOn, streamingOriginal, kbps, visible }
  // Everything else holds: only now does what it waits for matter.
  const waiting = !away.open && noticeDue({ ...rule, interrupted: false })
  const interrupted = useInterrupted(waiting)
  const due = waiting && !interrupted

  // On the first frame where it's due: after a return from the lock screen,
  // the first frame the page draws.
  // The waits are looked at again on that frame: a press can begin between
  // the last look and it.
  useEffect(() => {
    if (!due) return
    let frame = 0
    const attempt = () => {
      frame = requestAnimationFrame(() => {
        if (interruptedNow()) attempt()
        else awayFromHome.showNotice()
      })
    }
    attempt()
    return () => cancelAnimationFrame(frame)
  }, [due])

  // What it said last, so it doesn't change or empty as it closes, or if
  // the track ends while it's open.
  const rows = file ? noticeRows(file) : null
  const shown = useRef<NoticeRow[]>([])
  if (rows && (away.open || due)) shown.current = rows

  const choose = useCallback(
    (quality: AwayQuality) => {
      awayFromHome.setQuality(quality)
      announce(quality === 'standard' ? ANNOUNCE_STANDARD : ANNOUNCE_KEEP)
    },
    [announce],
  )
  const onStandard = useCallback(() => choose('standard'), [choose])
  const onKeep = useCallback(() => choose('same'), [choose])

  if (IS_TAURI) return null
  return {
    open: away.open,
    server: serverWords(readLastSeen(SERVER_ORIGIN)?.name),
    rows: shown.current,
    onStandard,
    onKeep,
    onDismiss: awayFromHome.dismissNotice,
  }
}
