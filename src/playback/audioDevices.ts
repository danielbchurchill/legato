/** One output device as playback.rs's list_audio_devices returns it. `id`
 * is what gets saved (cpal's stable "host:device" id); `label` is what the
 * picker shows. */
export type AudioDevice = { id: string; label: string }

/** The listed device a saved preference refers to, or null if none does.
 * Mirrors matches_saved_device in playback.rs, so the picker shows the same
 * device the player will actually open: a preference saved before ids is a
 * device's old name, which is today's label on macOS and Windows and the
 * part of the id after "host:" on Linux. */
export function deviceForSaved(saved: string, devices: readonly AudioDevice[]): AudioDevice | null {
  if (!saved) return null
  return (
    devices.find(
      (d) => d.id === saved || d.id.slice(d.id.indexOf(':') + 1) === saved || d.label === saved,
    ) ?? null
  )
}
