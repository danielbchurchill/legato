//! Keeping the library served with no window open (issue #130): the
//! serve/pause state behind the tray menu, and the two settings that go
//! with it, launch at login and keep-awake.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::instance::Instance;
use crate::keep_awake;
use crate::server_process::{self, ServerProcess};
use crate::tray;

/// Whatever starts and stops the server. The real one is ProcessRunner
/// below; tests swap in a fake so the state machine runs without spawning
/// anything.
pub trait ServerRunner {
  fn start(&mut self) -> Result<(), String>;
  fn stop(&mut self);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
  Serving,
  /// Paused from the tray. Nothing is running, on purpose.
  Paused,
  /// The last start attempt failed. Nothing is running, and the tray
  /// offers to try again.
  Failed,
}

pub struct Serving<R: ServerRunner> {
  runner: R,
  status: Status,
}

impl<R: ServerRunner> Serving<R> {
  /// Starts the server, as the app does at launch.
  pub fn start(runner: R) -> Self {
    let mut serving = Self { runner, status: Status::Paused };
    serving.resume();
    serving
  }

  pub fn status(&self) -> Status {
    self.status
  }

  /// Stops the server. Pausing twice is harmless, as is pausing a server
  /// that failed to start: there's nothing to stop either way, and a
  /// failed start stays Failed so the tray keeps saying why.
  pub fn pause(&mut self) {
    if self.status == Status::Serving {
      self.runner.stop();
      self.status = Status::Paused;
    }
  }

  /// Starts the server again, from Paused or after a failed start.
  pub fn resume(&mut self) {
    if self.status == Status::Serving {
      return;
    }
    self.status = match self.runner.start() {
      Ok(()) => Status::Serving,
      Err(e) => {
        log::error!("[server] {e}");
        Status::Failed
      }
    };
  }

  /// The tray's one toggle item: pause when serving, start otherwise.
  pub fn toggle(&mut self) {
    match self.status {
      Status::Serving => self.pause(),
      Status::Paused | Status::Failed => self.resume(),
    }
  }
}

/// Starts and stops the real server child through server_process.rs, so a
/// pause tears it down with the same process-group kill #103 uses on exit:
/// no orphaned bun or ffmpeg left holding the port.
pub struct ProcessRunner(pub AppHandle);

impl ServerRunner for ProcessRunner {
  fn start(&mut self) -> Result<(), String> {
    let child = server_process::spawn(&self.0)?;
    *self.0.state::<ServerProcess>().0.lock().unwrap() = Some(child);
    Ok(())
  }

  fn stop(&mut self) {
    server_process::kill(&self.0.state::<ServerProcess>());
  }
}

/// Managed state.
pub struct ServingState {
  pub serving: Mutex<Serving<ProcessRunner>>,
  /// Mirrors settings.json's keepAwake, read by the keep-awake worker on
  /// every tick without touching the disk.
  pub keep_awake: AtomicBool,
  settings_file: PathBuf,
}

impl ServingState {
  pub fn new(serving: Serving<ProcessRunner>, settings_file: PathBuf) -> Self {
    let settings = ShellSettings::load(&settings_file);
    Self { serving: Mutex::new(serving), keep_awake: AtomicBool::new(settings.keep_awake), settings_file }
  }

  pub fn is_serving(&self) -> bool {
    self.serving.lock().map(|s| s.status() == Status::Serving).unwrap_or(false)
  }
}

/// Settings that belong to this machine's shell, not to an account. The
/// server's settings table is per account and travels with you to another
/// device, while "keep *this* computer awake" only means anything here. Launch at
/// login isn't stored here at all: the OS's own login item is the truth,
/// and the plugin reads it back.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellSettings {
  pub keep_awake: bool,
  /// Whether the app asks GitHub for its own updates (#497, updater.rs).
  /// Kept here rather than in the server's settings because it's this
  /// install's check: the server it talks to may be on another machine.
  pub update_check: bool,
}

/// What a missing file, or a field it doesn't have yet, means: keep-awake
/// is opt-in, and the update check is on.
impl Default for ShellSettings {
  fn default() -> Self {
    Self { keep_awake: false, update_check: true }
  }
}

impl ShellSettings {
  /// A missing or unreadable file means defaults, and a corrupt file must
  /// not stop the app from starting.
  pub fn load(file: &Path) -> Self {
    std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
  }

  /// Changes one setting and keeps the others as the file has them.
  pub fn change(file: &Path, apply: impl FnOnce(&mut Self)) -> Result<(), String> {
    let mut settings = Self::load(file);
    apply(&mut settings);
    settings.save(file)
  }

  pub fn save(&self, file: &Path) -> Result<(), String> {
    if let Some(dir) = file.parent() {
      std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {dir:?}: {e}"))?;
    }
    let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
    std::fs::write(file, json).map_err(|e| format!("couldn't save {file:?}: {e}"))
  }
}

pub fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.state::<Instance>().config_dir(app)?.join("shell-settings.json"))
}

/// Pause or resume from the tray. Runs off the main thread: a pause waits
/// out kill()'s 500 ms SIGTERM grace period, and the menu shouldn't freeze
/// for it.
pub fn toggle(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    if let Some(state) = app.try_state::<ServingState>() {
      if let Ok(mut serving) = state.serving.lock() {
        serving.toggle();
      }
    }
    tray::refresh(&app);
    keep_awake::wake(&app);
  });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServingSettingsView {
  launch_at_login: bool,
  keep_awake: bool,
  /// False on a Linux machine without systemd-inhibit, so the panel can
  /// say so instead of offering a switch that does nothing.
  keep_awake_available: bool,
}

