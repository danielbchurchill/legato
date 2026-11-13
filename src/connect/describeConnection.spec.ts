// Issue #118: what the rail's connection indicator says.
import { describe, expect, it } from 'vitest'
import { AWAY_LABEL, AWAY_SAME_WHY, AWAY_WHY, describeQuality, PATH_LABEL, pathSentence, placeLabel, qualityLabel } from './describeConnection'
import type { ServerPath } from './serverPath'

const PATHS: ServerPath[] = ['embedded', 'this-device', 'home', 'relay', 'custom']

describe('the path', () => {
  it('names each path, and calls both kinds of this computer the same', () => {
    expect(PATH_LABEL.embedded).toBe('This computer')
    expect(PATH_LABEL['this-device']).toBe('This computer')
    expect(PATH_LABEL.home).toBe('Home network')
    expect(PATH_LABEL.relay).toBe('Through legato.fm')
    expect(PATH_LABEL.custom).toBe('Custom address')
  })

  it('says what each path means, naming the server where it can', () => {
    for (const path of PATHS) {
      expect(pathSentence(path, 'musicbox')).not.toContain('undefined')
      expect(pathSentence(path, null)).not.toContain('null')
    }
    expect(pathSentence('home', 'musicbox')).toBe('Connected to musicbox directly, on your home network.')
    expect(pathSentence('relay', null)).toBe("Connected to your server over the internet, through legato.fm's relay.")
    expect(pathSentence('custom', 'musicbox')).toBe(
      'Connected to musicbox directly, at an address that works away from home too, such as a domain.',
    )
  })
})

// #495: the server's home/away answer for this device (#412).
describe('the place', () => {
  it("says the path's name at home and while the server doesn't know", () => {
    for (const path of PATHS) {
      expect(placeLabel(path, 'home')).toBe(PATH_LABEL[path])
      expect(placeLabel(path, 'unknown')).toBe(PATH_LABEL[path])
    }
    expect(placeLabel('home', 'home')).toBe('Home network')
    expect(placeLabel('home', 'unknown')).toBe('Home network')
  })

  it('says away from home in place of the path while the answer is away', () => {
    expect(AWAY_LABEL).toBe('Away from home')
    // A Tailscale address is the home path, wherever the device is.
    expect(placeLabel('home', 'away')).toBe('Away from home')
    expect(placeLabel('custom', 'away')).toBe('Away from home')
  })

  it("says what the path means at home and while the server doesn't know", () => {
    for (const path of PATHS) {
      expect(pathSentence(path, 'musicbox', 'home')).toBe(pathSentence(path, 'musicbox'))
      expect(pathSentence(path, 'musicbox', 'unknown')).toBe(pathSentence(path, 'musicbox'))
    }
    expect(pathSentence('home', 'musicbox', 'home')).toBe('Connected to musicbox directly, on your home network.')
    expect(pathSentence('home', 'musicbox', 'unknown')).toBe('Connected to musicbox directly, on your home network.')
  })

  it("says it's over Tailscale from outside the home network while the answer is away", () => {
    expect(pathSentence('home', 'musicbox', 'away')).toBe('Connected to musicbox over Tailscale, from outside your home network.')
    expect(pathSentence('home', null, 'away')).toBe('Connected to your server over Tailscale, from outside your home network.')
  })
})

