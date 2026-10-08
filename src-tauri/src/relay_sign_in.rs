// The desktop half of handing a legato.fm sign-in back to the app (issue
// #215): OAuth for native apps (RFC 8252) with PKCE. The relay side lives
// in relay/src/native-sign-in.ts and relay/src/routes/auth.ts.
//
// One command, relay_sign_in, does the part only native code can do:
//   1. bind a one-shot listener on 127.0.0.1, port chosen by the OS;
//   2. open the system browser at the relay's sign-in, carrying the PKCE
//      challenge and that listener as the redirect;
//   3. serve exactly one real callback request with a plain "go back to
//      Legato" page, and hand its code back to React.
// React makes the verifier and challenge (src/auth/relaySession.ts), so
// the verifier never crosses IPC, and React redeems the code itself.
//
// The listener belongs to the command's own stack frame. Success,
// timeout, cancel and error all return from that frame, which drops the
// TcpListener and closes the port; nothing outlives the call.
//
// The browser is opened from here through tauri-plugin-opener's Rust API,
// and the plugin is deliberately granted no capability in
// capabilities/default.json, so the webview itself still can't open
// arbitrary URLs. The relay origin is checked first (relay_origin_allowed).

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Url};
use tauri_plugin_opener::OpenerExt;

// Long enough to read a consent screen, pick an account and type a
// password with 2FA; short enough that a sign-in someone walked away from
// doesn't hold a port open all afternoon.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
// A connection that opens and never sends a full request (a port scanner,
// a half-closed tab) can only stall the loop this long.
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST_HEAD: usize = 8 * 1024;

// The one path the relay will redirect to (NATIVE_CALLBACK_PATH in
// relay/src/native-sign-in.ts).
const CALLBACK_PATH: &str = "/callback";

const PRODUCTION_RELAY_ORIGIN: &str = "https://auth.legato.fm";

/// Emitted when the system browser couldn't be opened. The listener keeps
/// waiting, so pasting the URL into a browser by hand still finishes the
/// sign-in.
pub const OPEN_FAILED_EVENT: &str = "relay-sign-in://open-failed";

/// Holds the cancel flag of the sign-in in progress, if any, so a second
/// sign-in (or the Cancel button) can end the first one's wait.
#[derive(Default)]
pub struct SignInState(Mutex<Option<Arc<AtomicBool>>>);

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignInCallback {
  pub code: String,
  pub redirect_uri: String,
}

/// Every way a sign-in can end without a code. `message` is the text the
/// settings row shows, written to say what happened and what to do next.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SignInError {
  Timeout { message: String },
  Cancelled { message: String },
  Denied { message: String },
  ProviderError { message: String },
  Listener { message: String },
  Refused { message: String },
}

impl SignInError {
  fn timeout() -> Self {
    SignInError::Timeout {
      message: format!(
        "Sign-in timed out: Legato didn't hear back from your browser within {} minutes. Try again, and finish signing in in the browser tab that opens.",
        SIGN_IN_TIMEOUT.as_secs() / 60
      ),
    }
  }

  fn cancelled() -> Self {
    SignInError::Cancelled { message: "Sign-in cancelled.".into() }
  }

  fn from_callback_error(error: &str) -> Self {
    if error == "access_denied" {
      SignInError::Denied {
        message: "Sign-in was cancelled in the browser. Nothing changed; sign in again when you're ready.".into(),
      }
    } else {
      SignInError::ProviderError {
        message: "legato.fm couldn't finish signing you in with that provider. Try again in a moment; if it keeps happening, try the other provider.".into(),
      }
    }
  }
}

/// The relay origins this build will open a browser at: production
/// always, and in a debug build any loopback relay (`VITE_RELAY_URL=
/// http://127.0.0.1:8921` while developing). A packaged build pointed at
/// anything else is refused rather than sending a user's browser there.
pub fn relay_origin_allowed(origin: &Url) -> bool {
  let serialized = origin.origin().ascii_serialization();
  if serialized == PRODUCTION_RELAY_ORIGIN {
    return true;
  }
  cfg!(debug_assertions)
    && origin.scheme() == "http"
    && matches!(origin.host_str(), Some("127.0.0.1") | Some("localhost"))
}

