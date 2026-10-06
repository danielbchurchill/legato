import { describe, expect, it } from 'vitest'
import { deviceForSaved, type AudioDevice } from './audioDevices'

const mac: AudioDevice[] = [
  { id: 'coreaudio:BuiltInSpeakerDevice', label: 'MacBook Pro Speakers' },
  { id: 'coreaudio:04721404-0000-0000-0A1A-0103803C2278', label: 'XG270HU' },
]
const linux: AudioDevice[] = [
  { id: 'alsa:pipewire', label: 'PipeWire Sound Server' },
  { id: 'alsa:pulse', label: 'PulseAudio Sound Server' },
]

describe('deviceForSaved', () => {
  it('finds a device saved by its id', () => {
    expect(deviceForSaved('coreaudio:BuiltInSpeakerDevice', mac)?.label).toBe('MacBook Pro Speakers')
  })

  it("finds a device saved by its old macOS/Windows name, which is today's label", () => {
    expect(deviceForSaved('XG270HU', mac)?.id).toBe('coreaudio:04721404-0000-0000-0A1A-0103803C2278')
  })

  it('finds a device saved by its old ALSA name, the PCM id after "alsa:"', () => {
    expect(deviceForSaved('pulse', linux)?.id).toBe('alsa:pulse')
  })

  it('is null for the system default and for a device that is gone', () => {
    expect(deviceForSaved('', mac)).toBeNull()
    expect(deviceForSaved('USB DAC', mac)).toBeNull()
  })
})
