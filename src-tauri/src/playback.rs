use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, OutputStream, OutputStreamBuilder, Sink, Source};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

// A larger BufReader alone isn't enough for a network-mounted library
// (confirmed live against an NFS mount over Tailscale): it only changes
// how much data one read() call asks for, and that call still happens
// synchronously on symphonia's decode path, in step with real-time
// playback. One slow NFS round trip — a retransmit, a server-side GETATTR
// revalidation, anything that stalls a couple hundred ms — still starves
// cpal's output callback and is audible as a pop, no matter how big the
// buffer is, because nothing is fetching ahead of where decode is.
//
// This instead reads the file continuously on its own background thread,
// as fast as the network/disk allows, into a growing in-memory buffer.
// Decode only ever blocks on that buffer (a Mutex + Condvar, not the
// network), and because the background thread has no obligation to keep
// pace with real-time playback — only to run flat out — it's almost
// always already well ahead of whatever byte decode actually needs next,
// absorbing exactly the kind of transient stall that a bigger BufReader
// couldn't.
struct NetworkAheadReader {
  shared: Arc<Shared>,
  pos: u64,
}

struct Shared {
  state: Mutex<PrefetchState>,
  ready: Condvar,
  len: u64,
}

struct PrefetchState {
  buf: Vec<u8>,
  // None while the background thread is still reading. Some(Ok(())) once
  // it's reached EOF. Some(Err(_)) if the underlying read failed partway
  // through (the mount vanishing mid-track, say) — surfaced to the decode
  // thread as a real io::Error instead of a silent truncation that would
  // otherwise look like "the track just ended early."
  done: Option<io::Result<()>>,
}

impl NetworkAheadReader {
  fn new(mut file: File) -> io::Result<Self> {
    let len = file.metadata()?.len();
    // Capped, not because files here ever approach it, but so a
    // surprising metadata length can't turn into an oversized upfront
    // allocation before a single byte has actually been read.
    let initial_capacity = len.min(64 << 20) as usize;
    let shared = Arc::new(Shared {
      state: Mutex::new(PrefetchState { buf: Vec::with_capacity(initial_capacity), done: None }),
      ready: Condvar::new(),
      len,
    });

    let background = shared.clone();
    std::thread::spawn(move || {
      let mut chunk = vec![0u8; 256 * 1024];
      loop {
        match file.read(&mut chunk) {
          Ok(0) => {
            let mut state = background.state.lock().unwrap();
            state.done = Some(Ok(()));
            background.ready.notify_all();
            break;
          }
          Ok(n) => {
            let mut state = background.state.lock().unwrap();
            state.buf.extend_from_slice(&chunk[..n]);
            background.ready.notify_all();
          }
          Err(e) => {
            let mut state = background.state.lock().unwrap();
            state.done = Some(Err(e));
            background.ready.notify_all();
            break;
          }
        }
      }
    });

    Ok(NetworkAheadReader { shared, pos: 0 })
  }
}

impl Read for NetworkAheadReader {
  fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
    let mut state = self.shared.state.lock().unwrap();
    loop {
      let available = state.buf.len() as u64 - self.pos;
      if available > 0 {
        let n = available.min(out.len() as u64) as usize;
        let start = self.pos as usize;
        out[..n].copy_from_slice(&state.buf[start..start + n]);
        self.pos += n as u64;
        return Ok(n);
      }
      match &state.done {
        Some(Ok(())) => return Ok(0),
        Some(Err(e)) => return Err(io::Error::new(e.kind(), e.to_string())),
        None => state = self.shared.ready.wait(state).unwrap(),
      }
    }
  }
}

impl Seek for NetworkAheadReader {
  fn seek(&mut self, seek: SeekFrom) -> io::Result<u64> {
    let target = match seek {
      SeekFrom::Start(n) => n,
      SeekFrom::End(n) => (self.shared.len as i64 + n).max(0) as u64,
      SeekFrom::Current(n) => (self.pos as i64 + n).max(0) as u64,
    };

    // A seek is really just a read that discards what it reads — it needs
    // the same wait, since the target byte may not have arrived yet
    // either. The whole file stays buffered once downloaded (nothing is
    // ever evicted), so seeking backward is always immediate.
    let mut state = self.shared.state.lock().unwrap();
    while (state.buf.len() as u64) < target {
      match &state.done {
        Some(Ok(())) => break,
        Some(Err(e)) => return Err(io::Error::new(e.kind(), e.to_string())),
        None => state = self.shared.ready.wait(state).unwrap(),
      }
    }

    self.pos = target;
    Ok(target)
  }
}

