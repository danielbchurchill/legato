//! Media keys, headphone and AirPods buttons, and the OS's now-playing
//! widget for native playback (issue #131), through souvlaki:
//! MPNowPlayingInfoCenter and MPRemoteCommandCenter on macOS, the System
//! Media Transport Controls on Windows, MPRIS on Linux.
//!
//! The frontend sits between the OS and playback.rs in both directions,
//! because it owns the queue. Rust holds the track playing and the one after
//! it, never the ones before, and under repeat-one only the track it loops,
//! so next and previous can't be carried out here.
//! - A button pressed in the OS reaches the webview as
//!   playback://media-control, and nativeMediaControls.ts runs the same
//!   play, pause, next, previous, seek or stop the transport does, which
//!   call playback.rs's commands.
//! - What's playing comes back through the commands below, which the
//!   frontend sends as playback://track-changed and playback://position
//!   move the transport.
//!
//! The cover. The server's cover route needs a session or a media ticket,
//! and a media ticket reads the whole library for as long as its session
//! lasts. Every OS takes the art as a URL, and a URL handed to the OS is out
//! of our hands: MPRIS publishes it on the session bus as mpris:artUrl for
//! any process there to read (`playerctl metadata` prints it), SMTC keeps
//! it, and macOS loads an http one through its own URL loading, cache and
//! all. So the frontend sends the cover's URL, ticket included, to this
//! process only, as it already does a track's stream URL (#185). The shell
//! fetches the image itself and never logs the URL. The OS gets a file://
//! URL to the image it wrote in this instance's cache dir.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::instance::{fnv1a_128, Instance};
use crate::playback::{describe_stream_error, stream_agent};
use crate::tray;

/// What a button pressed in the OS asks the player to do, as
/// playback://media-control carries it to nativeMediaControls.ts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum MediaControl {
  Play,
  Pause,
  Toggle,
  Next,
  Previous,
  Stop,
  Seek { position_ms: u64 },
  SeekBy { offset_ms: i64 },
}

// How far Windows' fast-forward and rewind buttons move. They say only which
// way.
const SEEK_STEP_MS: i64 = 10_000;

fn control_for(event: MediaControlEvent) -> Option<MediaControl> {
  Some(match event {
    MediaControlEvent::Play => MediaControl::Play,
    MediaControlEvent::Pause => MediaControl::Pause,
    MediaControlEvent::Toggle => MediaControl::Toggle,
    MediaControlEvent::Next => MediaControl::Next,
    MediaControlEvent::Previous => MediaControl::Previous,
    MediaControlEvent::Stop => MediaControl::Stop,
    MediaControlEvent::SetPosition(MediaPosition(at)) => MediaControl::Seek { position_ms: at.as_millis() as u64 },
    MediaControlEvent::SeekBy(direction, by) => MediaControl::SeekBy { offset_ms: signed(direction, by.as_millis() as i64) },
    MediaControlEvent::Seek(direction) => MediaControl::SeekBy { offset_ms: signed(direction, SEEK_STEP_MS) },
    // Raise brings the window up (see start). Quitting, volume, shuffle and
    // opening a URI aren't offered.
    _ => return None,
  })
}

fn signed(direction: SeekDirection, ms: i64) -> i64 {
  match direction {
    SeekDirection::Forward => ms,
    SeekDirection::Backward => -ms,
  }
}

/// The track the OS should show, from nativeMediaControls.ts.
#[derive(Deserialize)]
pub struct NowPlayingTrack {
  pub recording_node_id: i64,
  pub title: String,
  pub artist: String,
  pub album: String,
  pub duration_ms: Option<u64>,
  /// The server's cover route with the media ticket: fetched here, never
  /// handed to the OS, never logged. The struct has no Debug, so it can't
  /// be logged by accident either.
  pub cover_url: Option<String>,
}

// What the OS shows, behind souvlaki. A test's surface records what it's
// told.
trait Surface: Send {
  fn set_metadata(&mut self, metadata: MediaMetadata) -> Result<(), String>;
  fn set_playback(&mut self, playback: MediaPlayback) -> Result<(), String>;
}

impl Surface for MediaControls {
  fn set_metadata(&mut self, metadata: MediaMetadata) -> Result<(), String> {
    MediaControls::set_metadata(self, metadata).map_err(|e| e.to_string())
  }

  fn set_playback(&mut self, playback: MediaPlayback) -> Result<(), String> {
    MediaControls::set_playback(self, playback).map_err(|e| e.to_string())
  }
}

