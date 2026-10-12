import { useState } from 'react'
import { plural } from '../ui/format'
import { groupResults, useSearchResults, type Group, type Item, type SearchResults } from '../search/searchData'

/* The phone's search (#389, PhoneSearch.tsx): what's typed, and what it
 * finds, grouped in the handoff's order under the top result. */

const GROUP_ORDER = ['release', 'artist', 'recording', 'playlist'] as const

export type PhoneSearchState = {
  query: string
  setQuery: (query: string) => void
  results: SearchResults
  top: Item | null
  groups: Group[]
}

/** The query and what it finds, kept while search is anywhere in the
 * sheet's history, so coming back to it finds what was typed. Asks the
 * server nothing while it's closed. */
export function usePhoneSearch(active: boolean): PhoneSearchState {
  const [query, setQuery] = useState('')
  // Closing search forgets the query: the next search starts empty.
  if (!active && query !== '') setQuery('')
  const results = useSearchResults(query, active)
  const { top, groups } = groupResults(results.items, 'all', GROUP_ORDER)
  return { query, setQuery, results, top, groups }
}

/** Peek, while search is the sheet's view: how much it found. */
export function searchPeekLine(search: PhoneSearchState): string {
  if (!search.query.trim()) return 'Search your library'
  const count = search.results.items.length
  return search.results.hits == null ? 'Searching…' : `${plural(count, 'result')} for “${search.query.trim()}”`
}
