use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::{Decoder, OutputStream, OutputStreamBuilder, Sink, Source};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

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

pub struct PlaybackState {
  session: Arc<Mutex<Option<Session>>>,
  // Lives outside Session (and outside the Mutex<Option<_>> that gets
  // wiped to None on every queue_stop) specifically so it survives across
  // stop/restart — rodio's own Sink::volume resets to 1.0 on every new
  // Sink, and a user's volume choice shouldn't reset every time the queue
  // empties and refills.
  volume: Arc<Mutex<f32>>,
}

impl PlaybackState {
  pub fn new() -> Self {
    PlaybackState { session: Arc::new(Mutex::new(None)), volume: Arc::new(Mutex::new(1.0)) }
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

fn ensure_session<'a>(
  app: &AppHandle,
  state: &'a PlaybackState,
) -> Result<std::sync::MutexGuard<'a, Option<Session>>, String> {
  let mut guard = state.session.lock().unwrap();
  if guard.is_none() {
    let stream = OutputStreamBuilder::open_default_stream().map_err(|e| e.to_string())?;
    let sink = Sink::connect_new(stream.mixer());
    sink.set_volume(*state.volume.lock().unwrap());
    *guard = Some(Session { _stream: stream, sink, queue: VecDeque::new() });
    spawn_monitor(app.clone(), state.session.clone());
  }
  Ok(guard)
}

#[tauri::command]
pub fn queue_enqueue(app: AppHandle, state: State<PlaybackState>, track: QueueTrack) -> Result<(), String> {
  let mut guard = ensure_session(&app, &state)?;
  let session = guard.as_mut().unwrap();

  let file = File::open(&track.file_path).map_err(|e| format!("failed to open {}: {e}", track.file_path))?;
  let source = Decoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;
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
    let source = Decoder::new(BufReader::new(file)).expect("decode test file");
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
