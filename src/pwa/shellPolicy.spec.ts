import { describe, expect, it } from 'vitest'
import {
  OFFLINE_SHELL_MARKER,
  isNeverCached,
  markOfflineShell,
  routeRequest,
  selectShellFiles,
  shellCacheName,
  staleShellCaches,
  type RequestLike,
} from './shellPolicy'

const ORIGIN = 'http://127.0.0.1:8905'
const SHELL = new Set(['/index.html', '/assets/index-abc123.js', '/assets/index-def456.css', '/manifest.webmanifest'])

function request(path: string, overrides: Partial<RequestLike> & { range?: boolean } = {}): RequestLike {
  const { range, ...rest } = overrides
  return {
    method: 'GET',
    url: path.startsWith('http') ? path : `${ORIGIN}${path}`,
    mode: 'cors',
    destination: '',
    headers: { has: (name) => range === true && name.toLowerCase() === 'range' },
    ...rest,
  }
}

const route = (path: string, overrides?: Parameters<typeof request>[1]) => routeRequest(request(path, overrides), ORIGIN, SHELL)

describe('routeRequest: what the worker never answers', () => {
  it.each([
    '/api/v1/nodes',
    '/api/v1/health',
    '/api/v1/queue/resolve',
    '/api/v1/files/12/stream?quality=original&t=ticket',
    '/api/v1/nodes/12/cover?size=thumb&t=ticket',
    '/api/v1/ws?t=ticket',
    '/covers/0123abcd',
    '/api',
    '/covers',
  ])('lets %s through to the network', (path) => {
    expect(route(path)).toBe('passthrough')
  })

  it('lets an API page load through, so an OAuth callback reaches the server', () => {
    expect(route('/api/v1/auth/google/callback?code=x', { mode: 'navigate', destination: 'document' })).toBe(
      'passthrough',
    )
  })

  it('never answers an audio request, a range request, or anything carrying a media ticket', () => {
    expect(route('/assets/index-abc123.js', { destination: 'audio' })).toBe('passthrough')
    expect(route('/assets/index-abc123.js', { range: true })).toBe('passthrough')
    expect(route('/assets/index-abc123.js?t=ticket')).toBe('passthrough')
  })

  it('leaves non-GET requests and other origins alone', () => {
    expect(route('/index.html', { method: 'POST' })).toBe('passthrough')
    expect(route('https://coverartarchive.org/release/x/front')).toBe('passthrough')
  })

  it('leaves a same-origin file that is not part of this build alone', () => {
    expect(route('/assets/index-old999.js')).toBe('passthrough')
    expect(route('/tracks')).toBe('passthrough')
  })

  it('treats a shell path with a query string as something else', () => {
    expect(route('/assets/index-abc123.js?v=2')).toBe('passthrough')
  })
})

describe('routeRequest: what the worker does answer', () => {
  it('serves a file from this build out of the cache', () => {
    expect(route('/assets/index-abc123.js')).toBe('shell')
    expect(route('/manifest.webmanifest')).toBe('shell')
  })

  it('handles page loads outside the API, network first', () => {
    expect(route('/', { mode: 'navigate', destination: 'document' })).toBe('navigate')
    expect(route('/some/deep/link', { mode: 'navigate', destination: 'document' })).toBe('navigate')
  })
})

describe('selectShellFiles', () => {
  it('takes the build output minus the worker and source maps, as URL paths', () => {
    expect(
      selectShellFiles(['index.html', 'sw.js', 'assets/index-abc.js', 'assets/index-abc.js.map', 'icons/icon-192.png']),
    ).toEqual(['/assets/index-abc.js', '/icons/icon-192.png', '/index.html'])
  })

  it('never lists anything under an API prefix, even if a build put it there', () => {
    expect(selectShellFiles(['index.html', 'api/v1/nodes', 'covers/abc.jpg'])).toEqual(['/index.html'])
  })

  it('always includes index.html, which an offline launch falls back to', () => {
    expect(selectShellFiles(['assets/a.js'])).toEqual(['/assets/a.js', '/index.html'])
  })
})

describe('isNeverCached', () => {
  it('matches the prefixes as path segments, not as text', () => {
    expect(isNeverCached('/api/v1/x')).toBe(true)
    expect(isNeverCached('/apiary.png')).toBe(false)
    expect(isNeverCached('/coversheet.css')).toBe(false)
  })
})

describe('markOfflineShell', () => {
  it('adds the marker inside <head>, next to the server marker already there', () => {
    const html = '<html><head><meta name="legato-server" content="same-origin"></head><body></body></html>'
    const marked = markOfflineShell(html)
    expect(marked).toContain(`${OFFLINE_SHELL_MARKER}</head>`)
    expect(marked).toContain('legato-server')
  })
})

describe('staleShellCaches', () => {
  it('drops every older shell version and nothing that is not ours', () => {
    const names = [shellCacheName('old1'), shellCacheName('current'), 'someone-elses-cache', shellCacheName('old2')]
    expect(staleShellCaches(names, 'current')).toEqual([shellCacheName('old1'), shellCacheName('old2')])
  })
})