struct Track {
  node: i64,
  title: String,
  artist: String,
  album: String,
  duration: Option<Duration>,
}

// A recording's cover, once fetched. No file means it has none, or it
// couldn't be had, and isn't asked for again.
struct Cover {
  node: i64,
  file: Option<PathBuf>,
}

// Where the transport was when it last said, which the OS carries on from.
#[derive(Clone, Copy)]
struct Progress {
  node: i64,
  playing: bool,
  position: Duration,
  at: Instant,
}

struct NowPlaying {
  surface: Box<dyn Surface>,
  cover_dir: PathBuf,
  track: Option<Track>,
  cover: Option<Cover>,
  // The recording whose cover is being fetched.
  fetching: Option<i64>,
  progress: Option<Progress>,
}

fn report(what: &str, result: Result<(), String>) {
  if let Err(e) = result {
    log::warn!("[media-controls] the OS didn't take the {what}: {e}");
  }
}

impl NowPlaying {
  fn new(surface: Box<dyn Surface>, cover_dir: PathBuf) -> Self {
    NowPlaying { surface, cover_dir, track: None, cover: None, fetching: None, progress: None }
  }

  // The track, with its cover once there is one, then the progress again:
  // on macOS a new entry replaces the old one whole, position and all.
  fn publish_track(&mut self) {
    let Some(track) = &self.track else {
      report("metadata", self.surface.set_metadata(MediaMetadata::default()));
      report("playback state", self.surface.set_playback(MediaPlayback::Stopped));
      log::info!("[media-controls] nothing playing: the widget is cleared");
      return;
    };
    let cover_url = self.cover.as_ref().filter(|cover| cover.node == track.node).and_then(|cover| cover.file.as_deref()).map(file_url);
    let non_empty = |text: &str| Some(text.to_owned()).filter(|text| !text.is_empty());
    let (artist, album) = (non_empty(&track.artist), non_empty(&track.album));
    let metadata = MediaMetadata {
      title: Some(&track.title),
      artist: artist.as_deref(),
      album: album.as_deref(),
      cover_url: cover_url.as_deref(),
      duration: track.duration,
    };
    report("metadata", self.surface.set_metadata(metadata));
    // Fields, not their text, and the cover's file name, never its URL.
    log::info!(
      "[media-controls] now playing recording {}: title {}, artist {}, album {}, length {:?}, cover {}",
      track.node,
      if track.title.is_empty() { "empty" } else { "set" },
      if artist.is_some() { "set" } else { "empty" },
      if album.is_some() { "set" } else { "empty" },
      track.duration,
      cover_url.as_deref().and_then(|url| url.rsplit('/').next()).unwrap_or("none"),
    );
    self.publish_progress();
  }

  fn publish_progress(&mut self) {
    let Some(track) = &self.track else { return };
    let (playing, position) = match self.progress {
      // Playing, the OS moves the position on by itself, so where it is now
      // is where it was plus the time since.
      Some(progress) if progress.node == track.node => {
        let since = if progress.playing { progress.at.elapsed() } else { Duration::ZERO };
        (progress.playing, progress.position + since)
      }
      // A new track, before the transport has said where it is.
      Some(progress) => (progress.playing, Duration::ZERO),
      None => (false, Duration::ZERO),
    };
    let progress = Some(MediaPosition(position));
    let playback = if playing { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } };
    report("playback state", self.surface.set_playback(playback));
  }

  // Covers other than the one shown go, so the dir holds one or two.
  fn forget_other_covers(&self) {
    let shown = self.cover.as_ref().and_then(|cover| cover.file.as_deref());
    let Ok(entries) = std::fs::read_dir(&self.cover_dir) else { return };
    for entry in entries.flatten() {
      if Some(entry.path().as_path()) != shown {
        let _ = std::fs::remove_file(entry.path());
      }
    }
  }
}

/// The OS's media controls, once attached. None until then, and for good
/// where there's no way to reach them (Linux without a D-Bus session bus).
#[derive(Default)]
pub struct MediaControlsState(Mutex<Option<NowPlaying>>);

