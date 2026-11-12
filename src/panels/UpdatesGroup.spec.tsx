// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: invokeMock,
}))

import { UpdatesGroup } from './UpdatesGroup'

async function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(createElement(UpdatesGroup))
  })
  return container
}

function updateSwitch(container: HTMLElement) {
  const found = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="check for Legato updates"]')
  if (!found) throw new Error('no update switch')
  return found
}

beforeEach(() => {
  invokeMock.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('UpdatesGroup', () => {
  it('shows the switch as the shell keeps it and saves a change through it', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'update_check_settings' ? { enabled: true, offByEnvironment: false } : undefined,
    )
    const container = await render()
    const check = updateSwitch(container)
    expect(check.getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).toContain('nothing about your library')

    await act(async () => check.click())
    expect(invokeMock).toHaveBeenCalledWith('set_update_check', { enabled: false })
    expect(check.getAttribute('aria-checked')).toBe('false')
  })

  it('leaves the switch where it was and says why when the shell refuses the change', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'update_check_settings') return { enabled: true, offByEnvironment: false }
      throw "couldn't save shell-settings.json: read-only file system"
    })
    const container = await render()
    const check = updateSwitch(container)

    await act(async () => check.click())
    expect(check.getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).toContain('read-only file system')
  })

  it('shows it off and disabled when LEGATO_UPDATE_CHECK=off is set, whatever the switch says', async () => {
    invokeMock.mockResolvedValue({ enabled: true, offByEnvironment: true })
    const container = await render()
    const check = updateSwitch(container)
    expect(check.getAttribute('aria-checked')).toBe('false')
    expect(check.disabled).toBe(true)
    expect(container.textContent).toContain('LEGATO_UPDATE_CHECK=off')
  })
})
