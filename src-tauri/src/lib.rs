use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::time::Instant;

use rodio::{Decoder, OutputStreamBuilder, Sink};

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
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![play_native_gapless_spike])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
