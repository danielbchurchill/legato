import { describe, expect, it } from 'vitest'
import { shouldRegisterShellWorker } from './register'

const servedPage = { prod: true, isTauri: false, servedByServer: true, supported: true }

describe('shouldRegisterShellWorker', () => {
  it('registers on a production page a Legato server handed out', () => {
    expect(shouldRegisterShellWorker(servedPage)).toBe(true)
  })

  it('never registers inside Tauri, whose storage bucket other unsigned apps can share', () => {
    expect(shouldRegisterShellWorker({ ...servedPage, isTauri: true })).toBe(false)
  })

  it('never registers under Vite dev', () => {
    expect(shouldRegisterShellWorker({ ...servedPage, prod: false })).toBe(false)
  })

  it('never registers on a page no Legato server served (a Tauri bundle, vite preview)', () => {
    expect(shouldRegisterShellWorker({ ...servedPage, servedByServer: false })).toBe(false)
  })

  it('does nothing where service workers do not exist (plain http off localhost)', () => {
    expect(shouldRegisterShellWorker({ ...servedPage, supported: false })).toBe(false)
  })
})
