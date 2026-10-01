// Issue #110: how this copy of legato-server was installed, which decides
// the one command the update notice shows. Each channel's own artifact sets LEGATO_INSTALL_CHANNEL
// to exactly one of these strings:
//
//   docker   set in server/Dockerfile
//            notice: docker compose pull && docker compose up -d
//   script   set in the systemd unit site/public/install.sh writes (#108)
//            notice: legato update
//   brew     set in the Homebrew formula's service block (#109)
//            notice: brew upgrade legato
//   desktop  set by src-tauri/src/server_process.rs on the server the
//            desktop app spawns. No notice and no check: the Tauri
//            updater (#129) owns updates there
//
// Anything else, unset included (a hand-copied binary, a source checkout),
// is "unknown", and the notice falls back to a plain "download the latest
// release" link. The client mirrors this list in src/config/installChannel.ts
// rather than importing it, because the Docker image's web stage only sees
// src/.
export const INSTALL_CHANNELS = ["docker", "script", "brew", "desktop"] as const;

export const UNKNOWN_INSTALL_CHANNEL = "unknown";

export type InstallChannel = (typeof INSTALL_CHANNELS)[number] | typeof UNKNOWN_INSTALL_CHANNEL;

export function resolveInstallChannel(env: NodeJS.ProcessEnv = process.env): InstallChannel {
  const raw = env.LEGATO_INSTALL_CHANNEL?.trim().toLowerCase();
  return INSTALL_CHANNELS.find((channel) => channel === raw) ?? UNKNOWN_INSTALL_CHANNEL;
}
