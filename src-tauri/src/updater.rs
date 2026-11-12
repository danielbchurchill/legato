//! The desktop app's own updates (issue #129), through tauri-plugin-updater.
//!
//! Every release carries a latest.json beside the desktop bundles
//! (.github/workflows/desktop.yml). It names each platform's update and its
//! signature, made with the updater's own key, whose public half is
//! tauri.conf.json's plugins.updater.pubkey. The app asks for it at launch
//! and then at most once a day, downloads a newer release in the
//! background, and tells the webview, which shows it where the server's
//! update pill goes (src/shell/DesktopUpdatePill.tsx).
//!
//! It never installs or restarts on its own. Restarting stops the server
//! any phones are playing from, so that waits for "restart to update".
//!
//! A .deb or .rpm belongs to the package manager, which the updater can't
//! drive, so those installs get a link to the release instead.
//!
//! Settings has a switch for it, on by default and kept with the shell's own
//! settings (serving.rs's ShellSettings), and LEGATO_UPDATE_CHECK=off turns
//! it off for good, the variable that already stops the server's check, so
//! one line does both on a managed install (#497). Off asks GitHub nothing,
//! at launch or later. The switch takes effect without a restart.
//!
//! Off in a build from a checkout (version 0.0.0, which only the release
//! workflow replaces), as the server's own check is. A dev build can be
//! pointed at a stub with LEGATO_UPDATER_ENDPOINT, and LEGATO_UPDATER_PUBKEY
//! when the stub was signed with a key of its own. Nothing else is read from
//! the environment, so a variable can't move an installed app onto another
//! update source.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::instance::Instance;
use crate::serving::{self, ServingState, ShellSettings};
use crate::tray;

pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

// How often the worker wakes to see whether a check is due. Much shorter
// than CHECK_INTERVAL so a laptop that slept through the 24-hour mark
// catches up within the hour, as the server's check does.
const WAKE_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// What the webview hears when an update becomes ready, and null when the
/// switch is turned off and the update it had is withdrawn.
pub const READY_EVENT: &str = "desktop-update://ready";

/// The variable that turns the check off on a managed install. The server
/// reads the same one (server/src/update/check.ts).
pub const OFF_VAR: &str = "LEGATO_UPDATE_CHECK";

const RELEASE_PAGE: &str = "https://github.com/danielbchurchill/legato/releases/tag/v";

/// What the update pill says. src/shell/desktopUpdate.ts mirrors this shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
  pub version: String,
  pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
  /// Downloaded and its signature checked. Installing it restarts the app.
  Restart,
  /// A package manager owns this install, so the release page instead.
  Link { url: String },
}

