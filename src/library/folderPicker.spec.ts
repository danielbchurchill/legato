import { describe, expect, it, vi } from 'vitest'

vi.mock('../config/runtime', () => ({ IS_TAURI: false }))

const { folderPickerKind } = await import('./folderPicker')

describe('folderPickerKind', () => {
  it('keeps the native dialog for the desktop app on its built-in server', () => {
    expect(folderPickerKind({ isTauri: true, serverHost: '127.0.0.1' })).toBe('native')
    expect(folderPickerKind({ isTauri: true, serverHost: 'localhost' })).toBe('native')
    expect(folderPickerKind({ isTauri: true, serverHost: '[::1]' })).toBe('native')
  })

  it("uses the server's picker when the desktop app talks to a server elsewhere", () => {
    // The Mac pointed at the Pi over Tailscale.
    expect(folderPickerKind({ isTauri: true, serverHost: '100.100.20.30' })).toBe('server')
    expect(folderPickerKind({ isTauri: true, serverHost: 'musicbox' })).toBe('server')
  })

  // A browser has no native folder dialog that reaches a server's disks,
  // even when the server happens to be on the same machine.
  it("always uses the server's picker in a browser", () => {
    expect(folderPickerKind({ isTauri: false, serverHost: '127.0.0.1' })).toBe('server')
    expect(folderPickerKind({ isTauri: false, serverHost: 'musicbox' })).toBe('server')
  })
})
