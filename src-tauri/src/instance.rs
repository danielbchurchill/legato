//! Which server port and data dir this copy of the app runs on (issue #336).
//!
//! A packaged build, and `npx tauri dev` with nothing set, run their server
//! on 8899 with the platform's app data dir for fm.legato.app. A dev run
//! can be given a port and a data dir of its own, so a second `npx tauri
//! dev` runs beside the first without touching its server, database or
//! stored session. scripts/tauri-dev-instance.mjs is the one command that
//! sets all of it, along with the Vite port the shell itself never sees.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Matches the server's own LEGATO_PORT default (server/src/config.ts).
pub const DEFAULT_SERVER_PORT: u16 = 8899;

#[derive(Debug, PartialEq, Eq)]
pub struct Instance {
  pub server_port: u16,
  /// None means the platform's app data dir.
  pub data_dir: Option<PathBuf>,
}

impl Default for Instance {
  fn default() -> Self {
    Self { server_port: DEFAULT_SERVER_PORT, data_dir: None }
  }
}

impl Instance {
  /// Reads LEGATO_PORT and LEGATO_DATA_DIR, the variables the server itself
  /// takes, and passes them on to it. Only in dev: a packaged build has its
  /// frontend's server port baked in, and a variable exported for a
  /// standalone server on the same machine mustn't move the installed app
  /// onto that server's database. An empty value counts as unset.
  pub fn from_env(dev: bool, var: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
    let mut instance = Self::default();
    if !dev {
      return Ok(instance);
    }
    let var = |name: &str| var(name).filter(|value| !value.is_empty());
    if let Some(value) = var("LEGATO_PORT") {
      instance.server_port = match value.parse() {
        Ok(port) if port != 0 => port,
        _ => return Err(format!("LEGATO_PORT={value} isn't a port the server can listen on")),
      };
    }
    if let Some(dir) = var("LEGATO_DATA_DIR") {
      // The app runs from src-tauri/ and its server from server/, so a
      // relative path would name a different directory for each of them.
      let dir = PathBuf::from(dir);
      if dir.is_relative() {
        return Err(format!("LEGATO_DATA_DIR={} has to be an absolute path", dir.display()));
      }
      instance.data_dir = Some(dir);
    }
    Ok(instance)
  }

  pub fn is_default(&self) -> bool {
    *self == Self::default()
  }

  /// An instance off the defaults names its port in the window title, so a
  /// screenshot or `orca computer` can tell two windows apart.
  pub fn window_title(&self, title: &str) -> String {
    if self.is_default() {
      title.to_string()
    } else {
      format!("{title} :{}", self.server_port)
    }
  }

  /// The server's data dir, and where keep-awake finds stream-activity.
  pub fn data_dir(&self, app: &AppHandle) -> Result<PathBuf, String> {
    match &self.data_dir {
      Some(dir) => Ok(dir.clone()),
      None => app.path().app_data_dir().map_err(|e| format!("failed to resolve app data dir: {e}")),
    }
  }

  /// Where the shell keeps its own settings. An instance with its own data
  /// dir keeps them there: on macOS the app config dir is the default
  /// instance's data dir.
  pub fn config_dir(&self, app: &AppHandle) -> Result<PathBuf, String> {
    match &self.data_dir {
      Some(dir) => Ok(dir.clone()),
      None => app.path().app_config_dir().map_err(|e| format!("failed to resolve app config dir: {e}")),
    }
  }

  /// WebKitGTK and WebView2 keep localStorage, cookies and cache in a
  /// directory, which Tauri defaults to the app local data dir. On Linux
  /// that's the same directory as the database, so an instance's own data
  /// dir is laid out the same way. WKWebView ignores it.
  pub fn webview_data_dir(&self) -> Option<PathBuf> {
    self.data_dir.clone()
  }

  /// WKWebView has no data directory to set. It keeps the default store
  /// under ~/Library/WebKit/<binary name>, and every dev build's binary is
  /// called `app`. A store of its own needs an identifier instead (macOS 14
  /// and later), and deriving it from the data dir gives an instance the
  /// same store, and so the same session, every time it starts. WebKitGTK
  /// and WebView2 ignore it.
  pub fn webview_store_id(&self) -> Option<[u8; 16]> {
    let dir = self.data_dir.as_ref()?;
    Some(fnv1a_128(dir.as_os_str().as_encoded_bytes()).to_be_bytes())
  }
}

