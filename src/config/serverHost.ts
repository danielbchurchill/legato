// Every desktop build (Tauri) and plain `npm run dev` talks to the
// server's loopback address unchanged. Set VITE_SERVER_HOST to reach a
// server bound to a different interface — e.g. previewing this app from
// another machine over Tailscale while Vite and the server both run here.
export const SERVER_HOST = import.meta.env.VITE_SERVER_HOST ?? '127.0.0.1'

// Matches the server's own LEGATO_PORT default (server/src/config.ts). Set
// VITE_SERVER_PORT alongside LEGATO_PORT to point this frontend at a second
// server on the same machine — a parallel worktree, or a test install next
// to the real one — while the default port stays taken. `||` rather than `??` so an
// empty `VITE_SERVER_PORT=` line in a .env file falls back instead of
// producing `http://127.0.0.1:/api/v1`.
export const SERVER_PORT = import.meta.env.VITE_SERVER_PORT || '8899'

// The only places a server URL is assembled. Every other file imports one
// of these, so resolving the server at runtime (#116) changes this file and
// nothing else.
export const SERVER_ORIGIN = `http://${SERVER_HOST}:${SERVER_PORT}`
export const API_BASE = `${SERVER_ORIGIN}/api/v1`
export const WS_BASE = `ws://${SERVER_HOST}:${SERVER_PORT}/api/v1`
