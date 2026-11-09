import { describe, expect, it } from 'vitest'
import { formatFileFormat, formatPerHour, noticeRows, perHour, serverWords, spokenFileFormat } from './awayNotice'

// #412: the notice's figures and format line, by the handoff's rules.

describe('formatPerHour', () => {
  it.each([
    [900, 'about 400 MB'],
    [1229, 'about 550 MB'],
    [2900, 'about 1.3 GB'],
    [5600, 'about 2.5 GB'],
    [160, 'about 72 MB'],
    // 990 MB: GB from 950 MB up, without ".0".
    [2200, 'about 1 GB'],
  ])('%d kbps is %s an hour (the handoff test table)', (kbps, text) => {
    expect(formatPerHour(kbps)).toBe(text)
  })

  it('rounds to 1 MB under 100 MB, to 50 MB under 950, and to 0.1 GB from there', () => {
    expect(formatPerHour(220)).toBe('about 99 MB') // 99 MB
    expect(formatPerHour(230)).toBe('about 100 MB') // 103.5 MB, to the nearest 50
    expect(formatPerHour(1000)).toBe('about 450 MB')
    expect(formatPerHour(2100)).toBe('about 950 MB') // 945 MB
    expect(formatPerHour(2112)).toBe('about 1 GB') // 950.4 MB
    expect(formatPerHour(9216)).toBe('about 4.1 GB')
  })

  it('spells the units out for a screen reader', () => {
    expect(perHour(900).spoken).toBe('400 megabytes')
    expect(perHour(2900).spoken).toBe('1.3 gigabytes')
    expect(perHour(2200).spoken).toBe('1 gigabyte')
  })
})

describe('formatFileFormat', () => {
  it('names a lossless file by its codec and sample rate', () => {
    expect(formatFileFormat({ format: 'FLAC', bitrate: 900_000, sampleRate: 44100 })).toBe('FLAC 44.1 kHz')
    expect(formatFileFormat({ format: 'FLAC', bitrate: 2_900_000, sampleRate: 96000 })).toBe('FLAC 96 kHz')
    expect(formatFileFormat({ format: 'FLAC', bitrate: 5_600_000, sampleRate: 192000 })).toBe('FLAC 192 kHz')
    expect(formatFileFormat({ format: 'WAVE', bitrate: 1_411_200, sampleRate: 48000 })).toBe('WAV 48 kHz')
    expect(formatFileFormat({ format: 'AIFF-C', bitrate: 1_411_200, sampleRate: 44100 })).toBe('AIFF 44.1 kHz')
  })

  it('names a lossy file by its codec and bitrate', () => {
    expect(formatFileFormat({ format: 'MPEG', bitrate: 320_000, sampleRate: 44100 })).toBe('MP3 320 kbps')
    expect(formatFileFormat({ format: 'MPEG', bitrate: 128_000, sampleRate: 44100 })).toBe('MP3 128 kbps')
    expect(formatFileFormat({ format: 'Ogg', bitrate: 499_600, sampleRate: 44100 })).toBe('Ogg 500 kbps')
  })

  it('tells ALAC from AAC in an MP4 by its bitrate', () => {
    expect(formatFileFormat({ format: 'M4A/mp42/isom', bitrate: 256_000, sampleRate: 44100 })).toBe('AAC 256 kbps')
    expect(formatFileFormat({ format: 'M4A/mp42/isom', bitrate: 870_000, sampleRate: 44100 })).toBe('ALAC 44.1 kHz')
  })

  it("leaves out what the scan didn't read, and never says a bit depth", () => {
    expect(formatFileFormat({ format: 'FLAC', bitrate: 900_000, sampleRate: null })).toBe('FLAC')
    expect(formatFileFormat({ format: 'MPEG', bitrate: null, sampleRate: 44100 })).toBe('MP3')
    expect(formatFileFormat({ format: null, bitrate: 900_000, sampleRate: 44100 })).toBe('900 kbps')
    expect(formatFileFormat({ format: 'FLAC', bitrate: 5_600_000, sampleRate: 192000 })).not.toContain('bit')
  })

  it('spells the units out for a screen reader', () => {
    expect(spokenFileFormat({ format: 'FLAC', bitrate: 900_000, sampleRate: 44100 })).toBe('FLAC 44.1 kilohertz')
    expect(spokenFileFormat({ format: 'MPEG', bitrate: 320_000, sampleRate: 44100 })).toBe('MP3 320 kilobits a second')
  })
})

describe('noticeRows', () => {
  it('draws original against standard, with what a screen reader hears for each', () => {
    const rows = noticeRows({ format: 'FLAC', bitrate: 900_000, sampleRate: 44100 })!
    expect(rows.map(({ label, format, figure }) => ({ label, format, figure }))).toEqual([
      { label: 'original', format: 'FLAC 44.1 kHz', figure: '400 MB' },
      { label: 'standard', format: '160 kbps', figure: '72 MB' },
    ])
    expect(rows.map((row) => row.spoken)).toEqual([
      'original, FLAC 44.1 kilohertz: about 400 megabytes an hour.',
      'standard, 160 kilobits a second: about 72 megabytes an hour.',
    ])
    expect(rows[0]!.share).toBe(1)
    expect(rows[1]!.share).toBeCloseTo(160 / 900)
  })

  it('has nothing to draw without a bitrate', () => {
    expect(noticeRows({ format: 'FLAC', bitrate: null, sampleRate: 44100 })).toBeNull()
  })
})

describe('serverWords', () => {
  it("is the server's own name, else 'your server'", () => {
    expect(serverWords('raspberrypi')).toBe('raspberrypi')
    expect(serverWords(null)).toBe('your server')
    expect(serverWords('  ')).toBe('your server')
  })
})
