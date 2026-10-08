use std::sync::atomic::Ordering;
use std::sync::Mutex;

use tauri::Manager;

mod discovery;
mod keep_awake;
mod playback;
mod probe;
mod relay_sign_in;
mod server_process;
mod serving;
mod tray;
use discovery::Discovery;
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
    .manage(Discovery::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Embed the server by default — it must start invisibly with the app,
      // not require a manually-launched second process. A look at Feishin,
      // a client that needs a separately run server, found the lack of this
      // exact behavior to be the load-bearing UX cost of a client-server
      // split.
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
      discovery::discovered_servers,
      probe::probe_server,
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
