// Issue #118: what the rail's connection indicator says.
import { describe, expect, it } from 'vitest'
import { describeQuality, PATH_LABEL, pathSentence, qualityLabel } from './describeConnection'
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
