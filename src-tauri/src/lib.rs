use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use rodio::{Decoder, OutputStreamBuilder, Sink};
use tauri::Manager;

mod playback;
mod server_process;
use playback::PlaybackState;
use server_process::ServerProcess;

// Phase 4 of THE SPIKE (see projects/Legato.md): does native decode +
// gapless playback via rodio/cpal sidestep the WebKitGTK Web Audio +
// Bluetooth bug found in the WASM-decoder-in-webview spike? Reads straight
// off disk, no HTTP round trip — isolates decode + Sink scheduling + native
// device output from everything already proven by the server/webview spike.
const MEDLEY_ROOT: &str = "/mnt/music/Music/The Beatles/Abbey Road";
const MEDLEY_TRACKS: [&str; 3] = [
  "11. Mean Mr. Mustard.flac",
  "12. Polythene Pam.flac",
  "13. She Came In Through The Bathroom Window.flac",
];

#[tauri::command]
fn play_native_gapless_spike() -> Result<(), String> {
  std::thread::spawn(|| {
    let t0 = Instant::now();
    let root = PathBuf::from(MEDLEY_ROOT);

    let stream_handle = match OutputStreamBuilder::open_default_stream() {
      Ok(s) => s,
      Err(e) => {
        log::error!("[native-spike] failed to open output stream: {e}");
        return;
      }
    };
    let sink = Sink::connect_new(stream_handle.mixer());

    for name in MEDLEY_TRACKS {
      let path = root.join(name);
      let file = match File::open(&path) {
        Ok(f) => f,
        Err(e) => {
          log::error!("[native-spike] failed to open {name}: {e}");
          return;
        }
      };
      match Decoder::new(BufReader::new(file)) {
        Ok(source) => {
          log::info!("[native-spike] +{:?} appending {name}", t0.elapsed());
          sink.append(source);
        }
        Err(e) => {
          log::error!("[native-spike] failed to decode {name}: {e}");
          return;
        }
      }
    }

    log::info!(
      "[native-spike] +{:?} all tracks appended, queue len={}",
      t0.elapsed(),
      sink.len()
    );
    sink.sleep_until_end();
    log::info!("[native-spike] +{:?} playback finished", t0.elapsed());
  });

  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(ServerProcess(Mutex::new(None)))
    .manage(PlaybackState::new())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Embed the server by default — it must start invisibly with the app,
      // not require a manually-launched second process. See the MVP
      // roadmap's M0 milestone and Feishin-Competitive-Analysis.md, which
      // found the lack of this exact behavior to be the load-bearing UX
      // cost of a client-server split.
      match server_process::spawn(app.handle()) {
        Ok(child) => {
          *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
          server_process::install_signal_handler(app.handle());
        }
        Err(e) => log::error!("[server] {e}"),
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      play_native_gapless_spike,
      playback::queue_enqueue,
      playback::queue_play,
      playback::queue_pause,
      playback::queue_stop,
      playback::queue_seek,
      playback::queue_skip,
      playback::queue_status,
      playback::queue_set_volume,
      playback::list_audio_devices,
      playback::queue_set_device,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      if let tauri::RunEvent::Exit = event {
        server_process::kill(&app_handle.state::<ServerProcess>());
      }
    });
}
