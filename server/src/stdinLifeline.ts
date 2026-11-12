import type { Readable } from "node:stream";

// Issue #373: the desktop app runs its server in a process group of its own
// (src-tauri/src/server_process.rs) and stops that group on its way out. An
// app that's killed outright never gets to: `tauri dev` SIGKILLs it to
// rebuild, and a crash or a force-quit skips the cleanup too. The server is
// left holding the port, the next app's server can't listen on it, and no
// stop signal sent to the app's process tree reaches it any more.
//
// So the app hands its server a pipe as stdin and keeps the other end open
// for as long as it runs. The kernel closes that end however the app goes,
// and the server takes the end of its stdin as a SIGTERM. Only when
// LEGATO_EXIT_ON_STDIN_CLOSE=1 says stdin is that pipe: a server started
// from a terminal, a service manager or Docker has a TTY, /dev/null or
// nothing there, and must leave it alone.
export const STDIN_LIFELINE_VAR = "LEGATO_EXIT_ON_STDIN_CLOSE";

/** True when it's watching stdin, which calls `stop` once, when it closes. */
export function stopWhenStdinCloses(stop: () => void, env: NodeJS.ProcessEnv = process.env, input?: Readable): boolean {
  if (env[STDIN_LIFELINE_VAR] !== "1") return false;
  // Only now: even looking at process.stdin sets it up.
  const stdin = input ?? process.stdin;
  let stopped = false;
  const once = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  stdin.once("end", once);
  stdin.once("close", once);
  stdin.once("error", once);
  // Flowing, so the end is seen. The app never writes anything.
  stdin.resume();
  return true;
}