#[tauri::command]
pub fn serving_settings(app: AppHandle, state: tauri::State<'_, ServingState>) -> Result<ServingSettingsView, String> {
  Ok(ServingSettingsView {
    launch_at_login: app.autolaunch().is_enabled().map_err(|e| e.to_string())?,
    keep_awake: state.keep_awake.load(Ordering::Relaxed),
    keep_awake_available: keep_awake::available(),
  })
}

#[tauri::command]
pub fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<(), String> {
  let autolaunch = app.autolaunch();
  if enabled { autolaunch.enable() } else { autolaunch.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_keep_awake(app: AppHandle, state: tauri::State<'_, ServingState>, enabled: bool) -> Result<(), String> {
  ShellSettings::change(&state.settings_file, |settings| settings.keep_awake = enabled)?;
  state.keep_awake.store(enabled, Ordering::Relaxed);
  keep_awake::wake(&app);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Default)]
  struct FakeRunner {
    running: bool,
    starts: u32,
    stops: u32,
    fail_starts: u32,
  }

  impl ServerRunner for FakeRunner {
    fn start(&mut self) -> Result<(), String> {
      assert!(!self.running, "started a server that was already running: two children, one port");
      if self.fail_starts > 0 {
        self.fail_starts -= 1;
        return Err("port 8899 already in use".into());
      }
      self.running = true;
      self.starts += 1;
      Ok(())
    }

    fn stop(&mut self) {
      assert!(self.running, "stopped a server that wasn't running");
      self.running = false;
      self.stops += 1;
    }
  }

  #[test]
  fn starts_serving_at_launch() {
    let serving = Serving::start(FakeRunner::default());
    assert_eq!(serving.status(), Status::Serving);
    assert!(serving.runner.running);
  }

  #[test]
  fn pause_stops_the_server_and_resume_starts_a_fresh_one() {
    let mut serving = Serving::start(FakeRunner::default());
    serving.pause();
    assert_eq!(serving.status(), Status::Paused);
    assert!(!serving.runner.running);

    serving.resume();
    assert_eq!(serving.status(), Status::Serving);
    assert_eq!((serving.runner.starts, serving.runner.stops), (2, 1));
  }

  #[test]
  fn pausing_or_resuming_twice_does_nothing_the_second_time() {
    let mut serving = Serving::start(FakeRunner::default());
    serving.resume();
    serving.pause();
    serving.pause();
    assert_eq!((serving.runner.starts, serving.runner.stops), (1, 1));
  }

  #[test]
  fn toggle_alternates() {
    let mut serving = Serving::start(FakeRunner::default());
    serving.toggle();
    assert_eq!(serving.status(), Status::Paused);
    serving.toggle();
    assert_eq!(serving.status(), Status::Serving);
  }

  #[test]
  fn a_failed_start_is_failed_not_serving_and_can_be_retried() {
    let mut serving = Serving::start(FakeRunner { fail_starts: 1, ..Default::default() });
    assert_eq!(serving.status(), Status::Failed);

    serving.pause();
    assert_eq!(serving.status(), Status::Failed, "nothing to pause, and the tray should keep saying why");

    serving.toggle();
    assert_eq!(serving.status(), Status::Serving);
    assert_eq!(serving.runner.starts, 1);
  }

  #[test]
  fn settings_default_to_keep_awake_off_and_survive_a_round_trip() {
    let dir = std::env::temp_dir().join(format!("legato-serving-test-{}", std::process::id()));
    let file = dir.join("nested").join("shell-settings.json");

    assert_eq!(ShellSettings::load(&file), ShellSettings { keep_awake: false, update_check: true }, "missing file");
    ShellSettings { keep_awake: true, update_check: true }.save(&file).unwrap();
    assert_eq!(ShellSettings::load(&file), ShellSettings { keep_awake: true, update_check: true });

    std::fs::write(&file, "{ not json").unwrap();
    assert_eq!(ShellSettings::load(&file), ShellSettings::default(), "corrupt file");

    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn a_file_from_before_the_update_switch_keeps_the_check_on() {
    let dir = std::env::temp_dir().join(format!("legato-serving-test-old-{}", std::process::id()));
    let file = dir.join("shell-settings.json");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&file, r#"{ "keepAwake": true }"#).unwrap();
    assert_eq!(ShellSettings::load(&file), ShellSettings { keep_awake: true, update_check: true });
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn changing_one_setting_keeps_the_other() {
    let dir = std::env::temp_dir().join(format!("legato-serving-test-change-{}", std::process::id()));
    let file = dir.join("shell-settings.json");

    ShellSettings::change(&file, |s| s.update_check = false).unwrap();
    ShellSettings::change(&file, |s| s.keep_awake = true).unwrap();
    assert_eq!(ShellSettings::load(&file), ShellSettings { keep_awake: true, update_check: false });

    ShellSettings::change(&file, |s| s.keep_awake = false).unwrap();
    assert!(!ShellSettings::load(&file).update_check, "turning keep-awake off turned the update check back on");
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
