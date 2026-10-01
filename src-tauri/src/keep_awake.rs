//! "Keep this computer awake while serving" (issue #130): an opt-in power
//! assertion that stops the machine idle-sleeping out from under someone
//! listening to its library from another device, and lets go once nothing
//! has streamed for a while.
//!
//! The server tells us when it last streamed: every audio byte that leaves
//! `GET /files/:id/stream` moves a Unix-ms timestamp it writes to
//! `<data dir>/stream-activity` (server/src/stream/activity.ts, path passed
//! down in server_process.rs). This module reads that file on a timer and
//! holds the assertion while the timestamp is younger than IDLE_RELEASE.
//!
//! Every platform's assertion stops *idle* sleep only. The display still
//! turns off, and closing a laptop lid or choosing Sleep still sleeps.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

/// How long after the last streamed byte the assertion is held. Longer than
/// most tracks on purpose: a browser often buffers a whole track in its
/// first few seconds, then fetches nothing until the next one starts, and
/// that gap must not count as "stopped listening".
pub const IDLE_RELEASE: Duration = Duration::from_secs(15 * 60);

/// How often the worker re-reads the activity file. The server rewrites it
/// at most every 30 seconds, so polling faster would learn nothing new.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Whether the assertion should be held right now. A timestamp from the
/// future (the clock stepped backwards since it was written) counts as
/// "just streamed": being awake a little too long beats sleeping mid-song.
pub fn should_hold(enabled: bool, serving: bool, last_streamed: Option<SystemTime>, now: SystemTime) -> bool {
  if !enabled || !serving {
    return false;
  }
  match last_streamed {
    None => false,
    Some(at) => now.duration_since(at).map_or(true, |since| since < IDLE_RELEASE),
  }
}

/// The file holds one decimal number; anything else (missing, empty,
/// mid-rewrite on a platform where rename isn't atomic) reads as "never".
pub fn read_last_streamed(file: &Path) -> Option<SystemTime> {
  let millis: u64 = std::fs::read_to_string(file).ok()?.trim().parse().ok()?;
  UNIX_EPOCH.checked_add(Duration::from_millis(millis))
}

pub trait PowerAssertion {
  fn acquire(&mut self) -> Result<(), String>;
  fn release(&mut self);
}

/// Turns "should it be held" into acquire/release calls, once per change.
/// A failed acquire is retried on the next tick, but logged only the first
/// time: a machine whose logind refuses us refuses every 30 seconds.
pub struct Holder<A: PowerAssertion> {
  assertion: A,
  held: bool,
  reported_failure: bool,
}

impl<A: PowerAssertion> Holder<A> {
  pub fn new(assertion: A) -> Self {
    Self { assertion, held: false, reported_failure: false }
  }

  #[cfg(test)]
  pub fn is_held(&self) -> bool {
    self.held
  }

  pub fn apply(&mut self, want: bool) {
    if want && !self.held {
      match self.assertion.acquire() {
        Ok(()) => {
          log::info!("[keep-awake] holding a sleep assertion while serving");
          self.held = true;
          self.reported_failure = false;
        }
        Err(e) => {
          if !self.reported_failure {
            log::error!("[keep-awake] couldn't keep this computer awake: {e}");
          }
          self.reported_failure = true;
        }
      }
    } else if !want {
      if self.held {
        log::info!("[keep-awake] nothing streamed for a while, releasing the sleep assertion");
        self.assertion.release();
        self.held = false;
      }
      // Wanting nothing again resets the log-once latch, so turning the
      // setting back on later reports a failure afresh.
      self.reported_failure = false;
    }
  }
}

enum Message {
  Wake,
  Shutdown,
}

/// Managed state: the channel to the worker thread.
pub struct KeepAwake(std::sync::Mutex<Sender<Message>>);

impl KeepAwake {
  /// Re-evaluate now rather than on the next tick, after the setting or
  /// the serving state changed.
  pub fn wake(&self) {
    if let Ok(tx) = self.0.lock() {
      let _ = tx.send(Message::Wake);
    }
  }

