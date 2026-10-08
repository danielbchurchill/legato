// Checking a custom address for the connect screen (issue #117): "that name
// doesn't exist", "nothing is listening there", "its certificate expired" and
// "that's not a Legato server" each need a different fix, so each gets its
// own answer. A webview's fetch() can't give them: WKWebView and WebKitGTK
// report every one of them as the same TypeError. So the desktop app checks
// natively, one step at a time, and stops at the first that fails:
//   1. resolve the name (the system resolver, so `.local` and MagicDNS names
//      work as they do everywhere else on the machine);
//   2. open a TCP connection to each address in turn;
//   3. for https, a TLS handshake verified by the OS (rustls-platform-
//      verifier), so it trusts what the webview trusts;
//   4. GET /api/v1/health, which every Legato server answers without a
//      session, and check it's Legato's JSON.
// React turns the result into a sentence (src/connect/probe.ts), so the
// wording lives in one place for both this and the browser's own check.

use std::io::{self, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{CertificateError, ClientConfig, ClientConnection, StreamOwned};
use serde::Serialize;
use tauri::Url;

#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
  pub dns: Duration,
  pub connect: Duration,
  pub io: Duration,
}

// Generous enough for a Raspberry Pi waking its disk or a name that takes
// mDNS a moment to answer; the whole check still ends inside ~15 seconds.
pub const TIMEOUTS: Timeouts = Timeouts {
  dns: Duration::from_secs(5),
  connect: Duration::from_secs(4),
  io: Duration::from_secs(6),
};

// A /health body is a few hundred bytes. Anything far past this isn't one.
const MAX_RESPONSE: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
  Dns,
  Connect,
  Tls,
  Http,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TlsProblem {
  /// Self-signed, or signed by an authority this computer doesn't trust.
  Untrusted,
  Expired,
  /// The certificate is for a different name.
  WrongHost,
  /// Whatever answered on that port doesn't speak TLS (often plain http).
  NotTls,
  Other,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Probe {
  Legato { name: Option<String>, version: Option<String> },
  Invalid,
  Dns { detail: String },
  Refused,
  Timeout { stage: Stage },
  Unreachable { detail: String },
  Tls { problem: TlsProblem, detail: String },
  NotLegato { status: Option<u16>, content_type: Option<String> },
}

pub fn probe(origin: &str, timeouts: Timeouts) -> Probe {
  let Ok(url) = Url::parse(origin) else { return Probe::Invalid };
  let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else { return Probe::Invalid };
  if url.scheme() != "http" && url.scheme() != "https" {
    return Probe::Invalid;
  }
  // An IPv6 literal comes back in brackets, which neither the resolver nor
  // a TLS server name takes.
  let host = host.trim_start_matches('[').trim_end_matches(']').to_string();

  let addrs = match resolve(&host, port, timeouts.dns) {
    Ok(addrs) => addrs,
    Err(probe) => return probe,
  };
  let tcp = match connect(&addrs, timeouts.connect) {
    Ok(tcp) => tcp,
    Err(probe) => return probe,
  };
  let _ = tcp.set_read_timeout(Some(timeouts.io));
  let _ = tcp.set_write_timeout(Some(timeouts.io));

  let authority = match url.port() {
    Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
    None => url.host_str().unwrap_or_default().to_string(),
  };
  if url.scheme() == "https" {
    match handshake(&host, tcp) {
      Ok(tls) => health(tls, &authority),
      Err(probe) => probe,
    }
  } else {
    health(tcp, &authority)
  }
}

/// The system resolver, on a thread of its own so a lookup that hangs (an
/// unanswered `.local` name, a dead DNS server) can't hold the check past
/// its timeout.
fn resolve(host: &str, port: u16, timeout: Duration) -> Result<Vec<SocketAddr>, Probe> {
  let (tx, rx) = mpsc::channel();
  let target = (host.to_string(), port);
  thread::spawn(move || {
    let _ = tx.send((target.0.as_str(), target.1).to_socket_addrs().map(|addrs| addrs.collect::<Vec<_>>()));
  });
  match rx.recv_timeout(timeout) {
    Ok(Ok(addrs)) if !addrs.is_empty() => Ok(addrs),
    Ok(Ok(_)) => Err(Probe::Dns { detail: "no addresses".into() }),
    Ok(Err(err)) => Err(Probe::Dns { detail: err.to_string() }),
    Err(_) => Err(Probe::Timeout { stage: Stage::Dns }),
  }
}

/// Tries every address. A refusal from any of them says the machine is
/// there and nothing listens on that port, which is the most useful thing
/// to report; a silence beats any other failure, since it usually means a
/// firewall or a machine that's asleep.
fn connect(addrs: &[SocketAddr], timeout: Duration) -> Result<TcpStream, Probe> {
  let mut errors = Vec::new();
  for addr in addrs {
    match TcpStream::connect_timeout(addr, timeout) {
      Ok(stream) => return Ok(stream),
      Err(err) => errors.push(err),
    }
  }
  Err(classify_connect(&errors))
}

fn classify_connect(errors: &[io::Error]) -> Probe {
  if errors.iter().any(|e| e.kind() == ErrorKind::ConnectionRefused) {
    return Probe::Refused;
  }
  if errors.iter().any(|e| matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock)) {
    return Probe::Timeout { stage: Stage::Connect };
  }
  Probe::Unreachable { detail: errors.first().map(|e| e.to_string()).unwrap_or_default() }
}

