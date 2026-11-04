// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountUser } from '../auth/accountContext'
import { Rail } from './Rail'
import type { RailItem } from './panels'

/* #470: the avatar at the rail's foot opens the Account panel, and shows
 * the user's picture, or their initials when there isn't one. */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAM: AccountUser = { id: 1, role: 'owner', provider: 'local', displayName: 'Sam Rivera', email: null, picture: null }

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

async function render(account: AccountUser | null, active: RailItem | null = null) {
  const onToggle = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(Rail, { active, onToggle, theme: 'dark', account, accountLabel: 'Sam Rivera' })))
  const avatar = container.querySelector<HTMLButtonElement>('button[aria-label="Account: Sam Rivera"]')!
  return { avatar, onToggle }
}

describe("the rail's avatar", () => {
  it('opens the Account panel, not Settings', async () => {
    const { avatar, onToggle } = await render(SAM)
    act(() => avatar.click())
    expect(onToggle).toHaveBeenCalledWith('account')
  })

  it('is lit while the Account panel is open', async () => {
    expect((await render(SAM)).avatar.getAttribute('aria-pressed')).toBe('false')
    expect((await render(SAM, 'account')).avatar.getAttribute('aria-pressed')).toBe('true')
    expect((await render(SAM, 'settings')).avatar.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows the picture, else the initials', async () => {
    const initials = (await render(SAM)).avatar
    expect(initials.textContent).toBe('SR')
    expect(initials.querySelector('img')).toBeNull()

    const pictured = (await render({ ...SAM, picture: { hash: 'cd'.repeat(20), source: 'legato' } })).avatar
    expect(pictured.querySelector('img')!.getAttribute('src')).toContain(`/account/pictures/${'cd'.repeat(20)}`)
  })

  it('follows a new name', async () => {
    expect((await render({ ...SAM, displayName: 'Ada' })).avatar.textContent).toBe('AD')
  })
})
