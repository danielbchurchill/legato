use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Instant;

use rodio::{Decoder, OutputStreamBuilder, Sink};
use tauri::Manager;

mod keep_awake;
mod playback;
mod relay_sign_in;
mod server_process;
mod serving;
mod tray;
use keep_awake::KeepAwake;
use playback::PlaybackState;
use relay_sign_in::SignInState;
use server_process::ServerProcess;
use serving::{ProcessRunner, Serving, ServingState};

// Passed by the login item (tauri-plugin-autostart) so a launch at login
// comes up in the tray only. A server starting with the session has no one
// sitting in front of it yet; a window opening on every boot would be in
// the way. Ignored when there's no tray, since then the window is the only
// way in.
const BACKGROUND_ARG: &str = "--background";

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
    // Rust-only: relay_sign_in.rs opens the system browser through it.
    // capabilities/default.json grants it nothing, so the webview can't.
    .plugin(tauri_plugin_opener::init())
    // Only Rust calls it, through serving.rs's commands; capabilities/
    // default.json grants the webview none of its own.
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      Some(vec![BACKGROUND_ARG]),
    ))
    .manage(ServerProcess(Mutex::new(None)))
    .manage(PlaybackState::new())
    .manage(SignInState::default())
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
      //
      // Installed whether or not the first start succeeds: a resume from the
      // tray can start the server later, and it must die with the app too.
      server_process::install_signal_handler(app.handle());
      let serving = Serving::start(ProcessRunner(app.handle().clone()));
      app.manage(ServingState::new(serving, serving::settings_file(app.handle())?));

      match server_process::stream_activity_file(app.handle()) {
        Ok(activity_file) => {
          let handle = app.handle().clone();
          app.manage(keep_awake::spawn_worker(activity_file, move || {
            let state = handle.state::<ServingState>();
            (state.keep_awake.load(Ordering::Relaxed), state.is_serving())
          }));
        }
        Err(e) => log::error!("[keep-awake] {e}"),
      }

      // The window starts hidden (tauri.conf.json, visible: false) so a
      // background launch never flashes it on screen.
      let has_tray = tray::install(app.handle());
      let background = std::env::args().any(|arg| arg == BACKGROUND_ARG);
      if !(background && has_tray) {
        tray::show_main_window(app.handle());
      }

      Ok(())
    })
    // Closing the window hides it; the server keeps serving, and the tray
    // brings the window back. Only with a tray, though: without one a
    // hidden window would leave no way back in, so close quits as before.
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.app_handle().try_state::<tray::Tray>().is_some() {
          api.prevent_close();
          let _ = window.hide();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      play_native_gapless_spike,
      playback::queue_enqueue,
      playback::queue_play,
      playback::queue_pause,
      playback::queue_stop,
      playback::queue_seek,
      playback::queue_skip,
      playback::queue_set_repeat,
      playback::queue_status,
      playback::queue_set_volume,
      playback::list_audio_devices,
      playback::queue_set_device,
      relay_sign_in::relay_sign_in,
      relay_sign_in::relay_sign_in_cancel,
      serving::serving_settings,
      serving::set_launch_at_login,
      serving::set_keep_awake,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| match event {
      tauri::RunEvent::Exit => {
        if let Some(keep_awake) = app_handle.try_state::<KeepAwake>() {
          keep_awake.shutdown();
        }
        server_process::kill(&app_handle.state::<ServerProcess>());
      }
      // Clicking the Dock icon while the window is hidden.
      #[cfg(target_os = "macos")]
      tauri::RunEvent::Reopen { .. } => tray::show_main_window(app_handle),
      _ => {}
    });
}
