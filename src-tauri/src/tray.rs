//! The tray / menu-bar icon (issue #130): the way back into the app once
//! closing its window only hides it, and the place to pause or quit
//! serving.
//!
//! Where it shows up: the macOS menu bar; the Windows notification area;
//! on Linux, any panel that hosts StatusNotifierItem icons, which Tauri
//! reaches through libayatana-appindicator. COSMIC's status-area applet and
//! KDE host it out of the box. Stock GNOME needs the AppIndicator extension.
//! Linux trays only ever show the menu, so it has to carry every action;
//! nothing here relies on a left-click handler.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::serving::{self, ServingState, Status};

const OPEN: &str = "open";
const TOGGLE: &str = "toggle-serving";
const QUIT: &str = "quit";

/// Managed only once the tray icon actually exists. lib.rs checks for it
/// before hiding the window on close: with no tray, a hidden window would
/// leave no way back in.
pub struct Tray {
  icon: TrayIcon,
  status: MenuItem<Wry>,
  toggle: MenuItem<Wry>,
}

/// The menu's first (disabled, informational) line and its toggle item.
pub fn labels(status: Status) -> (&'static str, &'static str) {
  match status {
    Status::Serving => ("Legato is serving your library", "Pause serving"),
    Status::Paused => ("Serving is paused", "Resume serving"),
    Status::Failed => ("Legato couldn't start serving", "Try again"),
  }
}

fn current_status(app: &AppHandle) -> Status {
  app
    .try_state::<ServingState>()
    .and_then(|state| state.serving.lock().ok().map(|s| s.status()))
    .unwrap_or(Status::Failed)
}

/// Builds the icon. Returns whether there is one.
///
/// On Linux the appindicator library is loaded at runtime, and when it's
/// missing that load panics rather than returning an error. Catching the
/// panic keeps a machine without it at the old behavior (closing the
/// window quits) instead of a crash at launch.
pub fn install(app: &AppHandle) -> bool {
  match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build(app))) {
    Ok(Ok(tray)) => {
      app.manage(tray);
      true
    }
    Ok(Err(e)) => {
      log::error!("[tray] couldn't create the tray icon, closing the window will quit: {e}");
      false
    }
    Err(_) => {
      log::error!(
        "[tray] the tray icon library isn't available (on Linux, install libayatana-appindicator3), closing the window will quit"
      );
      false
    }
  }
}

fn build(app: &AppHandle) -> tauri::Result<Tray> {
  let (status_text, toggle_text) = labels(current_status(app));
  let status = MenuItem::with_id(app, "status", status_text, false, None::<&str>)?;
  let toggle = MenuItem::with_id(app, TOGGLE, toggle_text, true, None::<&str>)?;
  let menu = Menu::with_items(
    app,
    &[
      &status,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, OPEN, "Open Legato", true, None::<&str>)?,
      &toggle,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, QUIT, "Quit Legato", true, None::<&str>)?,
    ],
  )?;

  let mut builder = TrayIconBuilder::with_id("legato")
    .tooltip(status_text)
    .menu(&menu)
    .show_menu_on_left_click(true)
    .on_menu_event(|app, event| match event.id().as_ref() {
      OPEN => show_main_window(app),
      TOGGLE => serving::toggle(app),
      // RunEvent::Exit then runs the same teardown as any other quit:
      // server_process::kill on the whole process group, keep-awake released.
      QUIT => app.exit(0),
      _ => {}
    });
  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }

  Ok(Tray { icon: builder.build(app)?, status, toggle })
}

/// Brings the labels and tooltip in line with the current serving state.
pub fn refresh(app: &AppHandle) {
  let Some(tray) = app.try_state::<Tray>() else { return };
  let (status_text, toggle_text) = labels(current_status(app));
  let _ = tray.status.set_text(status_text);
  let _ = tray.toggle.set_text(toggle_text);
  let _ = tray.icon.set_tooltip(Some(status_text));
}

pub fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_toggle_names_what_it_will_do_next() {
    assert_eq!(labels(Status::Serving), ("Legato is serving your library", "Pause serving"));
    assert_eq!(labels(Status::Paused).1, "Resume serving");
    assert_eq!(labels(Status::Failed).1, "Try again");
  }
}
