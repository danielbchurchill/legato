// What the update notice tells someone to do, per install channel (issue
// #110). The channel strings mirror server/src/update/installChannel.ts,
// which says which artifact sets each one; this can't import it, because
// the Docker image's web stage builds src/ without server/ beside it. The
// channel is the server's, not this client's: a desktop window pointed at
// the Pi's Docker server still shows the docker command.
export type UpdateAction = { kind: 'command'; command: string } | { kind: 'link'; url: string }

// A Map rather than an object literal so a channel string that happens to
// name an Object.prototype key ("constructor") can't come back as a command.
const COMMANDS = new Map([
  ['docker', 'docker compose pull && docker compose up -d'],
  ['script', 'legato update'],
  ['brew', 'brew upgrade legato'],
])

// For the "unknown" channel (a hand-copied binary, or a server older than
// #110 that reports none) when the server didn't pass on a release page.
export const LATEST_RELEASE_URL = 'https://github.com/danielbchurchill/legato/releases/latest'

// Null for desktop: the Tauri updater (#129) handles the app and the
// server inside it, so the notice stays out of its way.
export function updateAction(channel: string | null, releaseUrl: string | null): UpdateAction | null {
  if (channel === 'desktop') return null
  const command = channel === null ? undefined : COMMANDS.get(channel)
  if (command) return { kind: 'command', command }
  return { kind: 'link', url: releaseUrl ?? LATEST_RELEASE_URL }
}
