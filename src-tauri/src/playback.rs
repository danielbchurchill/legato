use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
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
  // Set when the reader is dropped: the track finished, was skipped, or its
  // session stopped. The background thread checks it between chunks and
  // gives up, so a file nobody will play stops downloading. Without it,
  // every queue_stop left one thread per opened track pulling its whole
  // file over the network.
  abandoned: AtomicBool,
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
      abandoned: AtomicBool::new(false),
    });

    let background = shared.clone();
    std::thread::spawn(move || {
      let mut chunk = vec![0u8; 256 * 1024];
      loop {
        if background.abandoned.load(Ordering::Relaxed) {
          break;
        }
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

impl Drop for NetworkAheadReader {
  fn drop(&mut self) {
    self.shared.abandoned.store(true, Ordering::Relaxed);
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

// Desktop playback engine: native decode and gapless queue control through
// rodio/cpal. This module never talks to the server's DB directly. React
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

/// Issue #125: off/all/one, a persisted
/// player setting rather than per-queue state (unlike shuffle, which lives
/// entirely in the frontend's playSequence — see usePlayback.ts). Lives
/// outside `Session` in `PlaybackState`, same as volume/device_name, so it
/// survives a queue_stop and applies to whatever gets enqueued next.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepeatMode {
  Off,
  All,
  One,
}

/// Why a track couldn't start (issue #184). Returned as the rejection value
/// of queue_enqueue, so usePlayback.ts gets a tagged object it
/// can explain on screen instead of a string that only ever reached the
/// `npx tauri dev` terminal. Three cases because each needs a different
/// fix from the person at the keyboard: reconnect a drive, replace a file,
/// or plug in an output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlaybackError {
  /// The file couldn't be opened at all: missing, a dropped NFS mount, a
  /// permissions problem. `nearest_folder` is the deepest ancestor of
  /// `path` that exists on this machine, and `nearest_folder_empty` says
  /// whether it has nothing in it. Together they let the frontend tell
  /// "this one file is gone" (the album folder is still there) from "the
  /// whole library isn't here" (an unmounted mount point is an empty
  /// directory, not a missing one, so existence alone can't tell them
  /// apart).
  FileUnreachable {
    path: String,
    nearest_folder: Option<String>,
    nearest_folder_empty: bool,
    detail: String,
  },
  /// The file opened, but symphonia couldn't make audio out of it:
  /// truncated, corrupt, or a format it doesn't read.
  Undecodable { path: String, detail: String },
  /// No output stream could be opened, on the chosen device or the
  /// system default. Nothing about the file is wrong.
  NoOutputDevice { detail: String },
}

// Every probe here is a plain metadata/read_dir call that treats any error
// as "not there" — a stale NFS handle answers ESTALE rather than ENOENT,
// and that mount is exactly as unusable as an absent one.
fn classify_open_error(path: &str, err: &io::Error) -> PlaybackError {
  let nearest = Path::new(path)
    .ancestors()
    .skip(1)
    .find(|dir| std::fs::metadata(dir).map(|m| m.is_dir()).unwrap_or(false));
  let nearest_folder_empty = nearest
    .and_then(|dir| std::fs::read_dir(dir).ok())
    .map(|mut entries| entries.next().is_none())
    .unwrap_or(false);
  PlaybackError::FileUnreachable {
    path: path.to_string(),
    nearest_folder: nearest.map(|dir| dir.to_string_lossy().into_owned()),
    nearest_folder_empty,
    detail: err.to_string(),
  }
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

// How many tracks are open in the sink at once: the one playing and the
// one after it, which is all gapless needs. Everything behind them waits
// in Session::pending as a path and is opened by the monitor thread as
// room frees up. Opening a track starts NetworkAheadReader downloading the
// whole file, so opening the full queue up front (a shuffled library is
// 700+ tracks) meant hundreds of simultaneous downloads over NFS,
// gigabytes of buffered audio, and, while queue_enqueue still ran on the
// main thread, a window that beachballed on every click.
const OPEN_AHEAD: usize = 2;

struct Session {
  // Held for the lifetime of playback — dropping it stops output.
  _stream: MixerDeviceSink,
  sink: Player,
  // Which session this is. queue_stop followed straight away by a new
  // enqueue (every play and every queue edit does that) replaces the
  // session before the old monitor thread's next tick, so "is there still
  // a session?" isn't enough for that thread to know it should exit. It
  // compares this instead; before it did, each play left one more monitor
  // running, each emitting its own position events four times a second.
  generation: u64,
  // Tracks appended to the sink, in append order, front = currently
  // playing. rodio's Player doesn't expose "which source is this," so this
  // is what lets the monitor thread turn "sink.len() decreased" into
  // "here's the recording_node_id that's now playing." Never longer than
  // OPEN_AHEAD, except briefly when repeat-one re-queues a track.
  queue: VecDeque<QueueTrack>,
  // Enqueued but not opened yet, in play order, behind everything in
  // `queue`.
  pending: VecDeque<QueueTrack>,
  // True while a track taken from `pending` (or a queue_enqueue's own
  // track) is being opened with the lock released. Anything enqueued
  // meanwhile goes to `pending` so it can't overtake the one in flight.
  opening: bool,
  // The front of `queue` changed (or the session is new) and the frontend
  // hasn't been told. Set by finished tracks and queue_skip, cleared by the
  // monitor when it emits playback://track-changed.
  announce_owed: bool,
  // Every track ever enqueued this session, in original append order —
  // unlike `queue`, this never shrinks as tracks finish. It's what
  // repeat-all wraps back to at the end of the queue (reconcile_repeat
  // below) and what queue_skip's own manual-skip wraparound reuses, so
  // "the queue" repeat-all loops is exactly what was queued for this
  // session, not some absolute start of a larger frontend-side history it
  // has no way to know about (see usePlayback.ts's playSequence, which
  // this module never sees past whatever's actually been enqueued).
  full_order: Vec<QueueTrack>,
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
  // stop/restart — rodio's own Player::volume resets to 1.0 on every new
  // Player, and a user's volume choice shouldn't reset every time the queue
  // empties and refills.
  volume: Arc<Mutex<f32>>,
  // None means "system default" — the common case, and what every session
  // used before device selection existed. Also lives outside Session so a
  // chosen device survives stop/restart the same way volume does.
  device_name: Arc<Mutex<Option<String>>>,
  // See RepeatMode's own doc comment — outside Session for the same
  // survives-a-stop reason as volume/device_name above.
  repeat_mode: Arc<Mutex<RepeatMode>>,
  next_generation: AtomicU64,
}

impl PlaybackState {
  pub fn new() -> Self {
    PlaybackState {
      session: Arc::new(Mutex::new(None)),
      volume: Arc::new(Mutex::new(1.0)),
      device_name: Arc::new(Mutex::new(None)),
      repeat_mode: Arc::new(Mutex::new(RepeatMode::Off)),
      next_generation: AtomicU64::new(0),
    }
  }
}

fn gain_db(track: &QueueTrack) -> f32 {
  track.replaygain_track_gain.unwrap_or(0.0)
}

// The second half of turning a QueueTrack into a playing source, after
// open_source. The two are separate so the open, which can take seconds
// over NFS, runs without the session lock held, and only this quick part
// runs under it. Shared by queue_enqueue and the monitor thread, so
// there's one place ReplayGain is applied.
fn append_opened(session: &mut Session, track: QueueTrack, source: Decoder<NetworkAheadReader>) {
  session.sink.append(source.amplify_decibel(gain_db(&track)));
  session.queue.push_back(track);
}

// The next pending track to open, if the sink has room for it under
// OPEN_AHEAD. Free of Player and file I/O so the windowing is testable
// without an audio device.
fn take_next_to_open(queue: &VecDeque<QueueTrack>, pending: &mut VecDeque<QueueTrack>) -> Option<QueueTrack> {
  if queue.len() >= OPEN_AHEAD {
    return None;
  }
  pending.pop_front()
}

// Testable without a Player (and so without an audio device).
fn open_source(path: &str) -> Result<Decoder<NetworkAheadReader>, PlaybackError> {
  let file = File::open(path).map_err(|e| classify_open_error(path, &e))?;
  // See NetworkAheadReader above: confirmed live over an NFS-mounted
  // library that a plain File/BufReader pops mid-track, even with a large
  // buffer, because decode's reads are still synchronous with the
  // network. This background-prefetches instead.
  let reader = NetworkAheadReader::new(file).map_err(|e| classify_open_error(path, &e))?;
  Decoder::new(reader).map_err(|e| PlaybackError::Undecodable { path: path.to_string(), detail: e.to_string() })
}

// Pure gapless-repeat scheduling core — given how many tracks have
// actually finished playing since the last poll (a *natural* completion;
// a manual queue_skip never goes through this, see its own comment) and
// the current repeat mode, drops the finished tracks from `queue` and puts
// whatever has to play again into `pending`, where the monitor's top-up
// opens it. Kept free of Player/file I/O specifically so it's testable
// without a real audio device — same reasoning as gain_db above, see the
// tests module below.
//
// RepeatMode::One re-queues the just-finished track at the *back* of
// `pending` rather than dropping it — because rodio's Player is
// strictly FIFO by append order, this only stays correct because
// usePlayback.ts (the Tauri path) deliberately enqueues *only* the current
// track while repeat-one is active, never the rest of the tail behind it
// (see rebuildTauriQueueInPlace's comment there). If something else were
// already queued behind the looping track in the sink, it would play next
// instead of the loop — this function has no way to reorder what rodio has
// already been handed, so the frontend's enqueue policy is what actually
// keeps repeat-one's loop uninterrupted, not this reconciliation alone.
//
// RepeatMode::All only wraps once `queue` and `pending` are both empty
// after popping — i.e. the track that just finished was the last thing
// enqueued — and re-queues the whole of `full_order`, the original
// enqueued sequence, so repeat-all loops "the queue" as this session was
// given it.
fn reconcile_repeat(
  queue: &mut VecDeque<QueueTrack>,
  pending: &mut VecDeque<QueueTrack>,
  full_order: &[QueueTrack],
  finished_count: usize,
  repeat: RepeatMode,
) {
  for _ in 0..finished_count {
    let Some(finished) = queue.pop_front() else { break };
    match repeat {
      RepeatMode::One => pending.push_back(finished),
      RepeatMode::All if queue.is_empty() && pending.is_empty() => pending.extend(full_order.iter().cloned()),
      RepeatMode::All | RepeatMode::Off => {}
    }
  }
}

// Polls the sink's queue length to detect track boundaries — rodio has no
// completion callback, so this is the mechanism behind playback://
// track-changed — and keeps the next pending track opened behind the one
// playing. Exits once its session is stopped or replaced; see
// Session::generation.
fn spawn_monitor(
  app: AppHandle,
  state: Arc<Mutex<Option<Session>>>,
  repeat_mode: Arc<Mutex<RepeatMode>>,
  generation: u64,
) {
  std::thread::spawn(move || loop {
    std::thread::sleep(Duration::from_millis(250));

    // Under the lock: account for finished tracks and pick the next one to
    // open. The open itself happens with the lock released, because over
    // NFS it can take seconds, and play, pause and queue_status all wait
    // on this lock.
    let to_open = {
      let mut guard = state.lock().unwrap();
      let Some(session) = guard.as_mut().filter(|s| s.generation == generation) else {
        break;
      };
      let finished_count = session.queue.len().saturating_sub(session.sink.len());
      if finished_count > 0 {
        let repeat = *repeat_mode.lock().unwrap();
        reconcile_repeat(&mut session.queue, &mut session.pending, &session.full_order, finished_count, repeat);
        session.announce_owed = true;
      }
      if session.opening {
        None
      } else {
        let next = take_next_to_open(&session.queue, &mut session.pending);
        session.opening = next.is_some();
        next
      }
    };
    let opened = to_open.map(|track| {
      let source = open_source(&track.file_path);
      (track, source)
    });

    let mut guard = state.lock().unwrap();
    let Some(session) = guard.as_mut().filter(|s| s.generation == generation) else {
      break;
    };
    if let Some((track, source)) = opened {
      session.opening = false;
      match source {
        Ok(source) => append_opened(session, track, source),
        // Skipped, the same as a track queue_enqueue rejects is dropped
        // from usePlayback's queue. The next tick opens the one after it.
        Err(err) => log::warn!("[playback] skipping a track that won't open: {err:?}"),
      }
    }

    // A finished track whose successor is still pending or mid-open leaves
    // `queue` empty for a tick. That isn't the end of the queue, so say
    // nothing rather than tell the frontend nothing is playing.
    if session.queue.is_empty() && (session.opening || !session.pending.is_empty()) {
      continue;
    }
    let position_ms = session.sink.get_pos().as_millis() as u64;
    let current_node = session.queue.front().map(|t| t.recording_node_id);
    let announce = std::mem::take(&mut session.announce_owed);
    drop(guard);

    let _ = app.emit("playback://position", PositionEvent { position_ms, recording_node_id: current_node });
    if announce {
      let _ = app.emit("playback://track-changed", TrackChangedEvent { recording_node_id: current_node });
    }
  });
}

/// One output device as the settings screen lists it. `id` is what gets
/// saved: cpal's `DeviceId` ("host:device"), stable across reboots and
/// reconnects, where a display name isn't — two identical USB DACs share a
/// name, and since cpal 0.17 an ALSA device's name is its description
/// ("Default ALSA Output (currently PipeWire Media Server)"), not the PCM
/// id ("pipewire") 0.16 reported.
#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
  pub id: String,
  pub label: String,
}

// Whether a saved device preference refers to this device. A preference
// saved before the switch to ids is the name cpal 0.16 reported: on macOS
// and Windows that's the same string as today's label, and on Linux it's
// the ALSA PCM id, which is the device half of today's id. Accepting all
// three means nobody's chosen output silently resets on upgrade.
fn matches_saved_device(saved: &str, id: &str, id_device_part: &str, label: &str) -> bool {
  saved == id || saved == id_device_part || saved == label
}

// Falls back to the system default if the configured device is gone
// (unplugged, renamed) rather than erroring — a stale device preference
// should degrade to "plays somewhere," not "doesn't play."
fn open_stream(saved_device: &Option<String>) -> Result<MixerDeviceSink, String> {
  if let Some(saved) = saved_device {
    let host = rodio::cpal::default_host();
    if let Ok(mut devices) = host.output_devices() {
      let found = devices.find(|d| {
        let Ok(id) = d.id() else { return false };
        let label = d.description().map(|desc| desc.name().to_string()).unwrap_or_default();
        matches_saved_device(saved, &id.to_string(), &id.1, &label)
      });
      if let Some(device) = found {
        return DeviceSinkBuilder::from_device(device)
          .and_then(|builder| builder.open_stream())
          .map_err(|e| e.to_string());
      }
    }
  }
  DeviceSinkBuilder::open_default_sink().map_err(|e| e.to_string())
}

fn ensure_session<'a>(
  app: &AppHandle,
  state: &'a PlaybackState,
) -> Result<std::sync::MutexGuard<'a, Option<Session>>, PlaybackError> {
  let mut guard = state.session.lock().unwrap();
  if guard.is_none() {
    let device_name = state.device_name.lock().unwrap().clone();
    // open_stream already fell back to the system default, so a failure
    // here means there is nowhere at all to send audio.
    let stream = open_stream(&device_name).map_err(|detail| PlaybackError::NoOutputDevice { detail })?;
    let sink = Player::connect_new(stream.mixer());
    sink.set_volume(*state.volume.lock().unwrap());
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
    *guard = Some(Session {
      _stream: stream,
      sink,
      generation,
      queue: VecDeque::new(),
      pending: VecDeque::new(),
      opening: false,
      // A new session announces its first track, which is also how a
      // rebuild re-announces the track that was already playing.
      announce_owed: true,
      full_order: Vec::new(),
    });
    spawn_monitor(app.clone(), state.session.clone(), state.repeat_mode.clone(), generation);
  }
  Ok(guard)
}

#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
  let host = rodio::cpal::default_host();
  let devices = host.output_devices().map_err(|e| e.to_string())?;
  Ok(
    devices
      .filter_map(|d| {
        let id = d.id().ok()?;
        // A device with no readable description still gets listed, under
        // its id, rather than vanishing from the picker.
        let label = d.description().map(|desc| desc.name().to_string()).unwrap_or_else(|_| id.1.clone());
        Some(AudioDevice { id: id.to_string(), label })
      })
      .collect(),
  )
}