fn is_s256_challenge(challenge: &str) -> bool {
  challenge.len() == 43 && challenge.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The relay sign-in URL for this attempt, or why it can't be built.
pub fn authorize_url(relay_origin: &str, provider: &str, code_challenge: &str, redirect_uri: &str) -> Result<Url, SignInError> {
  let refused = |message: String| SignInError::Refused { message };
  let origin = Url::parse(relay_origin).map_err(|_| refused(format!("\"{relay_origin}\" isn't a valid legato.fm address.")))?;
  if !relay_origin_allowed(&origin) {
    return Err(refused(format!(
      "This build of Legato only signs in through {PRODUCTION_RELAY_ORIGIN}, not {}.",
      origin.origin().ascii_serialization()
    )));
  }
  if provider != "google" && provider != "github" {
    return Err(refused(format!("\"{provider}\" isn't a sign-in provider legato.fm offers.")));
  }
  if !is_s256_challenge(code_challenge) {
    return Err(refused("The sign-in challenge wasn't a SHA-256 PKCE challenge.".into()));
  }
  let mut url = origin
    .join(&format!("/auth/{provider}"))
    .map_err(|_| refused(format!("Couldn't build a sign-in address from {relay_origin}.")))?;
  url
    .query_pairs_mut()
    .append_pair("redirect_uri", redirect_uri)
    .append_pair("code_challenge", code_challenge)
    .append_pair("code_challenge_method", "S256");
  Ok(url)
}

pub fn bind_listener() -> Result<(TcpListener, String), SignInError> {
  let listener = TcpListener::bind(("127.0.0.1", 0)).and_then(|l| {
    l.set_nonblocking(true)?;
    Ok(l)
  });
  let listener = listener.map_err(|e| SignInError::Listener {
    message: format!("Couldn't start the sign-in listener on 127.0.0.1 ({e}). Something on this computer may be blocking local connections."),
  })?;
  let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
  Ok((listener, format!("http://127.0.0.1:{port}{CALLBACK_PATH}")))
}

enum Request {
  Code(String),
  Error(String),
  // Anything that isn't the callback: a favicon fetch, a scanner, a
  // malformed request. Answered and ignored, so it can't end the wait.
  Other,
}

fn read_request_head(stream: &mut TcpStream) -> Option<String> {
  stream.set_nonblocking(false).ok()?;
  stream.set_read_timeout(Some(READ_TIMEOUT)).ok()?;
  let mut head = Vec::new();
  let mut buf = [0u8; 1024];
  while !head.windows(4).any(|w| w == b"\r\n\r\n") {
    let n = stream.read(&mut buf).ok()?;
    if n == 0 || head.len() + n > MAX_REQUEST_HEAD {
      return None;
    }
    head.extend_from_slice(&buf[..n]);
  }
  String::from_utf8(head).ok()
}

fn classify(head: &str) -> Request {
  let mut parts = head.lines().next().unwrap_or("").split(' ');
  let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
    return Request::Other;
  };
  let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
    return Request::Other;
  };
  if url.path() != CALLBACK_PATH {
    return Request::Other;
  }
  for (key, value) in url.query_pairs() {
    match key.as_ref() {
      "code" if !value.is_empty() => return Request::Code(value.into_owned()),
      "error" => return Request::Error(value.into_owned()),
      _ => {}
    }
  }
  Request::Other
}

// The page's background is tokens.css's ink canvas, like the app window the
// sign-in started from. src/styles/canvasCopies.spec.ts checks it against
// the token.
fn respond(stream: &mut TcpStream, status: &str, body: &str) {
  let page = format!(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Legato</title></head>\
<body style=\"margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0f1214;color:#c9c9c9;font-family:system-ui,sans-serif;font-size:14px;\">\
<p>{body}</p></body></html>"
  );
  let response = format!(
    "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{page}",
    page.len()
  );
  let _ = stream.write_all(response.as_bytes());
  let _ = stream.flush();
}