  /// Release the assertion and stop the worker. Process exit would release
  /// it anyway (powerd drops a dead process's assertions, Windows execution
  /// state dies with its thread, and the Linux inhibitor's stdin pipe closes),
  /// so this is tidiness, not the only line of defense.
  pub fn shutdown(&self) {
    if let Ok(tx) = self.0.lock() {
      let _ = tx.send(Message::Shutdown);
    }
  }
}

/// Starts the worker. `inputs` answers (setting enabled, server serving)
/// each tick. Every acquire and release happens on this one thread, which
/// SetThreadExecutionState requires: it scopes its state to the calling
/// thread, so a release from another thread would silently do nothing.
pub fn spawn_worker<F>(activity_file: PathBuf, inputs: F) -> KeepAwake
where
  F: Fn() -> (bool, bool) + Send + 'static,
{
  let (tx, rx) = mpsc::channel();
  std::thread::Builder::new()
    .name("keep-awake".into())
    .spawn(move || {
      let mut holder = Holder::new(platform::Assertion::default());
      loop {
        let (enabled, serving) = inputs();
        let last = read_last_streamed(&activity_file);
        holder.apply(should_hold(enabled, serving, last, SystemTime::now()));
        match rx.recv_timeout(POLL_INTERVAL) {
          Ok(Message::Wake) | Err(RecvTimeoutError::Timeout) => continue,
          Ok(Message::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
        }
      }
      holder.apply(false);
    })
    .expect("failed to start the keep-awake thread");
  KeepAwake(std::sync::Mutex::new(tx))
}

pub fn wake(app: &AppHandle) {
  if let Some(keep_awake) = app.try_state::<KeepAwake>() {
    keep_awake.wake();
  }
}

/// Whether this machine can hold an assertion at all. Only Linux can say
/// no, when systemd-inhibit isn't installed (a non-systemd distro).
pub fn available() -> bool {
  platform::available()
}

#[cfg(target_os = "macos")]
mod platform {
  use std::ffi::{c_char, c_void, CString};

  type CFStringRef = *const c_void;
  type IOPMAssertionID = u32;

  const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
  const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
  // The value of kIOPMAssertionTypePreventUserIdleSystemSleep. Idle
  // *system* sleep only: the display may still sleep, which is what a
  // machine serving audio to another room wants.
  const ASSERTION_TYPE: &str = "PreventUserIdleSystemSleep";
  // Shown to the user by `pmset -g assertions` and Activity Monitor.
  const ASSERTION_NAME: &str = "Legato is serving your music library";

  #[link(name = "CoreFoundation", kind = "framework")]
  extern "C" {
    fn CFStringCreateWithCString(alloc: *const c_void, c_str: *const c_char, encoding: u32) -> CFStringRef;
    fn CFRelease(cf: *const c_void);
  }

  #[link(name = "IOKit", kind = "framework")]
  extern "C" {
    fn IOPMAssertionCreateWithName(
      assertion_type: CFStringRef,
      level: u32,
      name: CFStringRef,
      assertion_id: *mut IOPMAssertionID,
    ) -> i32;
    fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> i32;
  }

  fn cf_string(s: &str) -> CFStringRef {
    let c = CString::new(s).expect("assertion strings have no NUL bytes");
    unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8) }
  }

  #[derive(Default)]
  pub struct Assertion(Option<IOPMAssertionID>);

  impl super::PowerAssertion for Assertion {
    fn acquire(&mut self) -> Result<(), String> {
      let assertion_type = cf_string(ASSERTION_TYPE);
      let name = cf_string(ASSERTION_NAME);
      let mut id: IOPMAssertionID = 0;
      let result = unsafe { IOPMAssertionCreateWithName(assertion_type, K_IOPM_ASSERTION_LEVEL_ON, name, &mut id) };
      unsafe {
        CFRelease(assertion_type);
        CFRelease(name);
      }
      if result != 0 {
        return Err(format!("IOPMAssertionCreateWithName returned IOReturn {result:#x}"));
      }
      self.0 = Some(id);
      Ok(())
    }

    fn release(&mut self) {
      if let Some(id) = self.0.take() {
        unsafe { IOPMAssertionRelease(id) };
      }
    }
  }

  pub fn available() -> bool {
    true
  }
}

#[cfg(target_os = "windows")]
mod platform {
  const ES_CONTINUOUS: u32 = 0x8000_0000;
  const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