impl MediaControlsState {
  fn set_track(&self, track: NowPlayingTrack) {
    let node = track.recording_node_id;
    let (url, cover_dir) = {
      let mut guard = self.0.lock().unwrap();
      let Some(now) = guard.as_mut() else { return };
      now.track = Some(Track {
        node,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration_ms.map(Duration::from_millis),
      });
      now.publish_track();
      // Sent again for the same recording (its artist and album arrive
      // after its title), the cover it has, or is fetching, does.
      if now.cover.as_ref().is_some_and(|cover| cover.node == node) || now.fetching == Some(node) {
        return;
      }
      let Some(url) = track.cover_url else { return };
      now.fetching = Some(node);
      (url, now.cover_dir.clone())
    };

    let saved = save_cover(&url, &cover_dir);

    let mut guard = self.0.lock().unwrap();
    let Some(now) = guard.as_mut() else { return };
    if now.fetching == Some(node) {
      now.fetching = None;
    }
    // Playback moved on while it was fetched.
    if !now.track.as_ref().is_some_and(|track| track.node == node) {
      if let Ok(file) = saved {
        let _ = std::fs::remove_file(file);
      }
      return;
    }
    let file = saved.map_err(|why| log::info!("[media-controls] no cover for the now-playing widget: {why}")).ok();
    now.cover = Some(Cover { node, file });
    now.publish_track();
    now.forget_other_covers();
  }

  fn set_playback(&self, node: i64, playing: bool, position: Duration) {
    let mut guard = self.0.lock().unwrap();
    let Some(now) = guard.as_mut() else { return };
    now.progress = Some(Progress { node, playing, position, at: Instant::now() });
    now.publish_progress();
  }

  fn clear(&self) {
    let mut guard = self.0.lock().unwrap();
    let Some(now) = guard.as_mut() else { return };
    now.track = None;
    now.progress = None;
    now.publish_track();
  }
}

// More than any cover the server keeps: its largest are 512 px JPEGs.
const COVER_LIMIT: u64 = 8 << 20;

// Fetches the cover and writes it where the OS can read it. A failure says
// what the server answered, never the URL, which carries the media ticket.
fn save_cover(url: &str, dir: &Path) -> Result<PathBuf, String> {
  let response = stream_agent().get(url).call().map_err(|e| describe_stream_error(&e))?;
  let mut bytes = Vec::new();
  response.into_body().into_reader().take(COVER_LIMIT).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
  let extension = image_extension(&bytes).ok_or("it sent something that isn't a JPEG or a PNG")?;
  std::fs::create_dir_all(dir).map_err(|e| format!("couldn't make {}: {e}", dir.display()))?;
  // Named for what's in it: an OS that keeps art by URL never shows the last
  // track's under this one's name.
  let file = dir.join(format!("{:032x}.{extension}", fnv1a_128(&bytes)));
  std::fs::write(&file, &bytes).map_err(|e| format!("couldn't write {}: {e}", file.display()))?;
  Ok(file)
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
    Some("jpg")
  } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    Some("png")
  } else {
    None
  }
}

// The URL souvlaki hands the OS. On Windows it strips "file://" and opens
// the path as it stands. Elsewhere it's a real URL, so anything but a
// path's plain characters is percent-encoded.
fn file_url(path: &Path) -> String {
  if cfg!(windows) {
    return format!("file://{}", path.display());
  }
  let mut url = String::from("file://");
  for &byte in path.as_os_str().as_encoded_bytes() {
    match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => url.push(byte as char),
      other => url.push_str(&format!("%{other:02X}")),
    }
  }
  url
}

/// Starts listening to the OS's media buttons. Where there's no way to,
/// such as Linux without a D-Bus session bus (a headless box, or a session
/// over SSH), playback goes on without them.
pub fn install(app: &AppHandle) {
  let cover_dir = match app.state::<Instance>().cache_dir(app) {
    Ok(dir) => dir.join("now-playing"),
    Err(e) => {
      log::error!("[media-controls] {e}");
      return;
    }
  };
  // The last run's covers.
  let _ = std::fs::remove_dir_all(&cover_dir);

  // Reaching the session bus can wait on it, so not on the main thread.
  // souvlaki's own MPRIS thread panics if it can't connect, so it's only
  // started once a connection here has worked.
  #[cfg(target_os = "linux")]
  {
    let app = app.clone();
    std::thread::spawn(move || match zbus::blocking::Connection::session() {
      Ok(_) => start(&app, cover_dir, None),
      Err(e) => log::info!("[media-controls] no D-Bus session bus, so no MPRIS media keys or now-playing: {e}"),
    });
  }

  // SMTC belongs to a window.
  #[cfg(target_os = "windows")]
  match app.get_webview_window("main").and_then(|window| window.hwnd().ok()) {
    Some(hwnd) => start(app, cover_dir, Some(hwnd.0)),
    None => log::warn!("[media-controls] no window handle for SMTC, so no media keys or now-playing"),
  }

  #[cfg(not(any(target_os = "linux", target_os = "windows")))]
  start(app, cover_dir, None);
}

