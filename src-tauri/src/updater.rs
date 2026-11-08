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
//! Off in a build from a checkout (version 0.0.0, which only the release
//! workflow replaces), as the server's own check is. A dev build can be
//! pointed at a stub with LEGATO_UPDATER_ENDPOINT, and LEGATO_UPDATER_PUBKEY
//! when the stub was signed with a key of its own. Nothing else is read from
//! the environment, so a variable can't move an installed app onto another
//! update source.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::instance::Instance;
use crate::serving::ServingState;
use crate::tray;

pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

// How often the worker wakes to see whether a check is due. Much shorter
// than CHECK_INTERVAL so a laptop that slept through the 24-hour mark
// catches up within the hour, as the server's check does.
const WAKE_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// What the webview hears when an update becomes ready.
pub const READY_EVENT: &str = "desktop-update://ready";

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

/// Where to look, decided once at launch.
#[derive(Debug, PartialEq)]
pub enum Plan {
  /// Not checking, and why.
  Off(&'static str),
  /// tauri.conf.json's endpoint and key: the latest GitHub release.
  Release,
  /// A dev build pointed at a stub, with the key the stub's files were
  /// signed with when that isn't the release key.
  Stub { endpoint: Url, pubkey: Option<String> },
}

pub fn plan(dev: bool, version: &Version, var: impl Fn(&str) -> Option<String>) -> Result<Plan, String> {
  let var = |name: &str| var(name).filter(|value| !value.is_empty());
  if dev {
    let Some(raw) = var("LEGATO_UPDATER_ENDPOINT") else {
      return Ok(Plan::Off("a dev build only checks a stub named by LEGATO_UPDATER_ENDPOINT"));
    };
    let endpoint = Url::parse(&raw).map_err(|e| format!("LEGATO_UPDATER_ENDPOINT={raw} isn't a URL: {e}"))?;
    return Ok(Plan::Stub { endpoint, pubkey: var("LEGATO_UPDATER_PUBKEY") });
  }
  if *version == Version::new(0, 0, 0) {
    return Ok(Plan::Off("built from a checkout rather than a release tag (version 0.0.0)"));
  }
  Ok(Plan::Release)
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

/// Managed state: the update that's ready, if any.
#[derive(Default)]
pub struct DesktopUpdate(Mutex<Option<Ready>>);

impl DesktopUpdate {
  fn notice(&self) -> Option<Notice> {
    self.0.lock().ok()?.as_ref().map(|ready| ready.notice.clone())
  }

  fn offers(&self, version: &str) -> bool {
    self.notice().is_some_and(|notice| notice.version == version)
  }

  fn set(&self, ready: Ready) {
    if let Ok(mut slot) = self.0.lock() {
      *slot = Some(ready);
    }
  }

  fn download(&self) -> Option<(Update, PathBuf)> {
    self.0.lock().ok()?.as_ref()?.download.clone()
  }
}

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.state::<Instance>().config_dir(app)?.join("updater.json"))
}

fn unix_now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Starts the worker that checks at launch and then wakes hourly to see
/// whether a day has passed. The first check runs off the main thread, so a
/// slow or unreachable GitHub never holds up the window.
pub fn start(app: &AppHandle) {
  let current = app.package_info().version.clone();
  let plan = match plan(tauri::is_dev(), &current, |name| std::env::var(name).ok()) {
    Ok(Plan::Off(why)) => {
      log::info!("[updater] not checking for updates: {why}");
      return;
    }
    Ok(plan) => plan,
    Err(e) => {
      log::error!("[updater] not checking for updates: {e}");
      return;
    }
  };
  let file = match state_file(app) {
    Ok(file) => file,
    Err(e) => {
      log::error!("[updater] {e}");
      return;
    }
  };
  let app = app.clone();
  std::thread::spawn(move || {
    let mut launching = true;
    loop {
      let previous = CheckState::load(&file);
      let now = unix_now();
      if previous.is_due(now, &current, launching) {
        let latest_version = match tauri::async_runtime::block_on(check(&app, &plan)) {
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
      std::thread::sleep(WAKE_INTERVAL);
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
  state.set(ready);
  log::info!("[updater] Legato {version} is ready");
  let _ = app.emit(READY_EVENT, &notice);
  Ok(Some(version))
}

/// On disk rather than in memory: a bundle carries the server, ffmpeg and
/// fpcalc, and the app may run for days before anyone restarts it.
fn save_download(app: &AppHandle, version: &str, bytes: &[u8]) -> Result<PathBuf, String> {
  let dir = app.state::<Instance>().cache_dir(app)?.join("app-updates");
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

  #[test]
  fn a_release_build_checks_the_configured_endpoint() {
    assert_eq!(plan(false, &v("0.3.0"), env(&[])).unwrap(), Plan::Release);
  }

  #[test]
  fn a_build_from_a_checkout_never_checks() {
    assert!(matches!(plan(false, &v("0.0.0"), env(&[])).unwrap(), Plan::Off(_)));
  }

  #[test]
  fn an_installed_app_ignores_the_dev_overrides() {
    let vars = env(&[("LEGATO_UPDATER_ENDPOINT", "http://127.0.0.1:9/latest.json"), ("LEGATO_UPDATER_PUBKEY", "x")]);
    assert_eq!(plan(false, &v("0.3.0"), vars).unwrap(), Plan::Release);
  }

  #[test]
  fn dev_checks_only_a_stub() {
    assert!(matches!(plan(true, &v("0.0.0"), env(&[])).unwrap(), Plan::Off(_)));
    assert!(matches!(plan(true, &v("0.0.0"), env(&[("LEGATO_UPDATER_ENDPOINT", "")])).unwrap(), Plan::Off(_)));

    let stub = plan(true, &v("0.0.0"), env(&[("LEGATO_UPDATER_ENDPOINT", "http://127.0.0.1:8971/latest.json")]));
    assert_eq!(stub.unwrap(), Plan::Stub { endpoint: Url::parse("http://127.0.0.1:8971/latest.json").unwrap(), pubkey: None });

    let keyed = plan(
      true,
      &v("0.0.0"),
      env(&[("LEGATO_UPDATER_ENDPOINT", "http://127.0.0.1:8971/latest.json"), ("LEGATO_UPDATER_PUBKEY", "dW50cnVzdGVk")]),
    );
    assert!(matches!(keyed.unwrap(), Plan::Stub { pubkey: Some(key), .. } if key == "dW50cnVzdGVk"));
  }

  #[test]
  fn refuses_a_stub_that_isnt_a_url() {
    let err = plan(true, &v("0.0.0"), env(&[("LEGATO_UPDATER_ENDPOINT", "latest.json")])).unwrap_err();
    assert!(err.contains("isn't a URL"), "{err}");
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