  #[link(name = "kernel32")]
  extern "system" {
    fn SetThreadExecutionState(es_flags: u32) -> u32;
  }

  #[derive(Default)]
  pub struct Assertion;

  // ES_SYSTEM_REQUIRED without ES_DISPLAY_REQUIRED: the system stays up,
  // the screen may still turn off. ES_CONTINUOUS makes it stick until the
  // same thread clears it, which is why spawn_worker keeps every call on
  // one thread.
  impl super::PowerAssertion for Assertion {
    fn acquire(&mut self) -> Result<(), String> {
      if unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } == 0 {
        return Err("SetThreadExecutionState refused ES_SYSTEM_REQUIRED".into());
      }
      Ok(())
    }

    fn release(&mut self) {
      unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    }
  }

  pub fn available() -> bool {
    true
  }
}

#[cfg(target_os = "linux")]
mod platform {
  use std::io::Read;
  use std::process::{Child, Command, Stdio};
  use std::time::Duration;

  // A logind "sleep" inhibitor, taken through systemd-inhibit rather than
  // by speaking D-Bus ourselves, which would mean a D-Bus crate for one
  // call. logind honors it whatever the desktop is (COSMIC, GNOME, KDE),
  // because they all suspend through logind.
  //
  // The command it runs is `cat` on a pipe from us, not `sleep infinity`.
  // That's what makes the lock die with Legato even on a SIGKILL or crash,
  // when no cleanup code runs: the kernel closes our end of the pipe, cat
  // reads EOF and exits, and systemd-inhibit exits with it.
  #[derive(Default)]
  pub struct Assertion(Option<Child>);

  impl super::PowerAssertion for Assertion {
    fn acquire(&mut self) -> Result<(), String> {
      let mut child = Command::new("systemd-inhibit")
        .args([
          "--what=sleep",
          "--who=Legato",
          "--why=Serving your music library",
          "--mode=block",
          "cat",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run systemd-inhibit: {e}"))?;

      // systemd-inhibit exits straight away when logind says no (no system
      // bus, a policy refusing the lock). A short wait catches that, so the
      // failure is logged with its reason instead of passing as "held".
      std::thread::sleep(Duration::from_millis(200));
      if let Ok(Some(status)) = child.try_wait() {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
          let _ = pipe.read_to_string(&mut stderr);
        }
        return Err(format!("systemd-inhibit exited with {status}: {}", stderr.trim()));
      }
      self.0 = Some(child);
      Ok(())
    }

    fn release(&mut self) {
      if let Some(mut child) = self.0.take() {
        let _ = child.kill();
        let _ = child.wait();
      }
    }
  }

  pub fn available() -> bool {
    std::env::var_os("PATH")
      .map(|path| std::env::split_paths(&path).any(|dir| dir.join("systemd-inhibit").is_file()))
      .unwrap_or(false)
  }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
  #[derive(Default)]
  pub struct Assertion;

  impl super::PowerAssertion for Assertion {
    fn acquire(&mut self) -> Result<(), String> {
      Err("keeping the computer awake isn't supported on this platform".into())
    }

    fn release(&mut self) {}
  }

  pub fn available() -> bool {
    false
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const MINUTE: Duration = Duration::from_secs(60);

  fn t(minutes: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_700_000_000) + MINUTE * minutes as u32
  }

  #[derive(Default)]
  struct FakeAssertion {
    acquires: u32,
    releases: u32,
    fail: bool,
  }

  impl PowerAssertion for FakeAssertion {
    fn acquire(&mut self) -> Result<(), String> {
      if self.fail {
        return Err("refused".into());
      }
      self.acquires += 1;
      Ok(())
    }
    fn release(&mut self) {
      self.releases += 1;
    }
  }

  #[test]
  fn holds_only_when_enabled_serving_and_recently_streamed() {
    let recent = Some(t(0));
    assert!(should_hold(true, true, recent, t(1)));
    assert!(!should_hold(false, true, recent, t(1)), "the setting is opt-in");
    assert!(!should_hold(true, false, recent, t(1)), "a paused server isn't serving anyone");
    assert!(!should_hold(true, true, None, t(1)), "nothing has streamed since the server started");
  }