impl Notice {
  fn link(version: &str) -> Self {
    Self { version: version.to_string(), action: Action::Link { url: format!("{RELEASE_PAGE}{version}") } }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Install {
  /// The .app, the AppImage and the Windows installer replace themselves.
  SelfUpdate,
  /// A .deb or .rpm: dpkg or rpm owns these files, and updating them needs
  /// root. The release page has the next package.
  PackageManager,
}

pub fn install_kind(bundle: Option<BundleType>) -> Install {
  match bundle {
    Some(BundleType::Deb | BundleType::Rpm) => Install::PackageManager,
    _ => Install::SelfUpdate,
  }
}

/// Where to look. Decided at launch, and again on every wake, since the
/// switch can change while the app runs.
#[derive(Debug, PartialEq)]
pub enum Plan {
  /// Not checking while this app runs, and why.
  Off(&'static str),
  /// Switched off in Settings. Nothing is asked, but switching it back on
  /// starts checking again without a restart.
  SwitchedOff,
  /// tauri.conf.json's endpoint and key: the latest GitHub release.
  Release,
  /// A dev build pointed at a stub, with the key the stub's files were
  /// signed with when that isn't the release key.
  Stub { endpoint: Url, pubkey: Option<String> },
}

/// LEGATO_UPDATE_CHECK=off, read as the server reads it: any case, with
/// spaces around it.
pub fn off_by_environment(var: impl Fn(&str) -> Option<String>) -> bool {
  var(OFF_VAR).is_some_and(|value| value.trim().eq_ignore_ascii_case("off"))
}

/// `switched_on` is Settings' switch. Whatever else stops the check wins
/// over it, since those hold for as long as the app runs.
pub fn plan(dev: bool, version: &Version, switched_on: bool, var: impl Fn(&str) -> Option<String>) -> Result<Plan, String> {
  if off_by_environment(&var) {
    return Ok(Plan::Off("LEGATO_UPDATE_CHECK=off"));
  }
  let var = |name: &str| var(name).filter(|value| !value.is_empty());
  if dev {
    let Some(raw) = var("LEGATO_UPDATER_ENDPOINT") else {
      return Ok(Plan::Off("a dev build only checks a stub named by LEGATO_UPDATER_ENDPOINT"));
    };
    let endpoint = Url::parse(&raw).map_err(|e| format!("LEGATO_UPDATER_ENDPOINT={raw} isn't a URL: {e}"))?;
    return Ok(if switched_on { Plan::Stub { endpoint, pubkey: var("LEGATO_UPDATER_PUBKEY") } } else { Plan::SwitchedOff });
  }
  if *version == Version::new(0, 0, 0) {
    return Ok(Plan::Off("built from a checkout rather than a release tag (version 0.0.0)"));
  }
  Ok(if switched_on { Plan::Release } else { Plan::SwitchedOff })
}

/// The last check, kept in the shell's config dir so "at most once a day"
/// holds across launches: an app opened ten times a day still asks once.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckState {
  /// Unix seconds of the last attempt, whether or not it got an answer.
  pub checked_at: u64,
  /// The release that attempt offered, if it offered one.
  pub latest_version: Option<String>,
}

impl CheckState {
  /// A missing or unreadable file means never checked.
  pub fn load(file: &Path) -> Self {
    std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
  }

  pub fn save(&self, file: &Path) -> Result<(), String> {
    if let Some(dir) = file.parent() {
      std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {dir:?}: {e}"))?;
    }
    let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
    std::fs::write(file, json).map_err(|e| format!("couldn't save {file:?}: {e}"))
  }

  /// At most once a day. At launch, also when the last answer was a newer
  /// release than this build: its download lived in the run that ended, so
  /// the notice would otherwise wait a day to come back. A checked_at in the
  /// future (the clock moved back) counts as due, or the check would stay
  /// silent until the clock caught up.
  pub fn is_due(&self, now: u64, current: &Version, launching: bool) -> bool {
    let recent = self.checked_at <= now && now - self.checked_at < CHECK_INTERVAL.as_secs();
    let pending = self.latest_version.as_deref().and_then(|v| Version::parse(v).ok()).is_some_and(|v| v > *current);
    !recent || (launching && pending)
  }
}

struct Ready {
  notice: Notice,
  /// The update and where its verified download was saved. None for a link.
  download: Option<(Update, PathBuf)>,
}

/// Managed state: the update that's ready, if any, and the switch.
pub struct DesktopUpdate {
  ready: Mutex<Option<Ready>>,
  /// Settings' switch, read by the worker on every wake. updater::start
  /// sets it from the file before the first check.
  switched_on: AtomicBool,
  /// Wakes the worker when the switch goes back on, so the check doesn't
  /// wait out the rest of the hour. None while no worker runs.
  wake: Mutex<Option<Sender<()>>>,
}

impl Default for DesktopUpdate {
  fn default() -> Self {
    Self { ready: Mutex::new(None), switched_on: AtomicBool::new(true), wake: Mutex::new(None) }
  }
}

impl DesktopUpdate {
  fn notice(&self) -> Option<Notice> {
    self.ready.lock().ok()?.as_ref().map(|ready| ready.notice.clone())
  }

  fn offers(&self, version: &str) -> bool {
    self.notice().is_some_and(|notice| notice.version == version)
  }

  /// Keeps the update, unless the switch is off. Read under the lock that
  /// withdraw() takes, and set_update_check turns the switch off before it
  /// withdraws, so an update that finishes downloading just as the check is
  /// switched off is either refused here or withdrawn there, never kept.
  fn set(&self, ready: Ready) -> bool {
    let Ok(mut slot) = self.ready.lock() else { return false };
    if !self.switched_on() {
      return false;
    }
    *slot = Some(ready);
    true
  }

  /// Drops the ready update. Returns whether there was one.
  fn withdraw(&self) -> bool {
    self.ready.lock().map(|mut slot| slot.take().is_some()).unwrap_or(false)
  }

  fn download(&self) -> Option<(Update, PathBuf)> {
    self.ready.lock().ok()?.as_ref()?.download.clone()
  }

  fn switched_on(&self) -> bool {
    self.switched_on.load(Ordering::Relaxed)
  }
}

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.state::<Instance>().config_dir(app)?.join("updater.json"))
}

