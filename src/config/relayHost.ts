// Where the legato.fm service (today's relay, relay/) lives: the desktop
// app's legato.fm sign-in (issue #215) talks to it, and nothing else in the
// client does yet. Production is auth.legato.fm, the hostname the Google
// and GitHub OAuth registrations are bound to.
//
// Dev override: VITE_RELAY_URL=http://127.0.0.1:8921 points at a local
// relay (`RELAY_PORT=8921 npm --prefix relay run dev`). The Rust side only
// opens a browser at a loopback relay in a debug build
// (src-tauri/src/relay_sign_in.rs), so a packaged app can't be pointed at
// some other host through a baked-in .env.
//
// `||` rather than `??`, for the same empty-.env-line reason as
// serverHost.ts.
const DEFAULT_RELAY_ORIGIN = 'https://auth.legato.fm'

export interface RelayEnv {
  VITE_RELAY_URL?: string
}

// Reduced to an origin, so a trailing slash or path in the env var can't
// turn `${RELAY_ORIGIN}/auth/token` into `//auth/token`.
export function resolveRelayOrigin(env: RelayEnv): string {
  return new URL(env.VITE_RELAY_URL || DEFAULT_RELAY_ORIGIN).origin
}

export const RELAY_ORIGIN = resolveRelayOrigin({ VITE_RELAY_URL: import.meta.env.VITE_RELAY_URL })