/// 128-bit FNV-1a: stable across Rust releases, unlike std's DefaultHasher,
/// so a toolchain update doesn't hand an instance a fresh webview store.
fn fnv1a_128(bytes: &[u8]) -> u128 {
  const OFFSET_BASIS: u128 = 0x6c62272e07bb014262b821756295c58d;
  const PRIME: u128 = 0x0000000001000000000000000000013b;
  bytes.iter().fold(OFFSET_BASIS, |hash, byte| (hash ^ u128::from(*byte)).wrapping_mul(PRIME))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let vars: Vec<(String, String)> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |name| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
  }

  fn absolute(name: &str) -> String {
    std::env::temp_dir().join(name).to_string_lossy().into_owned()
  }

  #[test]
  fn with_nothing_set_dev_runs_on_the_defaults() {
    let instance = Instance::from_env(true, env(&[])).unwrap();
    assert_eq!(instance, Instance { server_port: 8899, data_dir: None });
    assert!(instance.is_default());
    assert_eq!(instance.window_title("Legato"), "Legato");
    assert_eq!(instance.webview_data_dir(), None);
    assert_eq!(instance.webview_store_id(), None);
  }

  #[test]
  fn a_packaged_build_ignores_the_overrides() {
    let vars = env(&[("LEGATO_PORT", "8906"), ("LEGATO_DATA_DIR", &absolute("legato-a"))]);
    assert_eq!(Instance::from_env(false, vars).unwrap(), Instance::default());
  }

  #[test]
  fn dev_takes_a_port_and_data_dir_of_its_own() {
    let dir = absolute("legato-a");
    let instance = Instance::from_env(true, env(&[("LEGATO_PORT", "8906"), ("LEGATO_DATA_DIR", &dir)])).unwrap();
    assert_eq!(instance, Instance { server_port: 8906, data_dir: Some(PathBuf::from(&dir)) });
    assert_eq!(instance.window_title("Legato"), "Legato :8906");
    assert_eq!(instance.webview_data_dir(), Some(PathBuf::from(&dir)));
  }

  #[test]
  fn a_data_dir_alone_still_marks_the_window() {
    let instance = Instance::from_env(true, env(&[("LEGATO_DATA_DIR", &absolute("legato-a"))])).unwrap();
    assert_eq!(instance.window_title("Legato"), "Legato :8899");
  }

  #[test]
  fn empty_values_count_as_unset() {
    let instance = Instance::from_env(true, env(&[("LEGATO_PORT", ""), ("LEGATO_DATA_DIR", "")])).unwrap();
    assert!(instance.is_default());
  }

  #[test]
  fn refuses_a_port_the_server_cant_listen_on() {
    for port in ["0", "65536", "eighty", "-1"] {
      assert!(Instance::from_env(true, env(&[("LEGATO_PORT", port)])).is_err(), "accepted LEGATO_PORT={port}");
    }
  }

  #[test]
  fn refuses_a_relative_data_dir() {
    let err = Instance::from_env(true, env(&[("LEGATO_DATA_DIR", "scratch.local/a")])).unwrap_err();
    assert!(err.contains("absolute"), "{err}");
  }

  #[test]
  fn each_data_dir_gets_its_own_webview_store_every_time() {
    let store = |name: &str| {
      let dir = absolute(name);
      Instance::from_env(true, env(&[("LEGATO_DATA_DIR", &dir)])).unwrap().webview_store_id().unwrap()
    };
    assert_eq!(store("legato-a"), store("legato-a"));
    assert_ne!(store("legato-a"), store("legato-b"));
  }

  #[test]
  fn fnv1a_128_matches_the_reference_vectors() {
    // From the FNV reference implementation's test suite.
    assert_eq!(fnv1a_128(b""), 0x6c62272e07bb014262b821756295c58d);
    assert_eq!(fnv1a_128(b"a"), 0xd228cb696f1a8caf78912b704e4a8964);
  }
}