/// Selecting a device tears down any live session (same effect as
/// queue_stop) so the next enqueue reopens on the new device — rodio has
/// no way to swap a Player's output device mid-session, and this mirrors how
/// an actual device unplug already behaves.
#[tauri::command]
pub fn queue_set_device(state: State<PlaybackState>, name: Option<String>) -> Result<(), String> {
  *state.device_name.lock().unwrap() = name;
  *state.session.lock().unwrap() = None;
  Ok(())
}

/// Opens the track now if it's one of the first OPEN_AHEAD, so a first
/// track that can't play comes back as this call's error for usePlayback's
/// showStartFailure. Anything later goes to `pending` and returns at once;
/// the monitor thread opens it when it's next up, and skips it if it won't
/// open.
///
/// `async` so it runs off the main thread: Tauri runs a plain sync command
/// on the main thread, and an open over NFS that takes a second froze the
/// whole window for that second, once per track.
#[tauri::command(async)]
pub fn queue_enqueue(app: AppHandle, state: State<PlaybackState>, track: QueueTrack) -> Result<(), PlaybackError> {
  let mut guard = ensure_session(&app, &state)?;
  let session = guard.as_mut().unwrap();
  let generation = session.generation;

  if session.opening || !session.pending.is_empty() || session.queue.len() >= OPEN_AHEAD {
    session.full_order.push(track.clone());
    session.pending.push_back(track);
    return Ok(());
  }

  session.opening = true;
  drop(guard);
  let opened = open_source(&track.file_path);
  let mut guard = state.session.lock().unwrap();
  // Stopped or replaced while the file was opening: whoever did that has
  // moved on from this track, and dropping `opened` cancels its download.
  let Some(session) = guard.as_mut().filter(|s| s.generation == generation) else {
    return Ok(());
  };
  session.opening = false;

  match opened {
    Ok(source) => {
      session.full_order.push(track.clone());
      append_opened(session, track, source);
      Ok(())
    }
    Err(err) => {
      // A session that never got a playable track would otherwise hold the
      // output device open, and its monitor thread would announce
      // track-changed(null) on its first tick, wiping the error usePlayback
      // is about to show. Drop it, same as queue_stop.
      if session.queue.is_empty() && session.pending.is_empty() {
        *guard = None;
      }
      Err(err)
    }
  }
}