describe('the quality', () => {
  const stream = { playing: null, next: 'original' as const, preference: 'auto' as const, drops: 0 }

  it('labels every rung by what it is', () => {
    expect(qualityLabel('original')).toBe('original')
    expect(qualityLabel('opus96')).toBe('Opus 96 kbps')
    expect(qualityLabel('opus160')).toBe('Opus 160 kbps')
    expect(qualityLabel('aac256')).toBe('AAC 256 kbps')
  })

  it('says the desktop app plays files, and streams the original of one that isn\'t here', () => {
    expect(describeQuality('home', null)).toEqual({
      label: 'original',
      sentence: 'Plays files straight from your library, at their original quality.',
    })
    expect(describeQuality('home', null, true)).toEqual({
      label: 'original',
      sentence: "This track streams from the server at its original quality, because its file isn't on this computer.",
    })
  })

  it("gives the path's default as the reason, until something else is", () => {
    expect(describeQuality('home', stream).sentence).toBe('Streams at original quality, the default on your home network.')
    expect(describeQuality('relay', { ...stream, next: 'opus160' })).toEqual({
      label: 'Opus 160 kbps',
      sentence: 'Streams as Opus at 160 kbps, the default through legato.fm.',
    })
    expect(describeQuality('relay', { ...stream, next: 'opus96', preference: 'low' }).sentence).toBe(
      'Streams as Opus at 96 kbps, as set in Settings.',
    )
    expect(describeQuality('relay', { ...stream, next: 'opus96', drops: 1 }).sentence).toBe(
      'Streams as Opus at 96 kbps, lowered after the connection dropped.',
    )
  })

  // #412: the why for standard while away, after a drop and before the
  // Settings pick.
  it('says when standard while away is why', () => {
    expect(AWAY_WHY).toBe('while this device is away from home, as set in Settings')
    expect(describeQuality('home', { ...stream, next: 'aac160', awayCapped: true })).toEqual({
      label: 'AAC 160 kbps',
      sentence: 'Streams as AAC at 160 kbps, while this device is away from home, as set in Settings.',
    })
    expect(describeQuality('home', { ...stream, next: 'opus160', preference: 'high', awayCapped: true }).sentence).toBe(
      'Streams as Opus at 160 kbps, while this device is away from home, as set in Settings.',
    )
    expect(describeQuality('home', { ...stream, next: 'opus96', drops: 1, awayCapped: true }).sentence).toBe(
      'Streams as Opus at 96 kbps, lowered after the connection dropped.',
    )
    // The playing track keeps the original; the next one is standard.
    expect(describeQuality('home', { ...stream, playing: 'original', next: 'aac160', awayCapped: true }).sentence).toBe(
      'This track streams at original quality. The next one streams as AAC at 160 kbps, while this device is away from home, as set in Settings.',
    )
  })

  // #495: away from home, with nothing else moving the ladder.
  it("says the start is the same as at home while away, and the path's default at home or unknown", () => {
    expect(AWAY_SAME_WHY).toBe('the same as at home')
    expect(describeQuality('home', { ...stream, away: true })).toEqual({
      label: 'original',
      sentence: 'Streams at original quality, the same as at home.',
    })
    // Home and unknown are both `away: false` by the time they get here.
    expect(describeQuality('home', { ...stream, away: false }).sentence).toBe(
      'Streams at original quality, the default on your home network.',
    )
    expect(describeQuality('home', { ...stream, playing: 'original', next: 'aac160', drops: 1, away: true }).sentence).toBe(
      'This track streams at original quality. The next one streams as AAC at 160 kbps, lowered after the connection dropped.',
    )
    expect(describeQuality('home', { ...stream, next: 'aac160', awayCapped: true, away: true }).sentence).toBe(
      'Streams as AAC at 160 kbps, while this device is away from home, as set in Settings.',
    )
    expect(describeQuality('home', { ...stream, next: 'opus256', preference: 'high', away: true }).sentence).toBe(
      'Streams as Opus at 256 kbps, as set in Settings.',
    )
  })

  it('tells the playing track apart from the next one when a drop or a pick has moved the ladder', () => {
    const moved = describeQuality('custom', { playing: 'opus256', next: 'opus160', preference: 'auto', drops: 1 })
    expect(moved.label).toBe('Opus 256 kbps')
    expect(moved.sentence).toBe(
      'This track streams as Opus at 256 kbps. The next one streams as Opus at 160 kbps, lowered after the connection dropped.',
    )
    expect(describeQuality('home', { ...stream, playing: 'original' }).sentence).toBe(
      'Streams at original quality, the default on your home network.',
    )
  })
})
