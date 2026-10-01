// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: invokeMock,
}))

import { ServingGroup } from './ServingGroup'

async function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(createElement(ServingGroup))
  })
  return container
}

function switchNamed(container: HTMLElement, name: string) {
  const found = container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)
  if (!found) throw new Error(`no switch named "${name}"`)
  return found
}

beforeEach(() => {
  invokeMock.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ServingGroup', () => {
  it('shows what the shell reports and saves a change through it', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'serving_settings' ? { launchAtLogin: false, keepAwake: false, keepAwakeAvailable: true } : undefined,
    )
    const container = await render()
    const awake = switchNamed(container, 'keep this computer awake while serving')
    expect(awake.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('costs battery')

    await act(async () => awake.click())
    expect(invokeMock).toHaveBeenCalledWith('set_keep_awake', { enabled: true })
    expect(awake.getAttribute('aria-checked')).toBe('true')
  })

  it("leaves a switch off and says why when the shell refuses the change", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'serving_settings') return { launchAtLogin: false, keepAwake: false, keepAwakeAvailable: true }
      throw 'login items are disabled by policy'
    })
    const container = await render()
    const login = switchNamed(container, 'open Legato when you log in')

    await act(async () => login.click())
    expect(login.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('login items are disabled by policy')
  })

  it('disables keep-awake where the machine has no way to hold it', async () => {
    invokeMock.mockResolvedValue({ launchAtLogin: true, keepAwake: false, keepAwakeAvailable: false })
    const container = await render()
    expect(switchNamed(container, 'keep this computer awake while serving').disabled).toBe(true)
    expect(container.textContent).toContain('systemd-inhibit')
  })
})