/// #125's persisted player setting (see RepeatMode's doc comment) — applies
/// immediately to the monitor thread's own gapless reconciliation
/// (reconcile_repeat) and to the next queue_skip. Setting this alone
/// doesn't retroactively change what's already been enqueued into a live
/// sink; usePlayback.ts pairs every mode change with a rebuild for that.
#[tauri::command]
pub fn queue_set_repeat(state: State<PlaybackState>, mode: RepeatMode) -> Result<(), String> {
  *state.repeat_mode.lock().unwrap() = mode;
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
///
/// Under repeat-all, skipping past the last enqueued track wraps back to
/// `full_order`'s start rather than emptying the queue — reusing the same
/// wraparound data reconcile_repeat's natural-completion path already
/// relies on, so a manual skip at the boundary behaves the same as letting
/// the last track play out. Repeat-one intentionally gets no equivalent
/// here: usePlayback.ts's next() special-cases that mode with its own
/// rebuild rather than calling queue_skip at all, because Rust only ever
/// holds the single looping track while repeat-one is active — this
/// command has nothing real behind it to skip to in that case.
#[tauri::command]
pub fn queue_skip(state: State<PlaybackState>) -> Result<(), String> {
  if let Some(session) = state.session.lock().unwrap().as_mut() {
    session.sink.skip_one();
    session.queue.pop_front();
    session.announce_owed = true;
    let nothing_left = session.queue.is_empty() && session.pending.is_empty() && !session.opening;
    if nothing_left && *state.repeat_mode.lock().unwrap() == RepeatMode::All {
      session.pending.extend(session.full_order.iter().cloned());
    }
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

/// value is a linear 0.0-1.0 multiplier (rodio's own Player::set_volume
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

  // file_path is irrelevant to reconcile_repeat — it's pure queue/id
  // bookkeeping, never touches the filesystem — so an empty path plus a
  // distinguishing id is enough to tell tracks apart by assertion.
  fn track(id: i64) -> QueueTrack {
    QueueTrack { file_path: String::new(), recording_node_id: id, replaygain_track_gain: None }
  }

  fn ids(tracks: &[QueueTrack]) -> Vec<i64> {
    tracks.iter().map(|t| t.recording_node_id).collect()
  }

  fn pending_of(tracks: &[QueueTrack]) -> VecDeque<QueueTrack> {
    tracks.iter().cloned().collect()
  }

  #[test]
  fn reconcile_repeat_off_just_drains_finished_tracks() {
    let mut queue = VecDeque::from([track(1), track(2)]);
    let mut pending = pending_of(&[track(3)]);
    let full_order = [track(1), track(2), track(3)];

    reconcile_repeat(&mut queue, &mut pending, &full_order, 1, RepeatMode::Off);

    assert_eq!(ids(&Vec::from(queue)), vec![2]);
    assert_eq!(ids(&Vec::from(pending)), vec![3]);
  }

  // The common repeat-one shape: usePlayback.ts only ever hands Rust the
  // single looping track while repeat-one is active (see this module's own
  // reconcile_repeat doc comment), so `queue` holds nothing else.
  #[test]
  fn reconcile_repeat_one_requeues_the_finished_track() {
    let mut queue = VecDeque::from([track(7)]);
    let mut pending = VecDeque::new();
    let full_order = [track(7)];

    reconcile_repeat(&mut queue, &mut pending, &full_order, 1, RepeatMode::One);

    assert!(queue.is_empty());
    assert_eq!(ids(&Vec::from(pending)), vec![7]);
  }

  // Documents the FIFO caveat reconcile_repeat's doc comment calls out:
  // if something else were already sitting behind the looping track (which
  // shouldn't happen via the real frontend policy, but this function alone
  // can't enforce that), the repeated copy lands *behind* it, not ahead —
  // rodio's Player is strictly append-order, so this reconciliation has no
  // way to jump the line.
  #[test]
  fn reconcile_repeat_one_cannot_reorder_what_is_already_queued_behind_it() {
    let mut queue = VecDeque::from([track(1), track(2)]);
    let mut pending = VecDeque::new();
    let full_order = [track(1), track(2)];

    reconcile_repeat(&mut queue, &mut pending, &full_order, 1, RepeatMode::One);

    assert_eq!(ids(&Vec::from(queue)), vec![2]);
    assert_eq!(ids(&Vec::from(pending)), vec![1]);
  }

  // Only the queue is re-queued, never opened: the monitor's top-up opens
  // the first OPEN_AHEAD of it, so a 700-track repeat-all wraps without
  // opening 700 files.
  #[test]
  fn reconcile_repeat_all_wraps_to_the_start_once_everything_has_played() {
    let mut queue = VecDeque::from([track(3)]);
    let mut pending = VecDeque::new();
    let full_order = [track(1), track(2), track(3)];

    reconcile_repeat(&mut queue, &mut pending, &full_order, 1, RepeatMode::All);

    assert!(queue.is_empty());
    assert_eq!(ids(&Vec::from(pending)), vec![1, 2, 3]);
  }

  #[test]
  fn reconcile_repeat_all_does_nothing_while_tracks_remain_in_the_queue() {
    let mut queue = VecDeque::from([track(2), track(3)]);
    let mut pending = VecDeque::new();
    let full_order = [track(1), track(2), track(3)];

    reconcile_repeat(&mut queue, &mut pending, &full_order, 1, RepeatMode::All);

    assert_eq!(ids(&Vec::from(queue)), vec![3]);
    assert!(pending.is_empty());
  }

  // The sink can run dry with tracks still unopened (one that wouldn't
  // open, or a top-up still in flight). That isn't the end of the queue,
  // so repeat-all mustn't wrap yet.
  #[test]
  fn reconcile_repeat_all_does_not_wrap_while_tracks_are_still_pending() {
    let mut queue = VecDeque::from([track(1)]);
    let mut pending = pending_of(&[track(2), track(3)]);
    let full_order = [track(1), track(2), track(3)];

    reconcile_repeat(&mut queue, &mut pending, &full_order, 1, RepeatMode::All);

    assert!(queue.is_empty());
    assert_eq!(ids(&Vec::from(pending)), vec![2, 3]);
  }

  // Two natural completions landing in the same 250ms poll (spawn_monitor
  // missed a tick, or the deck's short enough that two tracks finished
  // between polls) — repeat-one has to loop *each* one, not just the last.
  #[test]
  fn reconcile_repeat_one_handles_multiple_finishes_in_one_tick() {
    let mut queue = VecDeque::from([track(9), track(9)]);
    let mut pending = VecDeque::new();
    let full_order = [track(9)];

    reconcile_repeat(&mut queue, &mut pending, &full_order, 2, RepeatMode::One);

    assert!(queue.is_empty());
    assert_eq!(ids(&Vec::from(pending)), vec![9, 9]);
  }

  // An empty full_order (the degenerate "nothing was ever really enqueued"
  // case) shouldn't panic — it just means there's nothing to wrap back to.
  #[test]
  fn reconcile_repeat_all_with_empty_full_order_wraps_to_nothing() {
    let mut queue = VecDeque::from([track(1)]);
    let mut pending = VecDeque::new();
    let full_order: [QueueTrack; 0] = [];

    reconcile_repeat(&mut queue, &mut pending, &full_order, 1, RepeatMode::All);

    assert!(queue.is_empty());
    assert!(pending.is_empty());
  }

  #[test]
  fn take_next_to_open_fills_the_sink_up_to_open_ahead() {
    let mut queue = VecDeque::from([track(1)]);
    let mut pending = pending_of(&[track(2), track(3)]);

    let next = take_next_to_open(&queue, &mut pending).expect("room for one more");
    assert_eq!(next.recording_node_id, 2);
    queue.push_back(next);

    assert!(take_next_to_open(&queue, &mut pending).is_none(), "the sink already holds OPEN_AHEAD tracks");
    assert_eq!(ids(&Vec::from(pending)), vec![3]);
  }

  #[test]
  fn take_next_to_open_with_nothing_pending_opens_nothing() {
    let queue = VecDeque::new();
    let mut pending = VecDeque::new();

    assert!(take_next_to_open(&queue, &mut pending).is_none());
  }

  // A throwaway directory per test under the OS temp dir. The suffix keeps
  // parallel tests (and parallel worktrees running cargo test) apart.
  fn scratch_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("legato-playback-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn unreachable_parts(err: PlaybackError) -> (Option<String>, bool) {
    match err {
      PlaybackError::FileUnreachable { nearest_folder, nearest_folder_empty, .. } => (nearest_folder, nearest_folder_empty),
      other => panic!("expected FileUnreachable, got {other:?}"),
    }
  }

  // A client whose NFS library mount never came up: /mnt/music exists as an
  // empty mount point, so every path under it is missing
  // and the nearest folder that exists has nothing in it.
  #[test]
  fn open_source_reports_an_empty_mount_point_for_an_unmounted_library() {
    let mount_point = scratch_dir("unmounted");
    let path = mount_point.join("Music/Artist/Album/01.flac");

    let err = open_source(path.to_str().unwrap()).err().unwrap();

    let (nearest, empty) = unreachable_parts(err);
    assert_eq!(nearest.as_deref(), mount_point.to_str());
    assert!(empty);
    std::fs::remove_dir_all(&mount_point).unwrap();
  }

  // One file deleted from an album folder that is otherwise intact.
  #[test]
  fn open_source_reports_the_intact_album_folder_for_a_single_missing_file() {
    let root = scratch_dir("one-missing");
    let album = root.join("Artist/Album");
    std::fs::create_dir_all(&album).unwrap();
    std::fs::write(album.join("02.flac"), b"still here").unwrap();

    let err = open_source(album.join("01.flac").to_str().unwrap()).err().unwrap();

    let (nearest, empty) = unreachable_parts(err);
    assert_eq!(nearest.as_deref(), album.to_str());
    assert!(!empty);
    std::fs::remove_dir_all(&root).unwrap();
  }

  #[test]
  fn open_source_reports_a_file_that_opens_but_is_not_audio_as_undecodable() {
    let dir = scratch_dir("garbage");
    let path = dir.join("01.flac");
    std::fs::write(&path, vec![0x5au8; 4096]).unwrap();

    let err = open_source(path.to_str().unwrap()).err().unwrap();

    assert!(matches!(err, PlaybackError::Undecodable { .. }), "got {err:?}");
    std::fs::remove_dir_all(&dir).unwrap();
  }

  // usePlayback.ts switches on `kind` and reads these field names; this
  // pins the wire shape so a rename on either side fails here first.
  #[test]
  fn playback_error_serializes_as_a_kind_tagged_object() {
    let unreachable = PlaybackError::FileUnreachable {
      path: "/mnt/music/a.flac".into(),
      nearest_folder: Some("/mnt/music".into()),
      nearest_folder_empty: true,
      detail: "No such file or directory".into(),
    };
    assert_eq!(
      serde_json::to_value(&unreachable).unwrap(),
      serde_json::json!({
        "kind": "file_unreachable",
        "path": "/mnt/music/a.flac",
        "nearest_folder": "/mnt/music",
        "nearest_folder_empty": true,
        "detail": "No such file or directory",
      })
    );
    assert_eq!(
      serde_json::to_value(PlaybackError::Undecodable { path: "/a.flac".into(), detail: "bad".into() }).unwrap(),
      serde_json::json!({ "kind": "undecodable", "path": "/a.flac", "detail": "bad" })
    );
    assert_eq!(
      serde_json::to_value(PlaybackError::NoOutputDevice { detail: "none".into() }).unwrap(),
      serde_json::json!({ "kind": "no_output_device", "detail": "none" })
    );
  }

  #[test]
  fn playback_state_defaults_to_repeat_off() {
    let state = PlaybackState::new();
    assert_eq!(*state.repeat_mode.lock().unwrap(), RepeatMode::Off);
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

  #[test]
  fn listed_device_ids_are_unique_and_labelled() {
    let devices = list_audio_devices().expect("list devices");
    let mut ids: Vec<&str> = devices.iter().map(|d| d.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), devices.len(), "two devices share an id: {devices:?}");
    assert!(devices.iter().all(|d| !d.label.is_empty() && d.id.contains(':')), "{devices:?}");
  }

  #[test]
  fn saved_device_matches_by_id() {
    assert!(matches_saved_device("coreaudio:BuiltInSpeakerDevice", "coreaudio:BuiltInSpeakerDevice", "BuiltInSpeakerDevice", "MacBook Pro Speakers"));
  }

  // A preference saved under cpal 0.16 is a name, not an id. macOS and
  // Windows reported the same string as today's label; ALSA reported the
  // PCM id, today's id minus its "alsa:" host prefix.
  #[test]
  fn saved_device_from_before_ids_still_matches() {
    assert!(matches_saved_device("MacBook Pro Speakers", "coreaudio:BuiltInSpeakerDevice", "BuiltInSpeakerDevice", "MacBook Pro Speakers"));
    assert!(matches_saved_device("pipewire", "alsa:pipewire", "pipewire", "PipeWire Sound Server"));
  }

  #[test]
  fn saved_device_does_not_match_a_different_device() {
    assert!(!matches_saved_device("alsa:pulse", "alsa:pipewire", "pipewire", "PipeWire Sound Server"));
    assert!(!matches_saved_device("", "alsa:pipewire", "pipewire", "PipeWire Sound Server"));
  }

  // Exercises the real audio engine against real hardware and a real file
  // — not run by default `cargo test` (needs a working audio device and
  // LEGATO_TEST_FILE pointed at a real audio file), but this is how
  // amplify_decibel/try_seek/get_pos were actually verified,
  // rather than just compiled and trusted.
  #[test]
  #[ignore]
  fn real_playback_smoke_test() {
    let path = std::env::var("LEGATO_TEST_FILE").expect("set LEGATO_TEST_FILE to a real audio file");
    let stream = DeviceSinkBuilder::open_default_sink().expect("open audio device");
    let sink = Player::connect_new(stream.mixer());

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
