import { describe, expect, it, vi } from 'vitest'

vi.mock('../config/runtime', () => ({ IS_TAURI: false }))

const { folderPickerKind, isLoopbackHost } = await import('./folderPicker')

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

describe('isLoopbackHost', () => {
  it('knows the whole 127/8 block, not just 127.0.0.1', () => {
    expect(isLoopbackHost('127.0.1.1')).toBe(true)
  })

  it("doesn't mistake a name that only starts like one", () => {
    expect(isLoopbackHost('127.0.0.1.example.com')).toBe(false)
    expect(isLoopbackHost('localhost.lan')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })
})