/// Waits for the one real callback on `listener`, answering anything else
/// with a 404 and carrying on. Returns at the deadline or when `cancel` is
/// set, whichever comes first.
pub fn wait_for_callback(listener: &TcpListener, deadline: Instant, cancel: &AtomicBool) -> Result<String, SignInError> {
  loop {
    if cancel.load(Ordering::SeqCst) {
      return Err(SignInError::cancelled());
    }
    if Instant::now() >= deadline {
      return Err(SignInError::timeout());
    }
    let mut stream = match listener.accept() {
      Ok((stream, _)) => stream,
      Err(e) if e.kind() == ErrorKind::WouldBlock => {
        std::thread::sleep(POLL_INTERVAL);
        continue;
      }
      // A connection reset before accept() finished is the client's
      // problem, not the sign-in's.
      Err(_) => continue,
    };
    let Some(head) = read_request_head(&mut stream) else {
      continue;
    };
    match classify(&head) {
      Request::Code(code) => {
        respond(&mut stream, "200 OK", "You can close this tab and go back to Legato.");
        return Ok(code);
      }
      Request::Error(error) => {
        respond(&mut stream, "200 OK", "Sign-in didn't finish. You can close this tab and go back to Legato to try again.");
        return Err(SignInError::from_callback_error(&error));
      }
      Request::Other => respond(&mut stream, "404 Not Found", "Not found."),
    }
  }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFailed {
  message: String,
  url: String,
}

#[tauri::command]
pub async fn relay_sign_in(
  app: AppHandle,
  state: State<'_, SignInState>,
  relay_origin: String,
  provider: String,
  code_challenge: String,
) -> Result<SignInCallback, SignInError> {
  let (listener, redirect_uri) = bind_listener()?;
  let url = authorize_url(&relay_origin, &provider, &code_challenge, &redirect_uri)?;

  // One sign-in at a time: a new one ends the previous one's wait, so two
  // listeners never race for the same browser tab.
  let cancel = Arc::new(AtomicBool::new(false));
  if let Some(previous) = state.0.lock().unwrap().replace(cancel.clone()) {
    previous.store(true, Ordering::SeqCst);
  }

  if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
    log::warn!("[relay-sign-in] couldn't open the system browser: {e}");
    let _ = app.emit(
      OPEN_FAILED_EVENT,
      OpenFailed {
        message: "Couldn't open your web browser. Open this address yourself to finish signing in:".into(),
        url: url.to_string(),
      },
    );
  }

  let deadline = Instant::now() + SIGN_IN_TIMEOUT;
  let waiting = cancel.clone();
  let result = tauri::async_runtime::spawn_blocking(move || wait_for_callback(&listener, deadline, &waiting))
    .await
    .unwrap_or_else(|_| Err(SignInError::cancelled()));

  // Only clear the slot if it's still ours; a newer sign-in may own it.
  let mut current = state.0.lock().unwrap();
  if current.as_ref().is_some_and(|flag| Arc::ptr_eq(flag, &cancel)) {
    *current = None;
  }
  drop(current);

  result.map(|code| SignInCallback { code, redirect_uri })
}