fn handshake(host: &str, mut tcp: TcpStream) -> Result<StreamOwned<ClientConnection, TcpStream>, Probe> {
  let setup = |detail: String| Probe::Tls { problem: TlsProblem::Other, detail };
  let provider = Arc::new(rustls::crypto::ring::default_provider());
  let verifier = rustls_platform_verifier::Verifier::new(provider.clone()).map_err(|e| setup(e.to_string()))?;
  let config = ClientConfig::builder_with_provider(provider)
    .with_safe_default_protocol_versions()
    .map_err(|e| setup(e.to_string()))?
    // "dangerous" is rustls's name for any verifier it didn't build itself;
    // this one is the operating system's own.
    .dangerous()
    .with_custom_certificate_verifier(Arc::new(verifier))
    .with_no_client_auth();
  let name = ServerName::try_from(host.to_string()).map_err(|e| setup(e.to_string()))?;
  let mut conn = ClientConnection::new(Arc::new(config), name).map_err(|e| setup(e.to_string()))?;
  while conn.is_handshaking() {
    if let Err(err) = conn.complete_io(&mut tcp) {
      return Err(classify_tls_io(err));
    }
  }
  Ok(StreamOwned::new(conn, tcp))
}

fn classify_tls_io(err: io::Error) -> Probe {
  if matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
    return Probe::Timeout { stage: Stage::Tls };
  }
  if let Some(tls) = err.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()) {
    return classify_tls(tls);
  }
  Probe::Tls { problem: TlsProblem::Other, detail: err.to_string() }
}

// On macOS the platform verifier maps only a few Security.framework results
// to rustls's own variants; the rest arrive as Other("<description>:
// <OSStatus>"). These two are the ones a person can act on.
const ERR_SEC_NOT_TRUSTED: &str = ": -67843";
const ERR_SEC_CERTIFICATE_EXPIRED: &str = ": -67818";

pub fn classify_tls(err: &rustls::Error) -> Probe {
  let problem = match err {
    rustls::Error::InvalidCertificate(cert) => match cert {
      CertificateError::Expired | CertificateError::ExpiredContext { .. } => TlsProblem::Expired,
      CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => TlsProblem::WrongHost,
      CertificateError::UnknownIssuer | CertificateError::BadSignature => TlsProblem::Untrusted,
      CertificateError::Other(other) => {
        let text = other.to_string();
        if text.ends_with(ERR_SEC_NOT_TRUSTED) {
          TlsProblem::Untrusted
        } else if text.ends_with(ERR_SEC_CERTIFICATE_EXPIRED) {
          TlsProblem::Expired
        } else {
          TlsProblem::Other
        }
      }
      _ => TlsProblem::Other,
    },
    // Bytes that aren't a TLS record: plain http on that port, most often.
    rustls::Error::InvalidMessage(_) => TlsProblem::NotTls,
    _ => TlsProblem::Other,
  };
  Probe::Tls { problem, detail: err.to_string() }
}

fn health<S: Read + Write>(mut stream: S, authority: &str) -> Probe {
  let request = format!(
    "GET /api/v1/health HTTP/1.1\r\nHost: {authority}\r\nAccept: application/json\r\nUser-Agent: Legato\r\nConnection: close\r\n\r\n"
  );
  if let Err(err) = stream.write_all(request.as_bytes()).and_then(|_| stream.flush()) {
    return read_failure(err);
  }
  let mut raw = Vec::new();
  let mut chunk = [0u8; 8192];
  loop {
    match stream.read(&mut chunk) {
      Ok(0) => break,
      Ok(n) => {
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() > MAX_RESPONSE || response_complete(&raw) {
          break;
        }
      }
      // A TLS server that closes without close_notify, after its answer.
      Err(err) if err.kind() == ErrorKind::UnexpectedEof && !raw.is_empty() => break,
      Err(err) => {
        if raw.is_empty() {
          return read_failure(err);
        }
        break;
      }
    }
  }
  classify_response(&raw)
}

