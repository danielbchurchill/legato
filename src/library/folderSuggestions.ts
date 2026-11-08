import { useEffect, useState } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { formatCount } from '../ui/format'

/* First run's suggested folders (issue #132): the folders on the server
 * that look like a music library, each with a quick count, so picking one
 * comes before being asked for a path. The server finds and counts them
 * (server/src/fs/suggest.ts), because it's the server's disks that get
 * scanned; this only fetches and words them. */

export type SuggestionKind = 'apple-music' | 'itunes' | 'music' | 'mount' | 'container'

export type FolderSuggestion = {
  path: string
  kind: SuggestionKind
  audioFiles: number
  /** false when the count stopped at its cap or its time limit. */
  complete: boolean
}

type SuggestionsResponse = { home: string | null; docker: boolean; suggestions: FolderSuggestion[] }

export type FolderSuggestionsState = {
  loading: boolean
  home: string | null
  suggestions: FolderSuggestion[]
}

/* Asked once, when first run shows. Anything but a list (a 403 for someone
 * who isn't the owner, an older server without the route) is no
 * suggestions: first run still has its own button. */
export function useFolderSuggestions(): FolderSuggestionsState {
  const [state, setState] = useState<FolderSuggestionsState>({ loading: true, home: null, suggestions: [] })
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API}/fs/suggestions`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<Partial<SuggestionsResponse>>) : null))
      .catch(() => null)
      .then((body) => {
        if (controller.signal.aborted) return
        setState({
          loading: false,
          home: typeof body?.home === 'string' ? body.home : null,
          suggestions: Array.isArray(body?.suggestions) ? body.suggestions : [],
        })
      })
    return () => controller.abort()
  }, [])
  return state
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** What a folder is called: Music's and iTunes' media folders by the app
 * they belong to, since "Media.localized" says nothing, and every other
 * folder by its own name. */
export function suggestionName(suggestion: FolderSuggestion): string {
  if (suggestion.kind === 'apple-music') return 'Apple Music'
  if (suggestion.kind === 'itunes') return 'iTunes'
  return lastSegment(suggestion.path)
}

/** The path with the server's home as ~, as a shell would write it. Only
 * on a server with Unix paths: ~ isn't how Windows names a profile. */
export function displayPath(path: string, home: string | null): string {
  if (!home || !home.startsWith('/')) return path
  const base = home.endsWith('/') ? home.slice(0, -1) : home
  if (path === base) return '~'
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path
}

/** "about 412" for a count that finished, "1,000+" for one that stopped at
 * its cap or ran out of time, so a floor never reads as a total. */
export function countParts(suggestion: FolderSuggestion): { before: string; number: string; after: string } {
  const unit = suggestion.complete && suggestion.audioFiles === 1 ? 'track' : 'tracks'
  return suggestion.complete
    ? { before: 'about ', number: formatCount(suggestion.audioFiles), after: ` ${unit}` }
    : { before: '', number: `${formatCount(suggestion.audioFiles)}+`, after: ` ${unit}` }
}
