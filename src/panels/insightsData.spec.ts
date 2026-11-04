import { describe, expect, it } from 'vitest'
import { RAIL_ITEMS, railOwner } from '../shell/panels'
import { cardsWithSomethingToSay, peakDecade, roleWords, stepWords, webLine, type ReadyInsights } from './insightsData'

describe('webLine', () => {
  it('says how much of the library is one web', () => {
    expect(webLine({ artists: 8, connected: 6, largest: 6, groups: 1 })).toBe(
      '6 of your 8 artists connect to each other through the people and tracks they share.',
    )
    expect(webLine({ artists: 8, connected: 8, largest: 8, groups: 1 })).toBe(
      'All 8 of your artists connect to each other through the people and tracks they share.',
    )
    expect(webLine({ artists: 29, connected: 25, largest: 21, groups: 3 })).toBe(
      '25 of your 29 artists connect through the people and tracks they share, in 3 separate webs. The biggest has 21.',
    )
  })

  it('says nothing is joined yet, and nothing for a library of one', () => {
    expect(webLine({ artists: 8, connected: 0, largest: 0, groups: 0 })).toContain('None of your 8 artists share anyone yet')
    expect(webLine({ artists: 1, connected: 0, largest: 0, groups: 0 })).toBeNull()
  })
})

describe('stepWords', () => {
  it('reads each step the way it is walked', () => {
    expect(stepWords({ kind: 'member', artistFirst: true, weight: 1 })).toBe('has as a member')
    expect(stepWords({ kind: 'member', artistFirst: false, weight: 1 })).toBe('is a member of')
    expect(stepWords({ kind: 'group', artistFirst: true, weight: 1 })).toBe('is a member of')
    expect(stepWords({ kind: 'producer', artistFirst: true, weight: 3 })).toBe('was produced by')
    expect(stepWords({ kind: 'producer', artistFirst: false, weight: 3 })).toBe('produced')
    expect(stepWords({ kind: 'with', artistFirst: true, weight: 1 })).toBe('is on a track with')
    expect(stepWords({ kind: 'with', artistFirst: false, weight: 2 })).toBe('is on 2 tracks with')
    expect(stepWords({ kind: 'label', artistFirst: true, weight: 1 })).toBe('is on the label')
    expect(stepWords({ kind: 'label', artistFirst: false, weight: 1 })).toBe('also put out')
  })
})

describe('roleWords', () => {
  it('names roles in plain words', () => {
    expect(roleWords(['member', 'producer', 'performer'])).toBe('member, producer, session player')
  })
})

describe('peakDecade', () => {
  it('finds the decade with the most albums, and its share', () => {
    expect(
      peakDecade([
        { decade: 1960, albums: 2 },
        { decade: 1970, albums: 6 },
        { decade: 1990, albums: 2 },
      ]),
    ).toEqual({ decade: 1970, share: 0.6 })
    expect(peakDecade([])).toBeNull()
  })
})

describe('cardsWithSomethingToSay', () => {
  const empty: ReadyInsights = {
    state: 'ready',
    web: { artists: 0, connected: 0, largest: 0, groups: 0 },
    bridges: [],
    sharedPeople: [],
    sharedLabels: [],
    bandFamilies: [],
    mostConnected: [],
    islands: null,
    recordedTogether: [],
    soundsAlike: [],
    pathSuggestion: null,
    mostPlayed: { artists: [], albums: [], tracks: [] },
    onRepeat: [],
    rediscover: [],
    waiting: { albums: [], total: 0 },
    shape: { decades: [{ decade: 1970, albums: 3 }], undated: 0, labels: [] },
    careers: [],
  }

  it('leaves out every card with nothing to say, a shape of one decade included', () => {
    expect(cardsWithSomethingToSay(empty)).toEqual([])
  })

  it('keeps the panel order', () => {
    const ref = { id: 1, title: 'A', type: 'artist' }
    const cards = cardsWithSomethingToSay({
      ...empty,
      islands: { artists: [ref], total: 1 },
      pathSuggestion: { from: ref, to: ref },
      bridges: [{ person: ref, roles: ['producer'], artists: [ref, ref], total: 2, ownRecords: false, focus: [1] }],
    })
    expect(cards).toEqual(['bridges', 'path', 'islands'])
  })
})

describe('the rail', () => {
  it('has Insights directly under Library health', () => {
    const ids = RAIL_ITEMS.map((item) => item.id)
    expect(ids.indexOf('insights')).toBe(ids.indexOf('health') + 1)
    expect(RAIL_ITEMS.find((item) => item.id === 'insights')).toEqual({ id: 'insights', icon: 'lightbulb', label: 'Insights' })
    expect(railOwner({ kind: 'insights' })).toBe('insights')
  })
})