fn read_failure(err: io::Error) -> Probe {
  match err.kind() {
    ErrorKind::TimedOut | ErrorKind::WouldBlock => Probe::Timeout { stage: Stage::Http },
    ErrorKind::ConnectionRefused => Probe::Refused,
    _ => Probe::NotLegato { status: None, content_type: None },
  }
}

struct Response {
  status: u16,
  content_type: Option<String>,
  body: Vec<u8>,
}

fn split_head(raw: &[u8]) -> Option<(&str, &[u8])> {
  let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
  Some((std::str::from_utf8(&raw[..end]).ok()?, &raw[end + 4..]))
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
  head.lines().skip(1).find_map(|line| {
    let (key, value) = line.split_once(':')?;
    key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
  })
}

/// True once a Content-Length body or a chunked body's last chunk is in,
/// so a server that ignores `Connection: close` doesn't make the check wait
/// out its read timeout.
fn response_complete(raw: &[u8]) -> bool {
  let Some((head, body)) = split_head(raw) else { return false };
  if let Some(length) = header(head, "content-length").and_then(|v| v.parse::<usize>().ok()) {
    return body.len() >= length;
  }
  header(head, "transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) && body.ends_with(b"0\r\n\r\n")
}

fn dechunk(mut body: &[u8]) -> Option<Vec<u8>> {
  let mut out = Vec::new();
  loop {
    let line_end = body.windows(2).position(|w| w == b"\r\n")?;
    let size_text = std::str::from_utf8(&body[..line_end]).ok()?;
    let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
    body = &body[line_end + 2..];
    if size == 0 {
      return Some(out);
    }
    out.extend_from_slice(body.get(..size)?);
    body = body.get(size + 2..)?;
  }
}

fn parse_response(raw: &[u8]) -> Option<Response> {
  let (head, body) = split_head(raw)?;
  let mut status_line = head.lines().next()?.split_whitespace();
  if !status_line.next()?.starts_with("HTTP/1.") {
    return None;
  }
  let status = status_line.next()?.parse().ok()?;
  let chunked = header(head, "transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked"));
  let body = if chunked { dechunk(body)? } else { body.to_vec() };
  Some(Response { status, content_type: header(head, "content-type").map(str::to_string), body })
}

/// Legato's /health is `{"status":"ok", …}` with a version; a server from
/// before #193 sent only status and libraryRoots, and is still Legato, just
/// one too old to tell us its name.
fn classify_response(raw: &[u8]) -> Probe {
  let Some(response) = parse_response(raw) else { return Probe::NotLegato { status: None, content_type: None } };
  let not_legato = Probe::NotLegato { status: Some(response.status), content_type: response.content_type.clone() };
  if response.status != 200 {
    return not_legato;
  }
  let Ok(serde_json::Value::Object(body)) = serde_json::from_slice::<serde_json::Value>(&response.body) else {
    return not_legato;
  };
  let text = |key: &str| body.get(key).and_then(|v| v.as_str()).map(str::to_string);
  let looks_legato = body.get("status").and_then(|v| v.as_str()) == Some("ok")
    && (body.get("version").is_some_and(|v| v.is_string()) || body.get("libraryRoots").is_some_and(|v| v.is_array()));
  if !looks_legato {
    return not_legato;
  }
  Probe::Legato { name: text("name"), version: text("version") }
}