  #[test]
  fn releases_once_the_idle_window_passes() {
    let last = Some(t(0));
    assert!(should_hold(true, true, last, t(14)));
    assert!(should_hold(true, true, last, t(0) + IDLE_RELEASE - Duration::from_secs(1)));
    assert!(!should_hold(true, true, last, t(0) + IDLE_RELEASE));
    assert!(!should_hold(true, true, last, t(60)));
  }

  #[test]
  fn a_timestamp_from_the_future_counts_as_just_streamed() {
    assert!(should_hold(true, true, Some(t(5)), t(0)));
  }

  // A listening session as the worker sees it, tick by tick: the setting
  // goes on, a track streams, the listener stops, and later comes back.
  #[test]
  fn holder_acquires_and_releases_once_per_session() {
    let mut holder = Holder::new(FakeAssertion::default());
    let mut tick = |last: Option<SystemTime>, now| holder.apply(should_hold(true, true, last, now));

    tick(None, t(0));
    tick(Some(t(1)), t(1));
    tick(Some(t(4)), t(4));
    tick(Some(t(4)), t(10));
    tick(Some(t(4)), t(19)); // 15 minutes after the last byte
    tick(Some(t(4)), t(30));
    tick(Some(t(40)), t(40));

    assert!(holder.is_held());
    assert_eq!(holder.assertion.acquires, 2);
    assert_eq!(holder.assertion.releases, 1);
  }

  #[test]
  fn turning_the_setting_off_releases_immediately() {
    let mut holder = Holder::new(FakeAssertion::default());
    holder.apply(should_hold(true, true, Some(t(0)), t(1)));
    holder.apply(should_hold(false, true, Some(t(0)), t(1)));
    assert!(!holder.is_held());
    assert_eq!(holder.assertion.releases, 1);
  }

  #[test]
  fn a_failed_acquire_is_not_counted_as_held_and_is_retried() {
    let mut holder = Holder::new(FakeAssertion { fail: true, ..Default::default() });
    holder.apply(true);
    assert!(!holder.is_held());
    holder.apply(false);
    assert_eq!(holder.assertion.releases, 0, "nothing to release after a failed acquire");

    holder.assertion.fail = false;
    holder.apply(true);
    assert!(holder.is_held());
  }

  // Takes the real OS assertion and asks the OS whether it's there. Ignored
  // by default since it touches system power state:
  //   cargo test -- --ignored real_assertion_smoke_test
  //
  // macOS and Linux only: Windows' `powercfg /requests` needs an elevated
  // shell, so there the manual check in the PR applies instead.
  #[cfg(any(target_os = "macos", target_os = "linux"))]
  #[test]
  #[ignore]
  fn real_assertion_smoke_test() {
    #[cfg(target_os = "macos")]
    let (program, args, needle): (&str, &[&str], &str) =
      ("pmset", &["-g", "assertions"], "Legato is serving your music library");
    #[cfg(target_os = "linux")]
    let (program, args, needle): (&str, &[&str], &str) = ("systemd-inhibit", &["--list"], "Serving your music library");

    let listed = || {
      let out = std::process::Command::new(program).args(args).output().expect("query the OS's power assertions");
      String::from_utf8_lossy(&out.stdout).contains(needle)
    };

    let mut assertion = platform::Assertion::default();
    assertion.acquire().expect("acquire");
    assert!(listed(), "{program} doesn't list the assertion while held");
    assertion.release();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!listed(), "{program} still lists the assertion after release");
  }

  #[test]
  fn reads_the_servers_activity_file() {
    let dir = std::env::temp_dir().join(format!("legato-keep-awake-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("stream-activity");

    assert_eq!(read_last_streamed(&file), None, "missing file");
    std::fs::write(&file, "1700000000000").unwrap();
    assert_eq!(read_last_streamed(&file), Some(UNIX_EPOCH + Duration::from_millis(1_700_000_000_000)));
    std::fs::write(&file, "").unwrap();
    assert_eq!(read_last_streamed(&file), None, "empty file");
    std::fs::write(&file, "not a number").unwrap();
    assert_eq!(read_last_streamed(&file), None, "garbage");

    std::fs::remove_dir_all(&dir).unwrap();
  }
}