#[tauri::command]
pub fn relay_sign_in_cancel(state: State<'_, SignInState>) {
  if let Some(flag) = state.0.lock().unwrap().take() {
    flag.store(true, Ordering::SeqCst);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Read;
  use std::thread;

  const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  fn send(port: u16, request: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
  }

  fn port_of(listener: &TcpListener) -> u16 {
    listener.local_addr().unwrap().port()
  }

  #[test]
  fn binds_an_ephemeral_loopback_port_with_the_fixed_callback_path() {
    let (listener, redirect_uri) = bind_listener().unwrap();
    let port = port_of(&listener);
    assert_ne!(port, 0);
    assert_eq!(redirect_uri, format!("http://127.0.0.1:{port}/callback"));
  }

  #[test]
  fn returns_the_code_from_one_real_callback_and_ignores_stray_requests() {
    let (listener, _) = bind_listener().unwrap();
    let port = port_of(&listener);
    let client = thread::spawn(move || {
      let stray = send(port, "GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      let wrong_method = send(port, "POST /callback?code=nope HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      let real = send(port, "GET /callback?code=abc%2D123_x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      (stray, wrong_method, real)
    });

    let cancel = AtomicBool::new(false);
    let code = wait_for_callback(&listener, Instant::now() + Duration::from_secs(10), &cancel).unwrap();
    assert_eq!(code, "abc-123_x");

    let (stray, wrong_method, real) = client.join().unwrap();
    assert!(stray.starts_with("HTTP/1.1 404"));
    assert!(wrong_method.starts_with("HTTP/1.1 404"));
    assert!(real.starts_with("HTTP/1.1 200"));
    assert!(real.contains("You can close this tab and go back to Legato."));
  }

  #[test]
  fn a_provider_side_cancel_ends_the_wait_with_its_own_message() {
    let (listener, _) = bind_listener().unwrap();
    let port = port_of(&listener);
    let client = thread::spawn(move || send(port, "GET /callback?error=access_denied HTTP/1.1\r\n\r\n"));
    let cancel = AtomicBool::new(false);
    let result = wait_for_callback(&listener, Instant::now() + Duration::from_secs(10), &cancel);
    assert!(matches!(result, Err(SignInError::Denied { .. })));
    assert!(client.join().unwrap().contains("Sign-in didn't finish."));
  }

  #[test]
  fn times_out_and_closes_the_port() {
    let (listener, _) = bind_listener().unwrap();
    let port = port_of(&listener);
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let result = wait_for_callback(&listener, Instant::now() + Duration::from_millis(200), &cancel);
    assert!(matches!(result, Err(SignInError::Timeout { .. })));
    assert!(started.elapsed() < Duration::from_secs(2));

    drop(listener);
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
  }

  #[test]
  fn a_cancel_from_another_thread_ends_the_wait() {
    let (listener, _) = bind_listener().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    thread::spawn(move || {
      thread::sleep(Duration::from_millis(100));
      flag.store(true, Ordering::SeqCst);
    });
    let result = wait_for_callback(&listener, Instant::now() + Duration::from_secs(10), &cancel);
    assert!(matches!(result, Err(SignInError::Cancelled { .. })));
  }

  #[test]
  fn builds_the_relay_url_with_the_pkce_parameters() {
    let url = authorize_url("https://auth.legato.fm", "github", CHALLENGE, "http://127.0.0.1:5000/callback").unwrap();
    assert_eq!(url.origin().ascii_serialization(), "https://auth.legato.fm");
    assert_eq!(url.path(), "/auth/github");
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    assert_eq!(
      pairs,
      vec![
        ("redirect_uri".into(), "http://127.0.0.1:5000/callback".into()),
        ("code_challenge".into(), CHALLENGE.into()),
        ("code_challenge_method".into(), "S256".into()),
      ]
    );
  }

  #[test]
  fn refuses_to_open_a_browser_anywhere_but_the_relay() {
    for origin in ["https://evil.example", "http://auth.legato.fm", "https://auth.legato.fm.evil.example", "not a url"] {
      let result = authorize_url(origin, "github", CHALLENGE, "http://127.0.0.1:5000/callback");
      assert!(matches!(result, Err(SignInError::Refused { .. })), "{origin} should be refused");
    }
    assert!(authorize_url("https://auth.legato.fm", "facebook", CHALLENGE, "http://127.0.0.1:5000/callback").is_err());
    assert!(authorize_url("https://auth.legato.fm", "github", "plain-text", "http://127.0.0.1:5000/callback").is_err());
  }

  #[test]
  fn allows_a_loopback_relay_only_in_debug_builds() {
    let local = Url::parse("http://127.0.0.1:8921").unwrap();
    assert_eq!(relay_origin_allowed(&local), cfg!(debug_assertions));
  }
}
