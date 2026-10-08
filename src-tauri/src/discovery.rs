// "Servers on this network" on the connect screen (issue #117): every
// `_legato._tcp` instance on the LAN, which each Legato server advertises
// with its name, id and version in TXT (server/src/discovery/advertise.ts).
// A webview can't browse mDNS, so the desktop app does it here, with
// mdns-sd: pure Rust on every target, with its own socket on 5353 beside
// mDNSResponder, avahi or Windows' responder.
//
// The browse starts the first time React asks, not at launch: on macOS a
// browse is what brings up the Local Network permission prompt, and it
// should come when someone opens the connect screen, not on every launch.
// After that it keeps running, so a server that appears later shows up.
//
// What's listed is only what the network claims. React checks a server's
// identity (POST /auth/identity) before trusting it with a token.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::thread;

use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tauri::State;

pub const SERVICE_TYPE: &str = "_legato._tcp.local.";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundServer {
  /// The mDNS instance name, which a responder may have suffixed (" (2)").
  pub instance: String,
  /// TXT `name`, the server's own name for itself.
  pub name: String,
  /// TXT `id`: the server's legato.fm id, if it sent a well-formed one.
  pub id: Option<String>,
  pub version: Option<String>,
  pub port: u16,
  /// IPv4 first, since a URL can use one as it is.
  pub addresses: Vec<String>,
}

fn is_server_id(value: &str) -> bool {
  value.len() == 32 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn found_server(
  fullname: &str,
  port: u16,
  addresses: impl IntoIterator<Item = IpAddr>,
  txt: impl Fn(&str) -> Option<String>,
) -> FoundServer {
  let instance = fullname.strip_suffix(&format!(".{SERVICE_TYPE}")).unwrap_or(fullname).to_string();
  // A link-local IPv6 address needs its interface's scope id to be used in
  // a URL, which a webview's fetch can't take.
  let mut addresses: Vec<IpAddr> = addresses
    .into_iter()
    .filter(|ip| !matches!(ip, IpAddr::V6(v6) if v6.segments()[0] & 0xffc0 == 0xfe80))
    .collect();
  addresses.sort_by_key(|ip| (ip.is_ipv6(), *ip));
  FoundServer {
    name: txt("name").filter(|n| !n.trim().is_empty()).unwrap_or_else(|| instance.clone()),
    id: txt("id").filter(|id| is_server_id(id)),
    version: txt("version"),
    port,
    addresses: addresses.iter().map(IpAddr::to_string).collect(),
    instance,
  }
}

fn from_resolved(service: &ResolvedService) -> FoundServer {
  found_server(
    &service.fullname,
    service.port,
    service.addresses.iter().map(|ip| ip.to_ip_addr()),
    |key| service.txt_properties.get_property_val_str(key).map(str::to_string),
  )
}

type Found = Arc<Mutex<BTreeMap<String, FoundServer>>>;

struct Browser {
  _daemon: ServiceDaemon,
  found: Found,
}

impl Browser {
  fn start() -> Result<Self, String> {
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let events = daemon.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;
    let found: Found = Arc::default();
    let sink = found.clone();
    thread::Builder::new()
      .name("legato-mdns-browse".into())
      .spawn(move || {
        while let Ok(event) = events.recv() {
          let mut found = sink.lock().unwrap_or_else(|e| e.into_inner());
          match event {
            ServiceEvent::ServiceResolved(service) => {
              found.insert(service.fullname.clone(), from_resolved(&service));
            }
            ServiceEvent::ServiceRemoved(_, fullname) => {
              found.remove(&fullname);
            }
            _ => {}
          }
        }
      })
      .map_err(|e| e.to_string())?;
    Ok(Browser { _daemon: daemon, found })
  }

  fn snapshot(&self) -> Vec<FoundServer> {
    let mut list: Vec<FoundServer> = self.found.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
    list.sort_by_key(|server| server.name.to_lowercase());
    list
  }
}

#[derive(Default)]
pub struct Discovery(Mutex<Option<Browser>>);

/// Every Legato server seen on the LAN so far. The first call starts the
/// browse, so it returns nothing yet; React asks again every few seconds.
#[tauri::command]
pub fn discovered_servers(state: State<'_, Discovery>) -> Result<Vec<FoundServer>, String> {
  let mut browser = state.0.lock().unwrap_or_else(|e| e.into_inner());
  if browser.is_none() {
    *browser = Some(Browser::start().map_err(|e| format!("Couldn't look for servers on this network: {e}"))?);
  }
  Ok(browser.as_ref().map(Browser::snapshot).unwrap_or_default())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  fn txt(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |key| map.get(key).cloned()
  }

  #[test]
  fn reads_name_id_and_version_from_txt() {
    let server = found_server(
      "musicbox (2)._legato._tcp.local.",
      8899,
      ["fd00::20".parse().unwrap(), "fe80::1".parse().unwrap(), "192.168.1.20".parse().unwrap()],
      txt(&[("name", "musicbox"), ("id", "0123456789abcdef0123456789abcdef"), ("version", "0.4.0")]),
    );
    assert_eq!(
      server,
      FoundServer {
        instance: "musicbox (2)".into(),
        name: "musicbox".into(),
        id: Some("0123456789abcdef0123456789abcdef".into()),
        version: Some("0.4.0".into()),
        port: 8899,
        addresses: vec!["192.168.1.20".into(), "fd00::20".into()],
      }
    );
  }

  #[test]
  fn falls_back_to_the_instance_name_and_drops_an_id_that_isnt_one() {
    let server = found_server("kitchen._legato._tcp.local.", 8899, [], txt(&[("id", "not-an-id")]));
    assert_eq!(server.name, "kitchen");
    assert_eq!(server.id, None);
  }

  /// Run by hand beside a responder on lo0 (scratch.local/117 has the
  /// script): `cargo test discovery::tests::browses_loopback -- --ignored --nocapture`.
  #[test]
  #[ignore]
  fn browses_loopback() {
    let daemon = ServiceDaemon::new().unwrap();
    daemon.enable_interface(mdns_sd::IfKind::LoopbackV4).unwrap();
    let events = daemon.browse(SERVICE_TYPE).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while let Ok(event) = events.recv_deadline(deadline) {
      if let ServiceEvent::ServiceResolved(service) = event {
        println!("{:?}", from_resolved(&service));
        return;
      }
    }
    panic!("nothing found on loopback");
  }
}