const SURFACE_NAME: &str = if cfg!(target_os = "macos") {
  "macOS Now Playing"
} else if cfg!(target_os = "windows") {
  "Windows SMTC"
} else {
  "MPRIS"
};

fn start(app: &AppHandle, cover_dir: PathBuf, hwnd: Option<*mut std::ffi::c_void>) {
  // One bus name per process. MPRIS asks a player that can run more than
  // once to add .instance<pid>, and dev instances do run side by side.
  // `playerctl -p legato` still finds every one of them.
  let dbus_name = format!("legato.instance{}", std::process::id());
  let config = PlatformConfig { display_name: "Legato", dbus_name: &dbus_name, hwnd };
  let mut controls = match MediaControls::new(config) {
    Ok(controls) => controls,
    Err(e) => {
      log::warn!("[media-controls] couldn't reach the OS's media controls: {e}");
      return;
    }
  };
  let handle = app.clone();
  let attached = controls.attach(move |event| {
    if event == MediaControlEvent::Raise {
      tray::show_main_window(&handle);
    } else if let Some(control) = control_for(event) {
      log::info!("[media-controls] the OS asked for {control:?}");
      let _ = handle.emit("playback://media-control", control);
    }
  });
  if let Err(e) = attached {
    log::warn!("[media-controls] couldn't listen to the OS's media buttons: {e}");
    return;
  }
  *app.state::<MediaControlsState>().0.lock().unwrap() = Some(NowPlaying::new(Box::new(controls), cover_dir));
  log::info!("[media-controls] listening to the OS's media buttons ({})", SURFACE_NAME);
}

/// The track the OS's widget shows: its text at once, its cover once it's
/// fetched. `async`, so the fetch is off the main thread.
#[tauri::command(async)]
pub fn media_controls_set_track(state: State<MediaControlsState>, track: NowPlayingTrack) {
  state.set_track(track);
}

/// Whether the track is playing, and where. The OS moves the position on by
/// itself while it plays, so this is only sent when that would go wrong: a
/// new track, play or pause, a seek.
#[tauri::command]
pub fn media_controls_set_playback(state: State<MediaControlsState>, recording_node_id: i64, playing: bool, position_ms: u64) {
  state.set_playback(recording_node_id, playing, Duration::from_millis(position_ms));
}

/// Nothing is playing.
#[tauri::command]
pub fn media_controls_clear(state: State<MediaControlsState>) {
  state.clear();
}

#[cfg(test)]
mod tests {
  use std::io::{BufRead, Write};
  use std::sync::Arc;

  use super::*;

  #[derive(Clone, Debug, PartialEq)]
  enum Shown {
    Metadata { title: Option<String>, artist: Option<String>, album: Option<String>, cover_url: Option<String>, duration: Option<Duration> },
    Playback(MediaPlayback),
  }

  #[derive(Clone, Default)]
  struct FakeSurface(Arc<Mutex<Vec<Shown>>>);

  impl Surface for FakeSurface {
    fn set_metadata(&mut self, metadata: MediaMetadata) -> Result<(), String> {
      let owned = |text: Option<&str>| text.map(str::to_owned);
      self.0.lock().unwrap().push(Shown::Metadata {
        title: owned(metadata.title),
        artist: owned(metadata.artist),
        album: owned(metadata.album),
        cover_url: owned(metadata.cover_url),
        duration: metadata.duration,
      });
      Ok(())
    }

    fn set_playback(&mut self, playback: MediaPlayback) -> Result<(), String> {
      self.0.lock().unwrap().push(Shown::Playback(playback));
      Ok(())
    }
  }

  impl FakeSurface {
    fn metadata(&self) -> Vec<Shown> {
      self.0.lock().unwrap().iter().filter(|shown| matches!(shown, Shown::Metadata { .. })).cloned().collect()
    }

    fn last_cover(&self) -> Option<String> {
      self.metadata().into_iter().rev().find_map(|shown| match shown {
        Shown::Metadata { cover_url, .. } => Some(cover_url),
        Shown::Playback(_) => None,
      })?
    }

    fn last_playback(&self) -> Option<MediaPlayback> {
      self.0.lock().unwrap().iter().rev().find_map(|shown| match shown {
        Shown::Playback(playback) => Some(playback.clone()),
        Shown::Metadata { .. } => None,
      })
    }
  }

  fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("legato-media-controls-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
  }

  fn state_with(surface: &FakeSurface, cover_dir: &Path) -> MediaControlsState {
    MediaControlsState(Mutex::new(Some(NowPlaying::new(Box::new(surface.clone()), cover_dir.to_path_buf()))))
  }

  // A stand-in for the server's GET /nodes/:id/cover: `cover` for every
  // node, or a 404 when it's None. `requests` records each request line.
  struct CoverServer {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
  }

  fn cover_server(cover: Option<Vec<u8>>) -> CoverServer {
    cover_server_with(cover, None)
  }

  // The same, answering each request only once `hold` hears something.
  fn cover_server_with(cover: Option<Vec<u8>>, hold: Option<std::sync::mpsc::Receiver<()>>) -> CoverServer {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    std::thread::spawn(move || {
      for mut conn in listener.incoming().flatten() {
        let request = io_first_line(&conn);
        seen.lock().unwrap().push(request);
        if let Some(hold) = &hold {
          let _ = hold.recv();
        }
        let response = match &cover {
          Some(body) => [format!("HTTP/1.1 200 OK\r\ncontent-type: image/jpeg\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).as_bytes(), body].concat(),
          None => b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_vec(),
        };
        let _ = conn.write_all(&response);
      }
    });
    CoverServer { base, requests }
  }

  fn io_first_line(conn: &std::net::TcpStream) -> String {
    let mut lines = std::io::BufReader::new(conn.try_clone().unwrap()).lines();
    let first = lines.next().unwrap().unwrap();
    for line in lines.map_while(Result::ok) {
      if line.is_empty() {
        break;
      }
    }
    first
  }

  fn wait_until(mut ready: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
      if ready() {
        return true;
      }
      std::thread::sleep(Duration::from_millis(10));
    }
    ready()
  }

  // Enough of a JPEG to be taken for one.
  fn jpeg(marker: u8) -> Vec<u8> {
    vec![0xFF, 0xD8, 0xFF, 0xE0, marker, marker, marker]
  }

  fn track(node: i64, title: &str, server: &CoverServer) -> NowPlayingTrack {
    NowPlayingTrack {
      recording_node_id: node,
      title: title.into(),
      artist: String::new(),
      album: String::new(),
      duration_ms: Some(200_000),
      cover_url: Some(format!("{}/api/v1/nodes/{node}/cover?size=full&t=secret-ticket", server.base)),
    }
  }

  #[test]
  fn every_button_the_os_offers_reaches_the_player() {
    let cases = [
      (MediaControlEvent::Play, Some(MediaControl::Play)),
      (MediaControlEvent::Pause, Some(MediaControl::Pause)),
      (MediaControlEvent::Toggle, Some(MediaControl::Toggle)),
      (MediaControlEvent::Next, Some(MediaControl::Next)),
      (MediaControlEvent::Previous, Some(MediaControl::Previous)),
      (MediaControlEvent::Stop, Some(MediaControl::Stop)),
      (MediaControlEvent::SetPosition(MediaPosition(Duration::from_millis(83_500))), Some(MediaControl::Seek { position_ms: 83_500 })),
      (MediaControlEvent::SeekBy(SeekDirection::Backward, Duration::from_secs(15)), Some(MediaControl::SeekBy { offset_ms: -15_000 })),
      (MediaControlEvent::Seek(SeekDirection::Forward), Some(MediaControl::SeekBy { offset_ms: SEEK_STEP_MS })),
      (MediaControlEvent::Quit, None),
      (MediaControlEvent::SetVolume(0.5), None),
    ];
    for (event, control) in cases {
      assert_eq!(control_for(event.clone()), control, "{event:?}");
    }
  }

  // nativeMediaControls.ts switches on `action` and reads these names.
  #[test]
  fn a_control_serializes_as_an_action_tagged_object() {
    assert_eq!(serde_json::to_value(MediaControl::Toggle).unwrap(), serde_json::json!({ "action": "toggle" }));
    assert_eq!(
      serde_json::to_value(MediaControl::Seek { position_ms: 5000 }).unwrap(),
      serde_json::json!({ "action": "seek", "position_ms": 5000 })
    );
    assert_eq!(
      serde_json::to_value(MediaControl::SeekBy { offset_ms: -10_000 }).unwrap(),
      serde_json::json!({ "action": "seek_by", "offset_ms": -10_000 })
    );
  }

  #[cfg(not(windows))]
  #[test]
  fn a_cover_file_becomes_a_url_the_os_can_open() {
    assert_eq!(file_url(Path::new("/home/me/.cache/fm.legato.app/now-playing/ab.jpg")), "file:///home/me/.cache/fm.legato.app/now-playing/ab.jpg");
    assert_eq!(file_url(Path::new("/Users/me/My Music/é.jpg")), "file:///Users/me/My%20Music/%C3%A9.jpg");
  }

  #[test]
  fn only_a_jpeg_or_a_png_counts_as_a_cover() {
    assert_eq!(image_extension(&jpeg(1)), Some("jpg"));
    assert_eq!(image_extension(b"\x89PNG\r\n\x1a\n...."), Some("png"));
    assert_eq!(image_extension(b"<!doctype html>"), None);
    assert_eq!(image_extension(b""), None);
  }

  // The title shows at once and the cover once it's in, as a file the OS
  // reads: the URL it's handed never carries the media ticket.
  #[test]
  fn the_cover_reaches_the_os_as_a_file_without_the_media_ticket() {
    let server = cover_server(Some(jpeg(7)));
    let dir = scratch_dir("cover");
    let surface = FakeSurface::default();
    let state = state_with(&surface, &dir);

    state.set_track(track(1, "Song", &server));

    let shown = surface.metadata();
    assert_eq!(shown.len(), 2, "{shown:?}");
    assert!(matches!(&shown[0], Shown::Metadata { title: Some(title), cover_url: None, duration: Some(_), .. } if title == "Song"));
    let url = surface.last_cover().expect("no cover shown");
    assert!(url.starts_with("file://"), "{url}");
    assert!(!url.contains("secret-ticket"), "{url}");
    let file = PathBuf::from(url.trim_start_matches("file://"));
    assert_eq!(std::fs::read(&file).unwrap(), jpeg(7));
    assert!(file.starts_with(&dir));
    assert_eq!(server.requests.lock().unwrap()[0], "GET /api/v1/nodes/1/cover?size=full&t=secret-ticket HTTP/1.1");
    std::fs::remove_dir_all(&dir).unwrap();
  }

  // The frontend sends a track again when its artist and album arrive. The
  // cover isn't fetched again for it, and the newer text is what's shown.
  #[test]
  fn the_same_recording_sent_again_keeps_its_cover_and_takes_the_new_text() {
    let server = cover_server(Some(jpeg(7)));
    let dir = scratch_dir("again");
    let surface = FakeSurface::default();
    let state = state_with(&surface, &dir);
    state.set_track(track(1, "Song", &server));

    state.set_track(NowPlayingTrack { artist: "Artist".into(), album: "Album".into(), ..track(1, "Song", &server) });

    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let last = surface.metadata().pop().unwrap();
    let Shown::Metadata { artist, album, cover_url, .. } = last else { unreachable!() };
    assert_eq!((artist.as_deref(), album.as_deref()), (Some("Artist"), Some("Album")));
    assert!(cover_url.is_some());
    std::fs::remove_dir_all(&dir).unwrap();
  }

  // A cover that arrives after playback moved on isn't shown on the track
  // playing now, and its file goes.
  #[test]
  fn a_cover_that_arrives_after_its_track_ended_is_not_shown() {
    let (release, hold) = std::sync::mpsc::channel();
    let server = cover_server_with(Some(jpeg(7)), Some(hold));
    let dir = scratch_dir("late");
    let surface = FakeSurface::default();
    let state = Arc::new(state_with(&surface, &dir));
    let first = track(1, "Song", &server);
    let fetching = {
      let state = state.clone();
      std::thread::spawn(move || state.set_track(first))
    };
    assert!(wait_until(|| server.requests.lock().unwrap().len() == 1), "the cover was never asked for");

    state.set_track(NowPlayingTrack { cover_url: None, ..track(2, "Next", &server) });
    release.send(()).unwrap();
    fetching.join().unwrap();

    let Some(Shown::Metadata { title, cover_url, .. }) = surface.metadata().pop() else { unreachable!() };
    assert_eq!((title.as_deref(), cover_url), (Some("Next"), None));
    let left = std::fs::read_dir(&dir).map(|entries| entries.count()).unwrap_or(0);
    assert_eq!(left, 0, "the late cover was left behind");
  }

  #[test]
  fn a_recording_with_no_cover_shows_none_and_is_not_asked_again() {
    let server = cover_server(None);
    let dir = scratch_dir("none");
    let surface = FakeSurface::default();
    let state = state_with(&surface, &dir);

    state.set_track(track(1, "Song", &server));
    state.set_track(track(1, "Song", &server));

    assert_eq!(surface.last_cover(), None);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
  }

  // What a failed fetch says is what the server answered or why it
  // couldn't be reached, never the URL with its ticket.
  #[test]
  fn a_failed_fetch_never_repeats_the_media_ticket() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let refused = save_cover(&format!("http://127.0.0.1:{port}/api/v1/nodes/1/cover?t=secret-ticket"), &scratch_dir("refused")).unwrap_err();
    let missing = save_cover(&format!("{}/api/v1/nodes/1/cover?t=secret-ticket", cover_server(None).base), &scratch_dir("missing")).unwrap_err();

    assert_eq!(missing, "it answered 404");
    assert!(!refused.contains("secret-ticket"), "{refused}");
  }

