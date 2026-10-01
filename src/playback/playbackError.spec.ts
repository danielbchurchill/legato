import { describe, expect, it } from 'vitest'
import { describePlaybackError, readLibraryRoots, type NativePlaybackError } from './playbackError'

const FILE = '/mnt/music/Music/Artist/Album/01 Song.flac'

function unreachable(nearestFolder: string | null, empty: boolean): NativePlaybackError {
  return {
    kind: 'file_unreachable',
    path: FILE,
    nearest_folder: nearestFolder,
    nearest_folder_empty: empty,
    detail: 'No such file or directory (os error 2)',
  }
}

describe('describePlaybackError', () => {
  // The 2026-09-29 AIO case: the Pi can see its drive, this machine's NFS
  // mount never came up, so /mnt/music is an empty mount point here.
  it('names the root and blames this machine when the root is an empty folder here but reachable on the server', () => {
    const problem = describePlaybackError(unreachable('/mnt/music', true), 'Song', [{ path: '/mnt/music', reachable: true }])

    expect(problem.headline).toBe('The library drive looks disconnected on this machine')
    expect(problem.detail).toContain('Nothing is at /mnt/music')
    expect(problem.detail).toContain('“Song”')
    expect(problem.action).toBe('retry')
  })

  it('treats a root that is missing outright here the same as an empty one', () => {
    const problem = describePlaybackError(unreachable('/mnt', false), 'Song', [{ path: '/mnt/music/', reachable: null }])

    expect(problem.headline).toBe('The library drive looks disconnected on this machine')
    expect(problem.detail).toContain('Nothing is at /mnt/music,')
  })

  it('says the drive itself is disconnected when the server cannot reach the root either', () => {
    const problem = describePlaybackError(unreachable('/mnt/music', true), 'Song', [{ path: '/mnt/music', reachable: false }])

    expect(problem.headline).toBe('The library drive is disconnected')
    expect(problem.detail).toContain("The server can't reach /mnt/music either")
    expect(problem.action).toBe('retry')
  })

  it('blames the one file, and offers skip, when its album folder is still there', () => {
    const problem = describePlaybackError(unreachable('/mnt/music/Music/Artist/Album', false), 'Song', [
      { path: '/mnt/music', reachable: true },
    ])

    expect(problem.headline).toBe("Can't open “Song”")
    expect(problem.detail).toContain(FILE)
    expect(problem.action).toBe('skip')
  })

  // An older server (no libraryRoots), or /health unreachable: the empty
  // nearest folder alone still gives the mount away.
  it('falls back to the empty nearest folder when the server reports no roots', () => {
    const problem = describePlaybackError(unreachable('/mnt/music', true), '', [])

    expect(problem.headline).toBe('The library drive looks disconnected on this machine')
    expect(problem.detail).toContain('Nothing is at /mnt/music, where this track should be')
  })

  it('uses the longest matching root when roots nest', () => {
    const problem = describePlaybackError(unreachable('/mnt/music', false), 'Song', [
      { path: '/mnt', reachable: true },
      { path: '/mnt/music/Music', reachable: false },
    ])

    expect(problem.headline).toBe('The library drive is disconnected')
    expect(problem.detail).toContain('/mnt/music/Music')
  })

  it('explains an undecodable file and offers skip', () => {
    const problem = describePlaybackError({ kind: 'undecodable', path: FILE, detail: 'unsupported' }, 'Song', [])

    expect(problem.headline).toBe("Can't decode “Song”")
    expect(problem.detail).toContain(FILE)
    expect(problem.action).toBe('skip')
  })

  it('explains a missing output device and offers retry', () => {
    const problem = describePlaybackError({ kind: 'no_output_device', detail: 'no default device' }, 'Song', [])

    expect(problem.headline).toBe('No audio output device')
    expect(problem.action).toBe('retry')
  })

  it('still says something for a rejection that is not a PlaybackError', () => {
    const problem = describePlaybackError('session torn down', 'Song', [])

    expect(problem.headline).toBe("Couldn't start “Song”")
    expect(problem.detail).toBe('session torn down')
  })
})

describe('readLibraryRoots', () => {
  it('keeps well-formed roots and drops anything else', () => {
    expect(
      readLibraryRoots({
        libraryRoots: [
          { libraryRootId: 1, path: '/mnt/music', reachable: true },
          { libraryRootId: 2, path: '/srv/more', reachable: null },
          { libraryRootId: 3 },
          'nonsense',
        ],
      }),
    ).toEqual([
      { path: '/mnt/music', reachable: true },
      { path: '/srv/more', reachable: null },
    ])
  })

  it('returns nothing for a server older than #192', () => {
    expect(readLibraryRoots({ status: 'ok' })).toEqual([])
    expect(readLibraryRoots(null)).toEqual([])
  })
})