// Desktop playback engine — replaces the fixed-medley
// play_native_gapless_spike command (kept alive, debug-gated, as a smoke
// test) with real queue control. Per the MVP roadmap's M6 architecture
// note: this module never talks to the server's DB directly. React
// resolves a recording node id to a file path + ReplayGain via
// POST /api/v1/queue/resolve (the same call the remote/WASM path needs)
// and hands Rust only the resolved plan — one implementation of "turn a
// node into a file" instead of two that can drift.

#[derive(Clone, Deserialize)]
pub struct QueueTrack {
  pub file_path: String,
  pub recording_node_id: i64,
  /// ReplayGain track gain in dB, applied directly via rodio's
  /// amplify_decibel — None means "no tag, play at 0dB."
  pub replaygain_track_gain: Option<f32>,
}

#[derive(Clone, Serialize)]
pub struct PositionEvent {
  pub position_ms: u64,
  pub recording_node_id: Option<i64>,
}

#[derive(Clone, Serialize)]
pub struct TrackChangedEvent {
  pub recording_node_id: Option<i64>,
}

#[derive(Clone, Serialize)]
pub struct QueueStatus {
  pub playing: bool,
  pub position_ms: u64,
  pub current_recording_node_id: Option<i64>,
  pub queue_len: usize,
  pub volume: f32,
}

struct Session {
  // Held for the lifetime of playback — dropping it stops output.
  _stream: OutputStream,
  sink: Sink,
  // Tracks appended to the sink, in append order, front = currently
  // playing. rodio's Sink doesn't expose "which source is this," so this
  // is what lets the monitor thread turn "sink.len() decreased" into
  // "here's the recording_node_id that's now playing."
  queue: VecDeque<QueueTrack>,
}

// cpal's CoreAudio backend (macOS only) stores its device property-change
// listener as a bare `Box<dyn FnMut()>` with no `+ Send` bound, so
// `cpal::Stream` — and therefore `_stream` above — fails Rust's automatic
// Send inference on macOS specifically (ALSA and WASAPI have no such
// field, which is why this only surfaces there). The callback itself
// captures nothing thread-affine — it's cpal's own hot-plug/config-change
// bookkeeping, not the realtime audio render path, which CoreAudio always
// runs on its own OS-managed thread regardless of which thread opened the
// stream — and every access to a Session already goes through
// PlaybackState's Mutex, so it's never touched from two threads at once.
// This is a known gap in cpal's own type (RustAudio/cpal upstream), not a
// Legato bug; asserting Send here is the standard workaround.
unsafe impl Send for Session {}

pub struct PlaybackState {
  session: Arc<Mutex<Option<Session>>>,
  // Lives outside Session (and outside the Mutex<Option<_>> that gets
  // wiped to None on every queue_stop) specifically so it survives across
  // stop/restart — rodio's own Sink::volume resets to 1.0 on every new
  // Sink, and a user's volume choice shouldn't reset every time the queue
  // empties and refills.
  volume: Arc<Mutex<f32>>,
  // None means "system default" — the common case, and what every session
  // used before device selection existed. Also lives outside Session so a
  // chosen device survives stop/restart the same way volume does.
  device_name: Arc<Mutex<Option<String>>>,
}

impl PlaybackState {
  pub fn new() -> Self {
    PlaybackState {
      session: Arc::new(Mutex::new(None)),
      volume: Arc::new(Mutex::new(1.0)),
      device_name: Arc::new(Mutex::new(None)),
    }
  }
}

fn gain_db(track: &QueueTrack) -> f32 {
  track.replaygain_track_gain.unwrap_or(0.0)
}

