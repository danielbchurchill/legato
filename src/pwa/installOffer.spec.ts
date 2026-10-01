import { describe, expect, it, vi } from 'vitest'
import { createInstallOffer, type InstallPromptEvent } from './installOffer'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

const promptEvent = () => Object.assign(new Event('beforeinstallprompt'), { prompt: vi.fn(async () => undefined) }) as InstallPromptEvent

describe('createInstallOffer', () => {
  it('has nothing to offer on load, even once Chrome says the app is installable', () => {
    const offer = createInstallOffer(memoryStorage())
    offer.captured(promptEvent())
    expect(offer.ready()).toBeNull()
  })

  it('offers after the first playback, whichever of the two arrives first', () => {
    const early = createInstallOffer(memoryStorage())
    const event = promptEvent()
    early.captured(event)
    early.playbackStarted()
    expect(early.ready()).toBe(event)

    const late = createInstallOffer(memoryStorage())
    late.playbackStarted()
    expect(late.ready()).toBeNull()
    late.captured(event)
    expect(late.ready()).toBe(event)
  })

  it('tells subscribers when the offer may have become ready', () => {
    const offer = createInstallOffer(memoryStorage())
    const listener = vi.fn()
    offer.subscribe(listener)
    offer.captured(promptEvent())
    offer.playbackStarted()
    offer.playbackStarted()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('offers once per device', () => {
    const storage = memoryStorage()
    const offer = createInstallOffer(storage)
    offer.captured(promptEvent())
    offer.playbackStarted()
    offer.markOffered()
    expect(offer.ready()).toBeNull()

    const nextSession = createInstallOffer(storage)
    nextSession.captured(promptEvent())
    nextSession.playbackStarted()
    expect(nextSession.ready()).toBeNull()
  })

  it('drops the offer once the app is installed', () => {
    const offer = createInstallOffer(memoryStorage())
    offer.captured(promptEvent())
    offer.playbackStarted()
    offer.installed()
    expect(offer.ready()).toBeNull()
  })
})
