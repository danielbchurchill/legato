import { describe, expect, it } from 'vitest'
import { fileFacts, formatSampleRate, playsAfterMergeLine, type DuplicateFile, type DuplicatePair } from './duplicates'

const file = (over: Partial<DuplicateFile>): DuplicateFile => ({
  id: 1,
  path: '/music/a.flac',
  format: 'flac',
  bitrate: 1_411_000,
  sampleRate: 44_100,
  bitDepth: 16,
  size: 33_600_000,
  missing: false,
  ...over,
})

describe('fileFacts', () => {
  it('says format, bitrate, sample rate, bit depth and size', () => {
    expect(fileFacts(file({}))).toBe('FLAC · 1411 kbps · 44.1 kHz · 16-bit · 32.0 MB')
  })

  it('leaves out what a file doesn’t say, such as a lossy file’s bit depth', () => {
    expect(fileFacts(file({ format: 'MPEG', bitrate: 320_000, sampleRate: 48_000, bitDepth: null, size: 9_000_000 }))).toBe(
      'MPEG · 320 kbps · 48 kHz · 8.6 MB',
    )
    expect(fileFacts(file({ format: null, bitrate: null, sampleRate: null, bitDepth: null, size: 1024 }))).toBe('1.0 KB')
  })
})

describe('formatSampleRate', () => {
  it('reads in kHz', () => {
    expect(formatSampleRate(96_000)).toBe('96 kHz')
    expect(formatSampleRate(44_100)).toBe('44.1 kHz')
    expect(formatSampleRate(null)).toBeNull()
  })
})

describe('playsAfterMergeLine', () => {
  const pair = (over: Partial<DuplicatePair>): DuplicatePair => ({
    file: file({ id: 1, format: 'MPEG' }),
    candidate: [file({ id: 2, format: 'flac' })],
    playsAfterMerge: 2,
    reason: 'bitrate',
    ...over,
  })

  it('names the side and format that will play, and why', () => {
    expect(playsAfterMergeLine(pair({}))).toBe('After a merge the track plays the FLAC file on the right, which has the higher bitrate.')
    expect(playsAfterMergeLine(pair({ playsAfterMerge: 1 }))).toContain('the MPEG file on the left')
    expect(playsAfterMergeLine(pair({ reason: 'first' }))).toContain("the bitrates match, so it's the one Legato found first")
    expect(playsAfterMergeLine(pair({ reason: 'only' }))).toContain('the only one on disk')
  })

  it('says when neither can play', () => {
    expect(playsAfterMergeLine(pair({ playsAfterMerge: null, reason: null }))).toMatch(/^Neither file is on disk/)
  })
})
