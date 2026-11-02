import { useCallback, useRef } from 'react'
import { LONG_PRESS_MS, holdBroken } from './queueGestures'

/* Press and hold on a track row, in the phone's track lists (#447): an
 * album's or a person's tracks, the library's tracks tab and search's
 * tracks. A row held still for as long as up next's takes to lift
 * (LONG_PRESS_MS, with the same slop, holdBroken) opens that row's menu; a
 * quick tap still plays it, and a finger that moves first is the list's
 * scroll or the sheet's drag, as before.
 *
 * Rows say they can be held with `data-hold-track` (the track's node id).
 * The listeners sit on the list, not on each row, so a virtualised list's
 * rows can come and go under a finger. Touch events, as up next's are:
 * once the menu is open, the rest of that touch mustn't scroll the list
 * or drag the sheet, and only a non-passive touchmove can stop that. */

type Hold = { id: number; row: HTMLElement; startX: number; startY: number; timer: number; fired: boolean }

/** Listens on `list` for a hold on any of its rows, and calls `onHold`
 * with the row. Returns the function that stops listening. */
export function attachTrackHold(list: HTMLElement, onHold: (row: HTMLElement) => void): () => void {
  let hold: Hold | null = null
  // The click a held row's touchend makes mustn't play it.
  let swallowClicksUntil = 0

  const cancel = () => {
    if (hold) window.clearTimeout(hold.timer)
    hold = null
  }

  const onTouchStart = (e: TouchEvent) => {
    cancel()
    if (e.touches.length !== 1) return
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-hold-track]') : null
    if (!row || !list.contains(row)) return
    const touch = e.touches[0]
    const started: Hold = { id: touch.identifier, row, startX: touch.clientX, startY: touch.clientY, timer: 0, fired: false }
    started.timer = window.setTimeout(() => {
      started.fired = true
      onHold(row)
    }, LONG_PRESS_MS)
    hold = started
  }

  const onTouchMove = (e: TouchEvent) => {
    if (!hold) return
    const touch = [...e.touches].find((t) => t.identifier === hold?.id)
    if (!touch) return
    if (hold.fired) {
      // The menu is open: the list and the sheet stay where they are.
      e.stopPropagation()
      if (e.cancelable) e.preventDefault()
      return
    }
    if (holdBroken(touch.clientX - hold.startX, touch.clientY - hold.startY)) cancel()
  }

  const onTouchEnd = (e: TouchEvent) => {
    if (!hold) return
    if (hold.fired) {
      if (e.cancelable) e.preventDefault()
      swallowClicksUntil = performance.now() + 400
    }
    cancel()
  }

  const onClick = (e: MouseEvent) => {
    if (performance.now() >= swallowClicksUntil) return
    e.preventDefault()
    e.stopPropagation()
  }
  // A held row is the list's, not the system's long-press menu.
  const onContextMenu = (e: Event) => {
    if (hold) e.preventDefault()
  }

  list.addEventListener('touchstart', onTouchStart, { passive: true })
  list.addEventListener('touchmove', onTouchMove, { passive: false })
  list.addEventListener('touchend', onTouchEnd, { passive: false })
  list.addEventListener('touchcancel', onTouchEnd, { passive: false })
  list.addEventListener('click', onClick, true)
  list.addEventListener('contextmenu', onContextMenu)
  return () => {
    cancel()
    list.removeEventListener('touchstart', onTouchStart)
    list.removeEventListener('touchmove', onTouchMove)
    list.removeEventListener('touchend', onTouchEnd)
    list.removeEventListener('touchcancel', onTouchEnd)
    list.removeEventListener('click', onClick, true)
    list.removeEventListener('contextmenu', onContextMenu)
  }
}

/** A callback ref for a track list that opens a row's menu on a hold. */
export function useTrackHold(onHold: (row: HTMLElement) => void): (list: HTMLElement | null) => (() => void) | undefined {
  const latest = useRef(onHold)
  latest.current = onHold
  return useCallback((list: HTMLElement | null) => {
    if (!list) return undefined
    return attachTrackHold(list, (row) => latest.current(row))
  }, [])
}
