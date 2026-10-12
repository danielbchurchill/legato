// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorklistKind } from '../shell/panels'
import { useTouchLayout } from '../ui/touchLayout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The pages' own content has its own specs; here each says what it was
// given, and whether it's laid out for a finger.
const opened = vi.hoisted(() => ({
  list: null as null | ((list: string, field?: string) => void),
  focus: null as null | ((id: number) => void),
}))
vi.mock('./SettingsPage', () => ({ SettingsPage: () => createElement('p', null, `settings page, touch ${String(useTouchLayout())}`) }))
vi.mock('./HealthPage', () => ({
  HealthPage: ({ onOpen }: { onOpen: (list: string, field?: string) => void }) => {
    opened.list = onOpen
    return createElement('p', null, 'health page')
  },
}))
vi.mock('../panels/Worklists', () => ({
  Worklist: ({
    kind,
    gapField,
    onBack,
    onFocusNode,
  }: {
    kind: WorklistKind
    gapField: string
    onBack?: () => void
    onFocusNode: (id: number) => void
  }) => {
    opened.focus = onFocusNode
    return createElement('p', null, `worklist ${kind} on ${gapField}${onBack ? ' with its own back' : ''}`)
  },
}))

import { PhonePages } from './PhonePages'
import { pushPhonePage, usePhonePages } from './navigation'
import type { PhonePlatform } from './phoneLayout'

const roots: Root[] = []
let stack: readonly string[] = []

function Probe() {
  stack = usePhonePages()
  return null
}

function render(platform: PhonePlatform, onShowOnMap = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const props = {
    platform,
    settings: {},
    updateSettings: async () => undefined,
    themePreference: 'dark' as const,
    onSetThemePreference: () => undefined,
    onShowOnMap,
  }
  act(() => root.render(createElement('div', null, createElement(Probe), createElement(PhonePages, props))))
  return { container, onShowOnMap }
}

async function popped() {
  await act(async () => {
    await new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }))
  })
}

beforeEach(() => {
  history.replaceState(null, '')
  opened.list = null
  opened.focus = null
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ''
})

const backButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-label^="Back to"]')!

describe('pushed pages on the phone', () => {
  it('draws nothing on the map', () => {
    const { container } = render('ios')
    expect(container.querySelector('section')).toBeNull()
  })

  it('on iOS, gives Settings a large title under a back labelled with the map, and lays it out for a finger', () => {
    const { container } = render('ios')
    act(() => pushPhonePage('settings'))
    const headings = [...container.querySelectorAll('h1')]
    expect(headings.map((h) => [h.textContent, h.className.includes('text-[34px]')])).toEqual([['Settings', true]])
    expect(backButton(container).textContent).toBe('Map')
    expect(container.textContent).toContain('settings page, touch true')
  })

  it('on iOS, titles a page in the bar, with the page under it as the back', () => {
    const { container } = render('ios')
    act(() => pushPhonePage('settings'))
    act(() => pushPhonePage('health'))
    expect(container.querySelector('header h1')?.textContent).toBe('Library health')
    expect(backButton(container).textContent).toBe('Settings')
    expect(backButton(container).getAttribute('aria-label')).toBe('Back to Settings')
  })

  it("on Android, has a 64px app bar with the back arrow and the page's title", () => {
    const { container } = render('android')
    act(() => pushPhonePage('settings'))
    const bar = container.querySelector('header')!
    expect(bar.className).toContain('h-[64px]')
    expect(bar.querySelector('h1')?.textContent).toBe('Settings')
    expect(backButton(container).querySelector('svg')).not.toBeNull()
    expect(backButton(container).className).toContain('size-[48px]')
  })

  it('pops the page with its own back', async () => {
    const { container } = render('android')
    act(() => pushPhonePage('settings'))
    act(() => pushPhonePage('health'))
    const back = popped()
    act(() => backButton(container).click())
    await back
    expect(stack).toEqual(['settings'])
  })

  it("pushes each of health's lists as its own page, without the desktop's back row", () => {
    const { container } = render('ios')
    act(() => pushPhonePage('health'))
    act(() => opened.list!('gaps', 'bpm'))
    expect(stack).toEqual(['health', 'worklist:gaps'])
    expect(container.querySelector('header h1')?.textContent).toBe('Metadata gaps')
    expect(container.textContent).toContain('worklist gaps on bpm')
    expect(container.textContent).not.toContain('with its own back')
  })

  it('closes every page when a list shows something on the map', async () => {
    const { onShowOnMap } = render('ios')
    act(() => pushPhonePage('settings'))
    act(() => pushPhonePage('health'))
    act(() => pushPhonePage('worklist:missing'))
    const back = popped()
    act(() => opened.focus!(42))
    await back
    expect(onShowOnMap).toHaveBeenCalledWith(42)
    expect(stack).toEqual([])
  })
})