  // Each new entry on macOS replaces the position with it, so the progress
  // goes again after the track, moved on by the time since it was sent.
  #[test]
  fn the_position_goes_again_after_the_track_and_moves_on_while_playing() {
    let server = cover_server(None);
    let dir = scratch_dir("progress");
    let surface = FakeSurface::default();
    let state = state_with(&surface, &dir);
    state.set_track(track(1, "Song", &server));
    state.set_playback(1, true, Duration::from_secs(30));
    std::thread::sleep(Duration::from_millis(200));

    state.set_track(NowPlayingTrack { artist: "Artist".into(), ..track(1, "Song", &server) });

    let Some(MediaPlayback::Playing { progress: Some(MediaPosition(at)) }) = surface.last_playback() else {
      panic!("{:?}", surface.last_playback());
    };
    assert!(at >= Duration::from_millis(30_200) && at < Duration::from_secs(31), "{at:?}");

    // A new track starts from its beginning until the transport says.
    state.set_track(track(2, "Next", &server));
    assert_eq!(surface.last_playback(), Some(MediaPlayback::Playing { progress: Some(MediaPosition(Duration::ZERO)) }));

    state.set_playback(2, false, Duration::from_secs(4));
    assert_eq!(surface.last_playback(), Some(MediaPlayback::Paused { progress: Some(MediaPosition(Duration::from_secs(4))) }));

    state.clear();
    assert_eq!(surface.last_playback(), Some(MediaPlayback::Stopped));
    assert_eq!(surface.metadata().last(), Some(&Shown::Metadata { title: None, artist: None, album: None, cover_url: None, duration: None }));
  }

