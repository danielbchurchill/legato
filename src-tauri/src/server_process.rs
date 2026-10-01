use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

pub struct ServerProcess(pub Mutex<Option<Child>>);

const SERVER_PORT: u16 = 8899;

// Matches the directory layout scripts/fetch-media-binaries.mjs writes
// (src-tauri/binaries/<target-triple>/) and the Rust target triples Tauri
// itself already uses for `externalBin`-style resources, so this needs no
// runtime platform detection — the triple is fixed at compile time for
// whichever binary is actually being built.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-apple-darwin";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";

// Dev-time only (`tauri::is_dev()` gates every call site): resolved
// relative to this crate's manifest dir, which is stable regardless of the
// process's runtime CWD. `npx tauri dev` has no bundled sidecar to run, so
// it spawns the server straight from source instead — see spawn() below
// and issue #103.
fn server_source_dir() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server")
}

// Locates the compiled server binary Tauri's bundler places next to the
// app's own executable at package time (tauri.conf.json's
// bundle.externalBin, resolved from src-tauri/binaries/legato-server-
// <target-triple> — see scripts/build-server-sidecar.mjs, which compiles
// it via #102's `bun build --compile` and wires into
// build.beforeBuildCommand). The bundler strips the target-triple suffix
// back off on copy (confirmed against tauri-bundler's copy_binaries), so
// at runtime this just looks for a plain "legato-server" beside whatever
// binary is currently running — true on every platform Tauri bundles a
// sidecar for, not just macOS/Windows, so this has no target_os cfg gate.
fn resolve_sidecar_binary(app: &AppHandle) -> Result<PathBuf, String> {
  let binary_name = format!("legato-server{}", std::env::consts::EXE_SUFFIX);
  let current_exe = tauri::process::current_binary(&app.env())
    .map_err(|e| format!("failed to resolve the running app's own binary path: {e}"))?;
  let dir = current_exe
    .parent()
    .ok_or_else(|| format!("running binary {current_exe:?} has no parent directory"))?;
  let sidecar = dir.join(&binary_name);
  if !sidecar.exists() {
    return Err(format!(
      "expected the {binary_name} sidecar next to the app binary at {sidecar:?}, but it isn't there — was this app packaged with `tauri build` (not a bare `cargo build`)?"
    ));
  }
  Ok(sidecar)
}

// Resolves a bundled ffmpeg/fpcalc binary from Tauri's packaged resources
// dir (populated by scripts/fetch-media-binaries.mjs into
// src-tauri/binaries/<target-triple>/, wired in via tauri.conf.json's
// bundle.resources). Returns None whenever that binary isn't actually
// there — a plain `npx tauri dev` run against a checkout where nobody has
// run the fetch script, or a platform it hasn't been fetched for yet — so
// server/src/mediaBinaries.ts's own LEGATO_FFMPEG_PATH/LEGATO_FPCALC_PATH
// fallback to bare PATH resolution keeps working exactly as it does today.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn resolve_media_binary(app: &AppHandle, name: &str) -> Option<PathBuf> {
  let resource_dir = app.path().resource_dir().ok()?;
  let binary_name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
  let path = resource_dir.join("binaries").join(TARGET_TRIPLE).join(binary_name);
  path.exists().then_some(path)
}

// Linux keeps relying on system ffmpeg/fpcalc on PATH — deliberately out of
// scope here, per CLAUDE.md.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn resolve_media_binary(_app: &AppHandle, _name: &str) -> Option<PathBuf> {
  None
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_data_dir()
    .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

/// Where the server records the last time it streamed audio (issue #130,
/// server/src/stream/activity.ts), for keep_awake.rs to read.
pub fn stream_activity_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(data_dir(app)?.join("stream-activity"))
}

pub fn spawn(app: &AppHandle) -> Result<Child, String> {
  let data_dir = data_dir(app)?;

  std::fs::create_dir_all(&data_dir)
    .map_err(|e| format!("failed to create app data dir {data_dir:?}: {e}"))?;

  log::info!("[server] spawning legato-server, data dir = {data_dir:?}");

  let mut cmd = if tauri::is_dev() {
    let mut c = Command::new("npm");
    c.args(["run", "start"]).current_dir(server_source_dir());
    c
  } else {
    let sidecar = resolve_sidecar_binary(app)?;
    log::info!("[server] using bundled sidecar: {sidecar:?}");
    Command::new(sidecar)
  };

  // A server that's only just starting hasn't streamed anything yet. Left
  // in place, the previous run's timestamp would have keep-awake hold the
  // machine up on resume or relaunch for a listener who already left.
  let activity_file = stream_activity_file(app)?;
  let _ = std::fs::remove_file(&activity_file);

  cmd
    .env("LEGATO_DATA_DIR", &data_dir)
    .env("LEGATO_PORT", SERVER_PORT.to_string())
    .env("LEGATO_STREAM_ACTIVITY_FILE", &activity_file);

  if let Some(ffmpeg_path) = resolve_media_binary(app, "ffmpeg") {
    log::info!("[server] using bundled ffmpeg: {ffmpeg_path:?}");
    cmd.env("LEGATO_FFMPEG_PATH", ffmpeg_path);
  }
  if let Some(fpcalc_path) = resolve_media_binary(app, "fpcalc") {
    log::info!("[server] using bundled fpcalc: {fpcalc_path:?}");
    cmd.env("LEGATO_FPCALC_PATH", fpcalc_path);
  }

  // In dev, `npm run start` forks through a shell into a second bun
  // process (npm -> sh -> bun) — killing just the direct Child leaves the
  // actual listening process orphaned and still bound to the port. In a
  // packaged build it's one process, but that process still forks its own
  // ffmpeg children for transcodes, which inherit whatever process group
  // it's in. Either way, put the whole tree in its own process group
  // (pgid == this pid) so it can be torn down as one unit on exit.
  // Unix-only; Windows needs a job-object equivalent, tracked as M10
  // cross-platform work.
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }

  cmd.spawn().map_err(|e| {
    if tauri::is_dev() {
      format!("failed to spawn legato-server via npm (is npm on PATH?): {e}")
    } else {
      format!("failed to spawn legato-server sidecar: {e}")
    }
  })
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
        // SIGTERM the whole process group first (the server and any
        // ffmpeg children it spawns all share it, see spawn() above), then
        // fall back to SIGKILL if anything's still alive after a short
        // grace period.
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
