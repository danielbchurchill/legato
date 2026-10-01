import { describe, expect, it } from 'vitest'
import { LATEST_RELEASE_URL, updateAction } from './installChannel'

// Issue #110: the exact command each install channel's notice shows. The
// channel strings come from server/src/update/installChannel.ts.
describe('updateAction', () => {
  it('gives each channel its own command', () => {
    expect(updateAction('docker', null)).toEqual({ kind: 'command', command: 'docker compose pull && docker compose up -d' })
    expect(updateAction('script', null)).toEqual({ kind: 'command', command: 'legato update' })
    expect(updateAction('brew', null)).toEqual({ kind: 'command', command: 'brew upgrade legato' })
  })

  it('shows nothing for the desktop app, which defers to the Tauri updater', () => {
    expect(updateAction('desktop', 'https://github.com/danielbchurchill/legato/releases/tag/v0.4.0')).toBeNull()
  })

  it('links to the release for an unknown channel', () => {
    const releaseUrl = 'https://github.com/danielbchurchill/legato/releases/tag/v0.4.0'

    expect(updateAction('unknown', releaseUrl)).toEqual({ kind: 'link', url: releaseUrl })
  })

  it('falls back to the latest-release page with no channel, an unrecognised one, or no release URL', () => {
    expect(updateAction(null, null)).toEqual({ kind: 'link', url: LATEST_RELEASE_URL })
    expect(updateAction('snap', null)).toEqual({ kind: 'link', url: LATEST_RELEASE_URL })
    expect(updateAction('constructor', null)).toEqual({ kind: 'link', url: LATEST_RELEASE_URL })
  })
})