  // macOS's real Now Playing, read back from MPNowPlayingInfoCenter: what
  // the menu bar's Now Playing and the lock screen show. Not run by default:
  // it sets this process's now-playing entry, so set LEGATO_TEST_COVER to a
  // real JPEG and run it with --ignored --nocapture on a Mac.
  #[cfg(target_os = "macos")]
  #[test]
  #[ignore]
  fn real_now_playing_on_macos() {
    use now_playing_info::*;
    let cover = std::fs::read(std::env::var("LEGATO_TEST_COVER").expect("set LEGATO_TEST_COVER to a real JPEG")).unwrap();
    let server = cover_server(Some(cover));
    let dir = scratch_dir("real-macos");
    let mut controls = MediaControls::new(PlatformConfig { display_name: "Legato", dbus_name: "legato.test", hwnd: None }).unwrap();
    controls.attach(|_| {}).expect("attach");
    let state = MediaControlsState(Mutex::new(Some(NowPlaying::new(Box::new(controls), dir.clone()))));

    state.set_track(NowPlayingTrack { artist: "Legato Test Artist".into(), album: "Now Playing Check".into(), ..track(1, "Recovery Test 1", &server) });
    state.set_playback(1, true, Duration::from_secs(30));
    assert!(wait_until(artwork_present), "the artwork never reached Now Playing");

    let shown = read();
    eprintln!("Now Playing after set_track + set_playback: {shown:?}");
    assert_eq!(shown.title.as_deref(), Some("Recovery Test 1"));
    assert_eq!(shown.artist.as_deref(), Some("Legato Test Artist"));
    assert_eq!(shown.album.as_deref(), Some("Now Playing Check"));
    assert_eq!(shown.duration, Some(200.0));
    assert!(shown.elapsed.is_some_and(|at| (30.0..31.0).contains(&at)), "{:?}", shown.elapsed);
    assert!(shown.artwork);
    assert_eq!(shown.state, PLAYING);

    state.set_playback(1, false, Duration::from_secs(45));
    let paused = read();
    eprintln!("after pause at 45 s: {paused:?}");
    assert_eq!((paused.state, paused.elapsed), (PAUSED, Some(45.0)));

    state.clear();
    let cleared = read();
    eprintln!("after clear: {cleared:?}");
    assert_eq!(cleared.state, STOPPED);
    assert_eq!(cleared.title, None);
    drop(state);
    let _ = std::fs::remove_dir_all(&dir);
  }