// Polls the sink's queue length to detect track boundaries — rodio has no
// completion callback, so this is the mechanism behind playback://
// track-changed. Exits once the session is torn down (queue_stop), rather
// than polling forever after every stop — otherwise every play/stop cycle
// would leak another thread.
fn spawn_monitor(app: AppHandle, state: Arc<Mutex<Option<Session>>>) {
  std::thread::spawn(move || {
    let mut last_queue_len: usize = usize::MAX;
    loop {
      std::thread::sleep(Duration::from_millis(250));
      let mut guard = state.lock().unwrap();
      let Some(session) = guard.as_mut() else {
        break;
      };

      let sink_len = session.sink.len();
      while session.queue.len() > sink_len {
        session.queue.pop_front();
      }

      let position_ms = session.sink.get_pos().as_millis() as u64;
      let current_node = session.queue.front().map(|t| t.recording_node_id);
      let track_changed = session.queue.len() != last_queue_len;
      last_queue_len = session.queue.len();
      drop(guard);

      let _ = app.emit(
        "playback://position",
        PositionEvent { position_ms, recording_node_id: current_node },
      );
      if track_changed {
        let _ = app.emit("playback://track-changed", TrackChangedEvent { recording_node_id: current_node });
      }
    }
  });
}

// Falls back to the system default if the configured device is gone
// (unplugged, renamed) rather than erroring — a stale device preference
// should degrade to "plays somewhere," not "doesn't play."
fn open_stream(device_name: &Option<String>) -> Result<OutputStream, String> {
  if let Some(name) = device_name {
    let host = rodio::cpal::default_host();
    if let Ok(mut devices) = host.output_devices() {
      if let Some(device) = devices.find(|d| d.name().ok().as_deref() == Some(name.as_str())) {
        return OutputStreamBuilder::from_device(device)
          .and_then(|builder| builder.open_stream())
          .map_err(|e| e.to_string());
      }
    }
  }
  OutputStreamBuilder::open_default_stream().map_err(|e| e.to_string())
}

fn ensure_session<'a>(
  app: &AppHandle,
  state: &'a PlaybackState,
) -> Result<std::sync::MutexGuard<'a, Option<Session>>, String> {
  let mut guard = state.session.lock().unwrap();
  if guard.is_none() {
    let device_name = state.device_name.lock().unwrap().clone();
    let stream = open_stream(&device_name)?;
    let sink = Sink::connect_new(stream.mixer());
    sink.set_volume(*state.volume.lock().unwrap());
    *guard = Some(Session { _stream: stream, sink, queue: VecDeque::new() });
    spawn_monitor(app.clone(), state.session.clone());
  }
  Ok(guard)
}

#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<String>, String> {
  let host = rodio::cpal::default_host();
  let devices = host.output_devices().map_err(|e| e.to_string())?;
  Ok(devices.filter_map(|d| d.name().ok()).collect())
}

/// Selecting a device tears down any live session (same effect as
/// queue_stop) so the next enqueue reopens on the new device — rodio has
/// no way to swap a Sink's output stream mid-session, and this mirrors how
/// an actual device unplug already behaves.
#[tauri::command]
pub fn queue_set_device(state: State<PlaybackState>, name: Option<String>) -> Result<(), String> {
  *state.device_name.lock().unwrap() = name;
  *state.session.lock().unwrap() = None;
  Ok(())
}

#[tauri::command]
pub fn queue_enqueue(app: AppHandle, state: State<PlaybackState>, track: QueueTrack) -> Result<(), String> {
  let mut guard = ensure_session(&app, &state)?;
  let session = guard.as_mut().unwrap();

  let file = File::open(&track.file_path).map_err(|e| format!("failed to open {}: {e}", track.file_path))?;
  // See NetworkAheadReader above: confirmed live over an NFS-mounted
  // library that a plain File/BufReader pops mid-track, even with a large
  // buffer, because decode's reads are still synchronous with the
  // network. This background-prefetches instead.
  let reader = NetworkAheadReader::new(file).map_err(|e| e.to_string())?;
  let source = Decoder::new(reader).map_err(|e| e.to_string())?;
  let gain = gain_db(&track);

  session.sink.append(source.amplify_decibel(gain));
  session.queue.push_back(track);
  Ok(())
}

#[tauri::command]
pub fn queue_play(state: State<PlaybackState>) -> Result<(), String> {
  if let Some(session) = state.session.lock().unwrap().as_ref() {
    session.sink.play();
  }
  Ok(())
}

#[tauri::command]
pub fn queue_pause(state: State<PlaybackState>) -> Result<(), String> {
  if let Some(session) = state.session.lock().unwrap().as_ref() {
    session.sink.pause();
  }
  Ok(())
}

/// Drops the whole session — stops output, frees the audio device, and
/// (via spawn_monitor's exit condition) ends the polling thread. volume is
/// untouched — it lives outside the session precisely so it survives this.
#[tauri::command]
pub fn queue_stop(state: State<PlaybackState>) -> Result<(), String> {
  *state.session.lock().unwrap() = None;
  Ok(())
}

