use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

pub struct ServerProcess(pub Mutex<Option<Child>>);

const SERVER_PORT: u16 = 8899;

fn server_dir() -> PathBuf {
  // Dev-time only: resolved relative to this crate's manifest dir, which is
  // stable regardless of the process's runtime CWD. This spawns the
  // server's existing npm scripts directly rather than assuming a compiled
  // single-file binary — bundling a real Tauri sidecar/externalBin for
  // distribution is M10's job (see the MVP roadmap's packaging spike note).
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server")
}

pub fn spawn(app: &AppHandle) -> Result<Child, String> {
  let data_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("failed to resolve app data dir: {e}"))?;

  std::fs::create_dir_all(&data_dir)
    .map_err(|e| format!("failed to create app data dir {data_dir:?}: {e}"))?;

  log::info!("[server] spawning legato-server, data dir = {data_dir:?}");

  let mut cmd = Command::new("npm");
  cmd
    .args(["run", "start"])
    .current_dir(server_dir())
    .env("LEGATO_DATA_DIR", &data_dir)
    .env("LEGATO_PORT", SERVER_PORT.to_string());

  // `npm run start` forks through a shell into tsx into a second node
  // process (npm -> sh -> tsx -> node) — killing just the direct Child
  // leaves the actual listening process orphaned and still bound to the
  // port. Put the whole tree in its own process group (pgid == this pid)
  // so it can be torn down as one unit on exit. Unix-only; Windows needs a
  // job-object equivalent, tracked as M10 cross-platform work.
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }

  cmd
    .spawn()
    .map_err(|e| format!("failed to spawn legato-server (is npm on PATH?): {e}"))
}

/// `tauri::RunEvent::Exit` only fires on a Tauri-driven graceful shutdown
/// (last window closed, `app.exit()`), not on an external SIGTERM/SIGINT
/// delivered straight to the OS process (force-quit, `killall`, a shutdown
/// script) — that default-terminates the process before Tauri's own event
/// loop gets a chance to run any cleanup. Install a real signal handler so
/// the embedded server dies with the app either way.
pub fn install_signal_handler(app: &AppHandle) {
  let handle = app.clone();
  let _ = ctrlc::set_handler(move || {
    log::info!("[server] received termination signal, cleaning up");
    kill(&handle.state::<ServerProcess>());
    std::process::exit(0);
  });
}

pub fn kill(state: &ServerProcess) {
  if let Ok(mut guard) = state.0.lock() {
    if let Some(mut child) = guard.take() {
      log::info!("[server] terminating legato-server process group");

      #[cfg(unix)]
      {
        // SIGTERM the whole process group first (npm/sh/tsx/node all share
        // it, see spawn() above), then fall back to SIGKILL if anything's
        // still alive after a short grace period.
        let pgid = child.id() as i32;
        let _ = Command::new("kill").args(["-TERM", "--", &format!("-{pgid}")]).status();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = Command::new("kill").args(["-KILL", "--", &format!("-{pgid}")]).status();
      }
      #[cfg(not(unix))]
      {
        let _ = child.kill();
      }

      let _ = child.wait();
    }
  }
}