fn unix_now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn env_var(name: &str) -> Option<String> {
  std::env::var(name).ok()
}

/// Starts the worker that checks at launch and then wakes hourly to see
/// whether a day has passed. The first check runs off the main thread, so a
/// slow or unreachable GitHub never holds up the window. Switched off, the
/// worker still runs but asks nothing, so switching it on needs no restart.
pub fn start(app: &AppHandle) {
  let current = app.package_info().version.clone();
  let update = app.state::<DesktopUpdate>();
  match serving::settings_file(app) {
    Ok(settings) => update.switched_on.store(ShellSettings::load(&settings).update_check, Ordering::Relaxed),
    Err(e) => log::error!("[updater] {e}"),
  }
  match plan(tauri::is_dev(), &current, update.switched_on(), env_var) {
    Ok(Plan::Off(why)) => {
      log::info!("[updater] not checking for updates: {why}");
      return;
    }
    Ok(Plan::SwitchedOff) => log::info!("[updater] not checking for updates: switched off in Settings"),
    Ok(_) => {}
    Err(e) => {
      log::error!("[updater] not checking for updates: {e}");
      return;
    }
  }
  let file = match state_file(app) {
    Ok(file) => file,
    Err(e) => {
      log::error!("[updater] {e}");
      return;
    }
  };
  let (wake, woken) = mpsc::channel();
  if let Ok(mut slot) = update.wake.lock() {
    *slot = Some(wake);
  }
  let app = app.clone();
  std::thread::spawn(move || {
    // At launch, or the first wake after the switch went back on: either
    // way a download from an earlier run isn't in hand (CheckState::is_due).
    let mut launching = true;
    loop {
      // Again each time: the switch may have moved since the last wake.
      // Nothing else plan() reads changes while the app runs.
      let switched_on = app.state::<DesktopUpdate>().switched_on();
      if let Ok(source @ (Plan::Release | Plan::Stub { .. })) = plan(tauri::is_dev(), &current, switched_on, env_var) {
        let previous = CheckState::load(&file);
        let now = unix_now();
        if previous.is_due(now, &current, launching) {
          let latest_version = match tauri::async_runtime::block_on(check(&app, &source)) {
            Ok(found) => found,
            // Offline, GitHub down, or no latest.json yet while a release is
            // still uploading. Keep what the last answer said.
            Err(e) => {
              log::warn!("[updater] {e}");
              previous.latest_version
            }
          };
          if let Err(e) = (CheckState { checked_at: now, latest_version }).save(&file) {
            log::error!("[updater] {e}");
          }
        }
        launching = false;
      } else {
        launching = true;
      }
      // An hour, or until the switch goes back on.
      let _ = woken.recv_timeout(WAKE_INTERVAL);
    }
  });
}

/// Asks for latest.json and, when it offers a newer release, gets it ready.
/// Returns the version offered.
async fn check(app: &AppHandle, plan: &Plan) -> Result<Option<String>, String> {
  let mut builder = app.updater_builder();
  if let Plan::Stub { endpoint, pubkey } = plan {
    builder = builder.endpoints(vec![endpoint.clone()]).map_err(|e| e.to_string())?;
    if let Some(pubkey) = pubkey {
      builder = builder.pubkey(pubkey);
    }
  }
  let updater = builder.build().map_err(|e| format!("couldn't set up the update check: {e}"))?;
  let Some(update) = updater.check().await.map_err(|e| format!("update check failed: {e}"))? else {
    return Ok(None);
  };
  let version = update.version.clone();
  let state = app.state::<DesktopUpdate>();
  if state.offers(&version) {
    return Ok(Some(version));
  }

  let ready = match install_kind(tauri::utils::platform::bundle_type()) {
    Install::PackageManager => Ready { notice: Notice::link(&version), download: None },
    Install::SelfUpdate => {
      // download() checks the signature against the public key before it
      // returns anything.
      let bytes =
        update.download(|_, _| {}, || {}).await.map_err(|e| format!("couldn't download Legato {version}: {e}"))?;
      let file = save_download(app, &version, &bytes)?;
      Ready { notice: Notice { version: version.clone(), action: Action::Restart }, download: Some((update, file)) }
    }
  };
  let notice = ready.notice.clone();
  let download = ready.download.as_ref().map(|(_, file)| file.clone());
  if !state.set(ready) {
    // Switched off while it downloaded: nothing to say about it, and
    // nothing left in the cache to install.
    if let Some(file) = download {
      let _ = std::fs::remove_file(file);
    }
    return Ok(Some(version));
  }
  log::info!("[updater] Legato {version} is ready");
  let _ = app.emit(READY_EVENT, &notice);
  Ok(Some(version))
}

fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.state::<Instance>().cache_dir(app)?.join("app-updates"))
}

/// On disk rather than in memory: a bundle carries the server, ffmpeg and
/// fpcalc, and the app may run for days before anyone restarts it.
fn save_download(app: &AppHandle, version: &str, bytes: &[u8]) -> Result<PathBuf, String> {
  let dir = download_dir(app)?;
  // Only the newest download is ever installed.
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {dir:?}: {e}"))?;
  let file = dir.join(format!("legato-{version}.update"));
  std::fs::write(&file, bytes).map_err(|e| format!("couldn't save the update to {file:?}: {e}"))?;
  Ok(file)
}

#[tauri::command]
pub fn desktop_update(state: tauri::State<'_, DesktopUpdate>) -> Option<Notice> {
  state.notice()
}

/// What Settings shows. src/panels/UpdatesGroup.tsx mirrors this shape.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckView {
  /// The switch as this install keeps it.
  pub enabled: bool,
  /// LEGATO_UPDATE_CHECK=off is set, which the switch can't override.
  pub off_by_environment: bool,
}

#[tauri::command]
pub fn update_check_settings(state: tauri::State<'_, DesktopUpdate>) -> UpdateCheckView {
  UpdateCheckView { enabled: state.switched_on(), off_by_environment: off_by_environment(env_var) }
}

/// Settings' switch. Off withdraws an update that's ready and deletes its
/// download, so the pill goes and installing it can't fetch it again; on
/// wakes the worker, which checks at once if a day has passed.
#[tauri::command]
pub fn set_update_check(app: AppHandle, state: tauri::State<'_, DesktopUpdate>, enabled: bool) -> Result<(), String> {
  ShellSettings::change(&serving::settings_file(&app)?, |settings| settings.update_check = enabled)?;
  state.switched_on.store(enabled, Ordering::Relaxed);
  if enabled {
    if let Ok(wake) = state.wake.lock() {
      if let Some(wake) = wake.as_ref() {
        let _ = wake.send(());
      }
    }
  } else if state.withdraw() {
    if let Ok(dir) = download_dir(&app) {
      let _ = std::fs::remove_dir_all(dir);
    }
    let _ = app.emit(READY_EVENT, None::<Notice>);
  }
  Ok(())
}

/// "restart to update": installs the ready update and restarts into it.
#[tauri::command]
pub async fn desktop_update_restart(app: AppHandle) -> Result<(), String> {
  if tauri::is_dev() {
    return Err("a dev build doesn't install updates".into());
  }
  let Some((update, file)) = app.state::<DesktopUpdate>().download() else {
    return Err("there's no update ready to install".into());
  };
  let bytes = match std::fs::read(&file) {
    // It sat on disk since the download, so its signature is checked again.
    Ok(bytes) => {
      update.verify(&bytes).map_err(|e| format!("the downloaded update didn't verify: {e}"))?;
      bytes
    }
    // Swept from the cache: fetch it again, which checks it too.
    Err(_) => update
      .download(|_, _| {}, || {})
      .await
      .map_err(|e| format!("couldn't download Legato {}: {e}", update.version))?,
  };

  // The server stops first. On Windows install() hands over to the
  // installer and exits without the app's own teardown, and the installer
  // can't replace a legato-server.exe that's still running.
  set_serving(&app, false);
  if let Err(e) = update.install(&bytes) {
    set_serving(&app, true);
    return Err(format!("couldn't install Legato {}: {e}", update.version));
  }
  // Through the normal exit, so RunEvent::Exit releases keep-awake, then
  // into the new version.
  app.request_restart();
  Ok(())
}

fn set_serving(app: &AppHandle, on: bool) {
  if let Some(state) = app.try_state::<ServingState>() {
    if let Ok(mut serving) = state.serving.lock() {
      if on {
        serving.resume();
      } else {
        serving.pause();
      }
    }
  }
  tray::refresh(app);
}

#[cfg(test)]
mod tests {
  use super::*;

  fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let vars: Vec<(String, String)> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |name| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
  }

  fn v(raw: &str) -> Version {
    Version::parse(raw).unwrap()
  }

  const DAY: u64 = 24 * 60 * 60;
  const NOW: u64 = 1_800_000_000;

  const ON: bool = true;
  const STUB: (&str, &str) = ("LEGATO_UPDATER_ENDPOINT", "http://127.0.0.1:8971/latest.json");

  #[test]
  fn a_release_build_checks_the_configured_endpoint() {
    assert_eq!(plan(false, &v("0.3.0"), ON, env(&[])).unwrap(), Plan::Release);
  }

  #[test]
  fn a_build_from_a_checkout_never_checks() {
    assert!(matches!(plan(false, &v("0.0.0"), ON, env(&[])).unwrap(), Plan::Off(_)));
  }

  #[test]
  fn an_installed_app_ignores_the_dev_overrides() {
    let vars = env(&[("LEGATO_UPDATER_ENDPOINT", "http://127.0.0.1:9/latest.json"), ("LEGATO_UPDATER_PUBKEY", "x")]);
    assert_eq!(plan(false, &v("0.3.0"), ON, vars).unwrap(), Plan::Release);
  }

  #[test]
  fn dev_checks_only_a_stub() {
    assert!(matches!(plan(true, &v("0.0.0"), ON, env(&[])).unwrap(), Plan::Off(_)));
    assert!(matches!(plan(true, &v("0.0.0"), ON, env(&[("LEGATO_UPDATER_ENDPOINT", "")])).unwrap(), Plan::Off(_)));

    let stub = plan(true, &v("0.0.0"), ON, env(&[STUB]));
    assert_eq!(stub.unwrap(), Plan::Stub { endpoint: Url::parse("http://127.0.0.1:8971/latest.json").unwrap(), pubkey: None });

    let keyed = plan(true, &v("0.0.0"), ON, env(&[STUB, ("LEGATO_UPDATER_PUBKEY", "dW50cnVzdGVk")]));
    assert!(matches!(keyed.unwrap(), Plan::Stub { pubkey: Some(key), .. } if key == "dW50cnVzdGVk"));
  }

  #[test]
  fn refuses_a_stub_that_isnt_a_url() {
    let err = plan(true, &v("0.0.0"), ON, env(&[("LEGATO_UPDATER_ENDPOINT", "latest.json")])).unwrap_err();
    assert!(err.contains("isn't a URL"), "{err}");
  }

  fn link_ready(version: &str) -> Ready {
    Ready { notice: Notice::link(version), download: None }
  }

  #[test]
  fn an_update_found_as_the_switch_goes_off_is_never_kept() {
    let state = DesktopUpdate::default();
    assert!(state.set(link_ready("0.3.0")));
    assert_eq!(state.notice().map(|n| n.version), Some("0.3.0".into()));

    // Switching off: the switch first, then the update it had.
    state.switched_on.store(false, Ordering::Relaxed);
    assert!(state.withdraw());
    assert_eq!(state.notice(), None);
    // A download that finishes afterwards is refused.
    assert!(!state.set(link_ready("0.3.1")));
    assert_eq!(state.notice(), None);
    assert!(!state.withdraw(), "nothing left to withdraw");

    state.switched_on.store(true, Ordering::Relaxed);
    assert!(state.set(link_ready("0.3.1")));
    assert_eq!(state.notice().map(|n| n.version), Some("0.3.1".into()));
  }

  #[test]
  fn switched_off_in_settings_asks_nothing_until_switched_back_on() {
    assert_eq!(plan(false, &v("0.3.0"), false, env(&[])).unwrap(), Plan::SwitchedOff);
    assert_eq!(plan(false, &v("0.3.0"), true, env(&[])).unwrap(), Plan::Release);
    // A dev build's stub obeys the switch too, so the switch can be tried
    // against one.
    assert_eq!(plan(true, &v("0.0.0"), false, env(&[STUB])).unwrap(), Plan::SwitchedOff);
  }

  #[test]
  fn the_switch_doesnt_wake_a_check_that_was_never_going_to_run() {
    // Off for the whole run, so there's no worker to keep for the switch.
    assert!(matches!(plan(false, &v("0.0.0"), false, env(&[])).unwrap(), Plan::Off(_)));
    assert!(matches!(plan(true, &v("0.0.0"), false, env(&[])).unwrap(), Plan::Off(_)));
  }

  #[test]
  fn the_servers_variable_turns_it_off_whatever_the_switch_says() {
    for value in ["off", "OFF", " Off "] {
      let vars = env(&[("LEGATO_UPDATE_CHECK", value)]);
      assert_eq!(plan(false, &v("0.3.0"), ON, &vars).unwrap(), Plan::Off("LEGATO_UPDATE_CHECK=off"), "{value:?}");
      assert_eq!(plan(false, &v("0.3.0"), false, &vars).unwrap(), Plan::Off("LEGATO_UPDATE_CHECK=off"), "{value:?}");
      assert!(off_by_environment(&vars), "{value:?}");
    }
    // A stub too: off means no request at all.
    assert!(matches!(plan(true, &v("0.0.0"), ON, env(&[STUB, ("LEGATO_UPDATE_CHECK", "off")])).unwrap(), Plan::Off(_)));
  }

  #[test]
  fn only_off_turns_it_off() {
    for value in ["", "on", "0", "false", "no"] {
      let vars = env(&[("LEGATO_UPDATE_CHECK", value)]);
      assert_eq!(plan(false, &v("0.3.0"), ON, &vars).unwrap(), Plan::Release, "{value:?}");
      assert!(!off_by_environment(&vars), "{value:?}");
    }
  }

  #[test]
  fn checks_at_most_once_a_day() {
    let never = CheckState::default();
    assert!(never.is_due(NOW, &v("0.2.0"), true));

    let today = CheckState { checked_at: NOW - DAY + 60, latest_version: None };
    assert!(!today.is_due(NOW, &v("0.2.0"), true));
    assert!(!today.is_due(NOW, &v("0.2.0"), false));

    let yesterday = CheckState { checked_at: NOW - DAY, latest_version: None };
    assert!(yesterday.is_due(NOW, &v("0.2.0"), false));
  }

  #[test]
  fn a_clock_that_moved_back_doesnt_silence_the_check() {
    let future = CheckState { checked_at: NOW + 3600, latest_version: None };
    assert!(future.is_due(NOW, &v("0.2.0"), false));
  }

  #[test]
  fn a_newer_release_found_before_a_relaunch_is_fetched_again_at_launch() {
    let found = CheckState { checked_at: NOW - 60, latest_version: Some("0.3.0".into()) };
    assert!(found.is_due(NOW, &v("0.2.0"), true));
    // Only at launch: while running, the download is already in hand.
    assert!(!found.is_due(NOW, &v("0.2.0"), false));
    // Already running it, or something newer.
    assert!(!found.is_due(NOW, &v("0.3.0"), true));
    assert!(!found.is_due(NOW, &v("0.4.0"), true));
  }

  #[test]
  fn an_unreadable_state_file_means_never_checked() {
    let dir = std::env::temp_dir().join(format!("legato-updater-state-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("updater.json");
    std::fs::write(&file, "{ not json").unwrap();
    assert_eq!(CheckState::load(&file), CheckState::default());
    assert_eq!(CheckState::load(&dir.join("missing.json")), CheckState::default());

    let saved = CheckState { checked_at: NOW, latest_version: Some("0.3.0".into()) };
    saved.save(&file).unwrap();
    assert_eq!(CheckState::load(&file), saved);
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn only_packages_a_package_manager_owns_get_a_link() {
    assert_eq!(install_kind(Some(BundleType::Deb)), Install::PackageManager);
    assert_eq!(install_kind(Some(BundleType::Rpm)), Install::PackageManager);
    for bundle in [BundleType::App, BundleType::Dmg, BundleType::AppImage, BundleType::Nsis, BundleType::Msi] {
      assert_eq!(install_kind(Some(bundle.clone())), Install::SelfUpdate, "{bundle:?}");
    }
    assert_eq!(install_kind(None), Install::SelfUpdate);
  }

  #[test]
  fn the_notice_has_the_shape_the_webview_reads() {
    let restart = Notice { version: "0.3.0".into(), action: Action::Restart };
    assert_eq!(serde_json::to_value(&restart).unwrap(), serde_json::json!({ "version": "0.3.0", "action": { "kind": "restart" } }));
    assert_eq!(
      serde_json::to_value(Notice::link("0.3.0")).unwrap(),
      serde_json::json!({
        "version": "0.3.0",
        "action": { "kind": "link", "url": "https://github.com/danielbchurchill/legato/releases/tag/v0.3.0" }
      })
    );
  }
}