  // Just enough of the Objective-C runtime to read MPNowPlayingInfoCenter
  // back. souvlaki links MediaPlayer.
  #[cfg(target_os = "macos")]
  mod now_playing_info {
    use std::ffi::{c_char, c_void, CStr, CString};

    type Id = *mut c_void;

    pub const PLAYING: usize = 1;
    pub const PAUSED: usize = 2;
    pub const STOPPED: usize = 3;

    #[link(name = "objc")]
    extern "C" {
      fn objc_getClass(name: *const c_char) -> Id;
      fn sel_registerName(name: *const c_char) -> Id;
      fn objc_msgSend();
    }

    #[link(name = "MediaPlayer", kind = "framework")]
    extern "C" {
      static MPMediaItemPropertyTitle: Id;
      static MPMediaItemPropertyArtist: Id;
      static MPMediaItemPropertyAlbumTitle: Id;
      static MPMediaItemPropertyArtwork: Id;
      static MPMediaItemPropertyPlaybackDuration: Id;
      static MPNowPlayingInfoPropertyElapsedPlaybackTime: Id;
    }

    unsafe fn sel(name: &str) -> Id {
      let name = CString::new(name).unwrap();
      sel_registerName(name.as_ptr())
    }

    unsafe fn send(to: Id, name: &str) -> Id {
      let f: unsafe extern "C" fn(Id, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
      f(to, sel(name))
    }

    unsafe fn send_with(to: Id, name: &str, arg: Id) -> Id {
      let f: unsafe extern "C" fn(Id, Id, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
      f(to, sel(name), arg)
    }

    unsafe fn center() -> Id {
      let class = CString::new("MPNowPlayingInfoCenter").unwrap();
      send(objc_getClass(class.as_ptr()), "defaultCenter")
    }

    unsafe fn entry(key: Id) -> Option<Id> {
      let info = send(center(), "nowPlayingInfo");
      if info.is_null() {
        return None;
      }
      Some(send_with(info, "objectForKey:", key)).filter(|value| !value.is_null())
    }

    unsafe fn text(key: Id) -> Option<String> {
      let value = entry(key)?;
      let utf8 = send(value, "UTF8String") as *const c_char;
      Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }

    unsafe fn number(key: Id) -> Option<f64> {
      let value = entry(key)?;
      let f: unsafe extern "C" fn(Id, Id) -> f64 = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
      Some(f(value, sel("doubleValue")))
    }

    #[derive(Debug)]
    #[allow(dead_code)]
    pub struct Shown {
      pub title: Option<String>,
      pub artist: Option<String>,
      pub album: Option<String>,
      pub duration: Option<f64>,
      pub elapsed: Option<f64>,
      pub artwork: bool,
      pub state: usize,
    }

    pub fn artwork_present() -> bool {
      unsafe { entry(MPMediaItemPropertyArtwork).is_some() }
    }

    pub fn read() -> Shown {
      unsafe {
        let f: unsafe extern "C" fn(Id, Id) -> usize = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        Shown {
          title: text(MPMediaItemPropertyTitle),
          artist: text(MPMediaItemPropertyArtist),
          album: text(MPMediaItemPropertyAlbumTitle),
          duration: number(MPMediaItemPropertyPlaybackDuration),
          elapsed: number(MPNowPlayingInfoPropertyElapsedPlaybackTime),
          artwork: artwork_present(),
          state: f(center(), sel("playbackState")),
        }
      }
    }
  }

  // Without OS media controls (no D-Bus session bus) every command does
  // nothing, and nothing is fetched.
  #[test]
  fn without_os_media_controls_nothing_happens() {
    let server = cover_server(Some(jpeg(7)));
    let state = MediaControlsState::default();

    state.set_track(track(1, "Song", &server));
    state.set_playback(1, true, Duration::ZERO);
    state.clear();

    assert!(server.requests.lock().unwrap().is_empty());
  }
}
