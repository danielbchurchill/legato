// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellLayoutContext, computeShellLayout } from '../shell/layout'
import { DIALOG_KEEP } from '../ui/Dialog'
import { AwayNoticeDialog } from './AwayNoticeDialog'
import { noticeRows } from './awayNotice'
import type { AwayNoticeView } from './useAwayNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #412: the away-from-home notice in a desktop browser, a Dialog inside the
// shell with the player above its wash and inside its focus trap.

const roots: Root[] = []

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function view(overrides: Partial<AwayNoticeView> = {}): AwayNoticeView {
  return {
    open: true,
    server: 'raspberrypi',
    rows: noticeRows({ format: 'FLAC', bitrate: 2_900_000, sampleRate: 96000 })!,
    onStandard: vi.fn(),
    onKeep: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

// 1440 wide with both panels open: the stage's centre is 728.
const LAYOUT = computeShellLayout(1440, 1024, { leftOpen: true, rightOpen: true })

async function render(initial: AwayNoticeView) {
  const container = document.createElement('main')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const draw = (v: AwayNoticeView) =>
    act(async () =>
      root.render(
        createElement(
          ShellLayoutContext.Provider,
          { value: LAYOUT },
          createElement(
            Fragment,
            null,
            createElement('nav', { id: 'rail' }, createElement('button', { id: 'opener' }, 'settings')),
            createElement('aside', { id: 'panel' }, createElement('button', null, 'a panel')),
            createElement(AwayNoticeDialog, { view: v }),
            createElement(
              'div',
              { id: 'player', [DIALOG_KEEP]: '' },
              createElement('button', { 'aria-label': 'Previous' }),
              createElement('button', { 'aria-label': 'Pause' }),
              createElement('button', { 'aria-label': 'Next' }),
            ),
          ),
        ),
      ),
    )
  await draw({ ...initial, open: false })
  document.getElementById('opener')!.focus()
  await draw(initial)
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  return { container, draw }
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const named = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)!
const tab = (shift = false) => {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  return event
}

describe('AwayNoticeDialog', () => {
  it('heads with the title, says the body, and draws the GB figure for a 96 kHz file', async () => {
    await render(view())
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent).toBe('Still streaming originals')
    const description = dialog()
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ')
    expect(description).toContain('This device is away from home, and raspberrypi is still sending each track as its original file.')
    expect(description).toContain('original, FLAC 96 kilohertz: about 1.3 gigabytes an hour.')
    expect(dialog().textContent).toContain('originalFLAC 96 kHzabout1.3 GBan hour')
  })

  it('sits in the shell, not over the window, centred on the stage', async () => {
    const { container } = await render(view())
    const overlay = dialog().parentElement!
    expect(overlay.parentElement).toBe(container)
    expect(overlay.className).toContain('absolute')
    expect(overlay.className).toContain('bg-[var(--color-modal-wash)]')
    expect(LAYOUT.cx).toBe(728)
    expect(dialog().style.marginLeft).toBe(`${728 - 210}px`)
  })

  it('leaves the player reachable and everything else inert', async () => {
    const { draw } = await render(view())
    expect(document.getElementById('rail')!.inert).toBe(true)
    expect(document.getElementById('panel')!.inert).toBe(true)
    expect(document.getElementById('player')!.inert).toBeFalsy()
    await draw(view({ open: false }))
    expect(document.getElementById('rail')!.inert).toBe(false)
  })

  it('takes the focus itself; Tab goes close, keep original, standard while away, then the player, and round', async () => {
    await render(view())
    expect(document.activeElement).toBe(dialog())
    const order = [...dialog().querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
    expect(order).toEqual(['Close', 'keep original', 'standard while away'])

    // The browser moves on from the surface's last control to the player by
    // itself; from the player's last, the trap goes back to close.
    named('Next').focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(named('Close'))
    expect(tab(true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(named('Next'))
    named('standard while away').focus()
    expect(tab().defaultPrevented).toBe(false)
  })

  it('closes without choosing on Escape, the × and a press on the wash, and gives the focus back', async () => {
    const v = view()
    const { draw } = await render(v)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    act(() => named('Close').click())
    act(() => dialog().parentElement!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(v.onDismiss).toHaveBeenCalledTimes(3)
    await draw({ ...v, open: false })
    expect(document.activeElement).toBe(document.getElementById('opener'))
  })

  it('offers both choices', async () => {
    const v = view()
    await render(v)
    act(() => named('keep original').click())
    act(() => named('standard while away').click())
    expect(v.onKeep).toHaveBeenCalledOnce()
    expect(v.onStandard).toHaveBeenCalledOnce()
  })
})
