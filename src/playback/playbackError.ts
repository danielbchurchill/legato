// Turns a native playback failure (src-tauri/src/playback.rs's
// PlaybackError, the rejection value of queue_enqueue) into what the
// transport says about it. Issue #184: before this, a dropped NFS mount
// meant every play button silently did nothing, with the reason printed
// only to the `npx tauri dev` terminal.

// Mirrors PlaybackError's serde shape — `kind`-tagged, snake_case fields.
// playback.rs's playback_error_serializes_as_a_kind_tagged_object test pins
// the Rust side of this contract.
export type NativePlaybackError =
  | {
      kind: 'file_unreachable'
      path: string
      nearest_folder: string | null
      nearest_folder_empty: boolean
      detail: string
    }
  | { kind: 'undecodable'; path: string; detail: string }
  | { kind: 'no_output_device'; detail: string }

/** One entry of GET /api/v1/health's libraryRoots (#192) — the server's own
 * last-known view of each watched root. `reachable` is null until the
 * server has checked. */
export type LibraryRootReachability = { path: string; reachable: boolean | null }

/** What the transport shows (H9): what happened, why, and one action.
 * `retry` replays the same track; `skip` moves past it. */
export type PlaybackProblem = {
  headline: string
  detail: string
  action: 'retry' | 'skip'
}

export function isNativePlaybackError(value: unknown): value is NativePlaybackError {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'file_unreachable' || kind === 'undecodable' || kind === 'no_output_device'
}

// Reads libraryRoots out of a /health body without trusting its shape — a
// server older than #192 has no such field, and that just means there's
// nothing to compare against, not an error.
export function readLibraryRoots(body: unknown): LibraryRootReachability[] {
  const roots = typeof body === 'object' && body !== null ? (body as { libraryRoots?: unknown }).libraryRoots : null
  if (!Array.isArray(roots)) return []
  return roots.flatMap((root) => {
    if (typeof root !== 'object' || root === null) return []
    const { path, reachable } = root as { path?: unknown; reachable?: unknown }
    if (typeof path !== 'string') return []
    return [{ path, reachable: typeof reachable === 'boolean' ? reachable : null }]
  })
}

function trimSeparator(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, '') : path
}

// True when `path` is `folder` itself or anywhere beneath it. Both
// separators count, so a Windows client of a Windows server works the same.
function isWithin(path: string, folder: string): boolean {
  const base = trimSeparator(folder)
  if (path === base) return true
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
}

function parentFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : path
}

function quoted(title: string): string {
  return title ? `“${title}”` : 'this track'
}

// The library root a file path belongs to, from the server's own list. The
// paths in the database are the ones that server scanned, so a plain prefix
// match is the right test, and the longest match wins for nested roots.
function rootFor(path: string, roots: LibraryRootReachability[]): LibraryRootReachability | null {
  return roots.filter((root) => isWithin(path, root.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null
}

function describeUnreachable(
  error: Extract<NativePlaybackError, { kind: 'file_unreachable' }>,
  title: string,
  roots: LibraryRootReachability[],
): PlaybackProblem {
  const root = rootFor(error.path, roots)

  // The server can't see the drive either, so it isn't this machine's
  // mount that's at fault. Reconnecting the drive itself is the fix.
  if (root?.reachable === false) {
    return {
      headline: 'The library drive is disconnected',
      detail: `The server can't reach ${root.path} either, so ${quoted(title)} can't play. Reconnect the drive, then try again.`,
      action: 'retry',
    }
  }

  // The server can (or hasn't said it can't), but this machine sees no
  // library where it should be: the root is missing outright, or it's an
  // empty directory, which is what an unmounted mount point looks like.
  // Without a root to compare against, an empty nearest folder is still
  // the tell — real library folders aren't empty.
  const folder = error.nearest_folder
  const libraryAbsentHere = root
    ? folder === null || !isWithin(folder, root.path) || (trimSeparator(folder) === trimSeparator(root.path) && error.nearest_folder_empty)
    : folder === null || error.nearest_folder_empty
  if (libraryAbsentHere) {
    const expected = root ? trimSeparator(root.path) : (folder ?? parentFolder(error.path))
    return {
      headline: 'The library drive looks disconnected on this machine',
      detail: `Nothing is at ${expected}, where ${quoted(title)} should be. Reconnect or mount the drive, then try again.`,
      action: 'retry',
    }
  }

  // The rest of the library is here, so it's this one file.
  return {
    headline: `Can't open ${quoted(title)}`,
    detail: `${error.path} is missing or can't be read. If it was moved or deleted, a rescan will update the library.`,
    action: 'skip',
  }
}

export function describePlaybackError(error: unknown, title: string, roots: LibraryRootReachability[]): PlaybackProblem {
  if (!isNativePlaybackError(error)) {
    // An older or unexpected rejection (a plain string from some other
    // command). Still better said than swallowed.
    return {
      headline: `Couldn't start ${quoted(title)}`,
      detail: String(error),
      action: 'retry',
    }
  }
  switch (error.kind) {
    case 'file_unreachable':
      return describeUnreachable(error, title, roots)
    case 'undecodable':
      return {
        headline: `Can't decode ${quoted(title)}`,
        detail: `${error.path} opened, but it isn't audio Legato can read. The file may be damaged.`,
        action: 'skip',
      }
    case 'no_output_device':
      return {
        headline: 'No audio output device',
        detail: "Legato couldn't open any speaker or headphone output. Connect one, then try again.",
        action: 'retry',
      }
  }
}
