// Every ffmpeg/fpcalc call site in this server currently spawns by bare
// command name, which only resolves because both happen to be installed on
// this dev machine's PATH. That assumption is false the moment someone
// installs a packaged build with no system ffmpeg/Chromaprint present.
//
// LEGATO_FFMPEG_PATH / LEGATO_FPCALC_PATH let a packaged app point at
// binaries it bundled itself — src-tauri's server_process.rs resolves them
// from Tauri's bundled resources dir (see scripts/fetch-media-binaries.mjs
// for where those binaries come from) and passes them to the Node child the
// same way it already passes LEGATO_DATA_DIR/LEGATO_PORT. Unset, both fall
// back to the bare command name — exactly today's working PATH-resolution
// behavior on this dev machine and on Linux generally, which is
// deliberately left as-is (see CLAUDE.md).
//
// Exported as functions, not just top-level constants, so the pure
// resolution logic is directly testable without mutating process.env.
export function resolveFfmpegPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LEGATO_FFMPEG_PATH ?? "ffmpeg";
}

export function resolveFpcalcPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LEGATO_FPCALC_PATH ?? "fpcalc";
}

export const FFMPEG_PATH = resolveFfmpegPath();
export const FPCALC_PATH = resolveFpcalcPath();