#[tauri::command]
pub fn queue_seek(state: State<PlaybackState>, position_ms: u64) -> Result<(), String> {
  if let Some(session) = state.session.lock().unwrap().as_ref() {
    session
      .sink
      .try_seek(Duration::from_millis(position_ms))
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// Skips the currently playing track. Gapless scheduling only guarantees
/// zero-gap transitions at natural track boundaries — a manual skip is
/// necessarily an audible cut, same as any player.
#[tauri::command]
pub fn queue_skip(state: State<PlaybackState>) -> Result<(), String> {
  if let Some(session) = state.session.lock().unwrap().as_mut() {
    session.sink.skip_one();
    session.queue.pop_front();
  }
  Ok(())
}

#[tauri::command]
pub fn queue_status(state: State<PlaybackState>) -> QueueStatus {
  let volume = *state.volume.lock().unwrap();
  match state.session.lock().unwrap().as_ref() {
    Some(session) => QueueStatus {
      playing: !session.sink.is_paused() && !session.sink.empty(),
      position_ms: session.sink.get_pos().as_millis() as u64,
      current_recording_node_id: session.queue.front().map(|t| t.recording_node_id),
      queue_len: session.queue.len(),
      volume,
    },
    None => QueueStatus { playing: false, position_ms: 0, current_recording_node_id: None, queue_len: 0, volume },
  }
}

/// value is a linear 0.0-1.0 multiplier (rodio's own Sink::set_volume
/// scale, passed straight through) — clamped here rather than trusted from
/// the frontend, since an out-of-range value would otherwise silently
/// distort or invert the signal deep inside rodio rather than fail loudly.
#[tauri::command]
pub fn queue_set_volume(state: State<PlaybackState>, value: f32) -> Result<(), String> {
  let clamped = value.clamp(0.0, 1.0);
  *state.volume.lock().unwrap() = clamped;
  if let Some(session) = state.session.lock().unwrap().as_ref() {
    session.sink.set_volume(clamped);
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn gain_db_defaults_to_zero_when_no_tag() {
    let track = QueueTrack { file_path: String::new(), recording_node_id: 0, replaygain_track_gain: None };
    assert_eq!(gain_db(&track), 0.0);
  }

  #[test]
  fn gain_db_passes_through_the_tag_value() {
    let track = QueueTrack { file_path: String::new(), recording_node_id: 0, replaygain_track_gain: Some(-6.5) };
    assert_eq!(gain_db(&track), -6.5);
  }

  // Only enumeration — no stream is opened, so this is safe to run in a
  // headless environment with no real output device (an empty Vec is a
  // legitimate result there, not a failure); a real device list is what
  // this was actually checked against in a normal desktop session.
  #[test]
  fn list_audio_devices_does_not_panic() {
    let result = list_audio_devices();
    assert!(result.is_ok());
  }

  // Exercises the real audio engine against real hardware and a real file
  // — not run by default `cargo test` (needs a working audio device and
  // LEGATO_TEST_FILE pointed at a real audio file), but this is how
  // amplify_decibel/try_seek/get_pos (all new in this module — none used
  // by the original play_native_gapless_spike) were actually verified,
  // rather than just compiled and trusted.
  #[test]
  #[ignore]
  fn real_playback_smoke_test() {
    let path = std::env::var("LEGATO_TEST_FILE").expect("set LEGATO_TEST_FILE to a real audio file");
    let stream = OutputStreamBuilder::open_default_stream().expect("open audio device");
    let sink = Sink::connect_new(stream.mixer());

    let file = File::open(&path).expect("open test file");
    let reader = NetworkAheadReader::new(file).expect("start prefetching test file");
    let source = Decoder::new(reader).expect("decode test file");
    sink.append(source.amplify_decibel(-6.0)); // ReplayGain-style attenuation

    std::thread::sleep(Duration::from_millis(800));
    let pos_before = sink.get_pos();
    assert!(pos_before.as_millis() > 0, "playback should have advanced: {pos_before:?}");

    sink.try_seek(Duration::from_secs(30)).expect("seek should succeed mid-playback");
    std::thread::sleep(Duration::from_millis(300));
    let pos_after = sink.get_pos();
    assert!(pos_after.as_secs() >= 30, "seek should have jumped forward: {pos_after:?}");

    sink.stop();
  }
}