#[tauri::command]
pub async fn probe_server(origin: String) -> Probe {
  tauri::async_runtime::spawn_blocking(move || probe(&origin, TIMEOUTS))
    .await
    .unwrap_or_else(|err| Probe::Unreachable { detail: err.to_string() })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;

  const QUICK: Timeouts = Timeouts {
    dns: Duration::from_secs(5),
    connect: Duration::from_secs(2),
    io: Duration::from_millis(500),
  };

  /// A one-shot server on 127.0.0.1 that reads the request and sends `reply`.
  fn serve(reply: impl Into<Vec<u8>>) -> String {
    let reply = reply.into();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let _ = stream.write_all(&reply);
      }
    });
    format!("http://127.0.0.1:{port}")
  }

  fn ok_json(body: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
  }

  #[test]
  fn a_legato_server_answers_with_its_name_and_version() {
    let origin = serve(ok_json(r#"{"status":"ok","name":"musicbox","version":"0.4.0","gitSha":"x"}"#));
    assert_eq!(probe(&origin, QUICK), Probe::Legato { name: Some("musicbox".into()), version: Some("0.4.0".into()) });
  }

  #[test]
  fn a_chunked_answer_and_a_server_from_before_version_counted() {
    let (first, second) = (r#"{"status":"ok",""#, r#"libraryRoots":[]}"#);
    let origin = serve(format!(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{first}\r\n{:x}\r\n{second}\r\n0\r\n\r\n",
      first.len(),
      second.len()
    ));
    assert_eq!(probe(&origin, QUICK), Probe::Legato { name: None, version: None });
  }

  #[test]
  fn something_else_answering_is_not_legato() {
    let html = serve("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 6\r\n\r\n<html>");
    assert_eq!(probe(&html, QUICK), Probe::NotLegato { status: Some(200), content_type: Some("text/html".into()) });
    let missing = serve("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    assert_eq!(probe(&missing, QUICK), Probe::NotLegato { status: Some(404), content_type: None });
    let other_json = serve(ok_json(r#"{"status":"ok"}"#));
    assert!(matches!(probe(&other_json, QUICK), Probe::NotLegato { status: Some(200), .. }));
    let not_http = serve("SSH-2.0-OpenSSH_9.6\r\n");
    assert_eq!(probe(&not_http, QUICK), Probe::NotLegato { status: None, content_type: None });
  }

  #[test]
  fn nothing_listening_is_refused() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert_eq!(probe(&format!("http://127.0.0.1:{port}"), QUICK), Probe::Refused);
  }

  #[test]
  fn a_name_that_doesnt_resolve_is_a_dns_failure() {
    // .invalid is reserved never to resolve (RFC 6761).
    assert!(matches!(probe("http://legato-117.invalid:8899", QUICK), Probe::Dns { .. }));
  }

  #[test]
  fn a_server_that_never_answers_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
      let held = listener.accept();
      thread::sleep(Duration::from_secs(2));
      drop(held);
    });
    assert_eq!(probe(&format!("http://127.0.0.1:{port}"), QUICK), Probe::Timeout { stage: Stage::Http });
  }

  #[test]
  fn https_to_a_plain_http_port_is_not_tls() {
    let origin = serve("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n").replace("http://", "https://");
    assert!(matches!(probe(&origin, QUICK), Probe::Tls { problem: TlsProblem::NotTls, .. }));
  }

  #[test]
  fn a_self_signed_certificate_is_untrusted() {
    let rcgen::CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
      .with_safe_default_protocol_versions()
      .unwrap()
      .with_no_client_auth()
      .with_single_cert(
        vec![cert.der().clone()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(signing_key.serialize_der().into()),
      )
      .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
      if let Ok((mut tcp, _)) = listener.accept() {
        let mut conn = rustls::ServerConnection::new(Arc::new(config)).unwrap();
        while conn.is_handshaking() {
          if conn.complete_io(&mut tcp).is_err() {
            break;
          }
        }
      }
    });
    let result = probe(&format!("https://localhost:{port}"), QUICK);
    assert!(matches!(result, Probe::Tls { problem: TlsProblem::Untrusted, .. }), "{result:?}");
  }

  #[test]
  fn certificate_errors_map_to_what_the_user_can_fix() {
    let problem = |err: rustls::Error| match classify_tls(&err) {
      Probe::Tls { problem, .. } => problem,
      other => panic!("{other:?}"),
    };
    assert_eq!(problem(rustls::Error::InvalidCertificate(CertificateError::Expired)), TlsProblem::Expired);
    assert_eq!(problem(rustls::Error::InvalidCertificate(CertificateError::NotValidForName)), TlsProblem::WrongHost);
    assert_eq!(problem(rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer)), TlsProblem::Untrusted);
    assert_eq!(problem(rustls::Error::InvalidMessage(rustls::InvalidMessage::InvalidContentType)), TlsProblem::NotTls);
    assert_eq!(problem(rustls::Error::General("x".into())), TlsProblem::Other);
    let apple = |text: &'static str| {
      #[derive(Debug)]
      struct Status(&'static str);
      impl std::fmt::Display for Status {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
          f.write_str(self.0)
        }
      }
      impl std::error::Error for Status {}
      rustls::Error::InvalidCertificate(CertificateError::Other(rustls::OtherError(Arc::new(Status(text)))))
    };
    assert_eq!(problem(apple("“x” certificate is not trusted: -67843")), TlsProblem::Untrusted);
    assert_eq!(problem(apple("“x” has expired: -67818")), TlsProblem::Expired);
    assert_eq!(problem(apple("something else: -1")), TlsProblem::Other);
  }

  #[test]
  fn bad_addresses_are_invalid() {
    assert_eq!(probe("not a url", QUICK), Probe::Invalid);
    assert_eq!(probe("ftp://musicbox:21", QUICK), Probe::Invalid);
  }

  #[test]
  fn serializes_for_react_with_a_kind() {
    let json = serde_json::to_value(Probe::NotLegato { status: Some(404), content_type: None }).unwrap();
    assert_eq!(json, serde_json::json!({ "kind": "notLegato", "status": 404, "contentType": null }));
    let json = serde_json::to_value(Probe::Timeout { stage: Stage::Connect }).unwrap();
    assert_eq!(json, serde_json::json!({ "kind": "timeout", "stage": "connect" }));
  }
}
