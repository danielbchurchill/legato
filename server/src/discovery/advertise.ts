import { spawn, type ChildProcess } from "node:child_process";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { existsSync } from "node:fs";
import { BlockList, isIPv4 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { Answer, Packet, Question } from "dns-packet";
import makeMdns from "multicast-dns";

// Issue #117: this server advertises `_legato._tcp` on the LAN, so the
// desktop app can list it under "servers on this network" without anyone
// typing an address (plan 03, "Connecting a client"). The TXT record carries
// what the connect screen shows before it has asked the server anything:
// its name, its id (the legato.fm server id, so a client can tell which of
// the account's servers this is) and its version. A client still checks the
// id with POST /auth/identity before it trusts the advertisement with
// anything (src/connect/identity.ts): anyone on the LAN can advertise.
//
// Two ways to send it, because macOS won't let this process multicast on
// its own:
//   - macOS: through the system's mDNSResponder, with /usr/bin/dns-sd. Since
//     macOS 15, a process that sends multicast itself needs the user's Local
//     Network permission. The desktop app would have to ask for it, and a
//     server started by brew services has no window to ask from, so its
//     sends just fail (EHOSTUNREACH). mDNSResponder is a system daemon and
//     needs no permission, and it already answers for this machine's name.
//   - Everywhere else (Linux, Windows, Docker): a responder in this process,
//     on multicast-dns, which is plain JavaScript over node:dgram and so
//     compiles into the legato-server binary for every target. It binds 5353
//     with SO_REUSEADDR, alongside avahi-daemon or Windows' own responder.
//
// The responder answers on each interface separately (issue #326), the way
// mDNSResponder and avahi do: one socket per interface, loopback included,
// sending through it, and telling a client only the addresses on its own
// link. A Pi on wlan0
// and tailscale0 must not hand a LAN client its Tailscale address, which
// that client can't reach, and a server on two subnets has to be heard on
// both.
//
// LEGATO_MDNS=off turns both off (config.ts). Advertising never fails the
// server: anything that goes wrong is one log line and no advertisement.

export const SERVICE_TYPE = "_legato._tcp";
const SERVICE = `${SERVICE_TYPE}.local`;
const SERVICES_META = "_services._dns-sd._udp.local";

// RFC 6762 §10: records naming a host (SRV, A, AAAA) live 120 seconds,
// everything else 75 minutes.
const HOST_TTL = 120;
const OTHER_TTL = 4500;

export type Advertisement = { name: string; serverId: string; version: string; port: number };

export type AdvertiseLog = (level: "info" | "warn", message: string) => void;

export type Advertiser = { readonly backend: "dns-sd" | "responder"; stop(): Promise<void> };

// One DNS label, so a "." in the name can't split it. The TXT record keeps
// the real name for the client to show.
export function instanceLabel(name: string): string {
  return name.replace(/\./g, "-").slice(0, 63) || "Legato server";
}

export function txtEntries(ad: Advertisement): string[] {
  return [`id=${ad.serverId}`, `version=${ad.version}`, `name=${ad.name}`];
}

// The SRV target is a host name of this server's own, from its id, rather
// than the machine's: avahi or mDNSResponder already answers for that one,
// and two responders claiming a name is a conflict.
export function hostLabel(serverId: string): string {
  return `legato-${serverId.slice(0, 12)}.local`;
}

// An interface the responder answers on. It joins the mDNS group and sends
// from `address`, takes a client on one of its IPv4 `subnets` (CIDRs, as
// networkInterfaces() gives them) to be on its link, and has `addresses` of
// its own to advertise there. A client on wlan0 can reach wlan0's address,
// but not necessarily eth0's, and never tailscale0's 100.64.0.0/10 one
// unless it runs Tailscale itself. The `loopback` interface answers clients
// on this same machine, which can reach every address, so it has none of
// its own.
export type LanInterface = {
  name: string;
  address: string;
  subnets: string[];
  addresses: string[];
  loopback?: boolean;
};

// Every interface a client could ask on: each one with an IPv4 address,
// since the responder multicasts over IPv4, and loopback. Linux lists an
// alias label (eth0:1) under a name of its own, but it's the same link as
// eth0, so its addresses go with eth0's. IPv6 link-local addresses aren't
// advertised: a URL can't use one without its interface's scope id.
export function lanInterfaces(table: ReturnType<typeof networkInterfaces> = networkInterfaces()): LanInterface[] {
  const devices = new Map<string, NetworkInterfaceInfo[]>();
  for (const [name, entries] of Object.entries(table)) {
    const device = name.replace(/:.*$/, "");
    devices.set(device, [...(devices.get(device) ?? []), ...(entries ?? [])]);
  }
  const out: LanInterface[] = [];
  for (const [name, entries] of devices) {
    const ipv4 = entries.filter((e) => e.family === "IPv4");
    if (ipv4.length === 0) continue;
    // A netmask that isn't one (no cidr) still leaves the address itself.
    const subnets = ipv4.map((e) => e.cidr ?? `${e.address}/32`);
    if (ipv4.some((e) => e.internal)) {
      if (!out.some((i) => i.loopback)) out.push({ name, address: ipv4[0]!.address, subnets, addresses: [], loopback: true });
      continue;
    }
    const usable = entries.filter((e) => !e.internal && !(e.family === "IPv6" && /^fe80:/i.test(e.address)));
    out.push({ name, address: ipv4[0]!.address, subnets, addresses: usable.map((e) => e.address) });
  }
  return out;
}

// Subnets in CIDR form, to check a client's address against.
export function subnetList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address!, Number(prefix), "ipv4");
  }
  return list;
}

type Records = { instance: string; host: string; ptr: Answer; srv: Answer; txt: Answer; addresses: Answer[] };

export function serviceRecords(ad: Advertisement, label: string, addresses: string[]): Records {
  const instance = `${label}.${SERVICE}`;
  const host = hostLabel(ad.serverId);
  return {
    instance,
    host,
    ptr: { name: SERVICE, type: "PTR", ttl: OTHER_TTL, data: instance },
    srv: { name: instance, type: "SRV", ttl: HOST_TTL, flush: true, data: { port: ad.port, target: host, priority: 0, weight: 0 } },
    txt: { name: instance, type: "TXT", ttl: OTHER_TTL, flush: true, data: txtEntries(ad) },
    addresses: addresses.map(
      (address): Answer => ({ name: host, type: address.includes(":") ? "AAAA" : "A", ttl: HOST_TTL, flush: true, data: address }),
    ),
  };
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");
}

type Reply = Pick<Packet, "answers" | "additionals">;

// What this responder says to one question, or null when it isn't about
// this service. Additional records save the client a second round trip.
export function answerQuestion(records: Records, question: Question): Reply | null {
  const { name, type } = question;
  // dns-packet's RecordType leaves out ANY, which a query can still ask.
  const any = (type as string) === "ANY";
  const describe = [records.srv, records.txt, ...records.addresses];
  if (sameName(name, SERVICE) && (type === "PTR" || any)) return { answers: [records.ptr], additionals: describe };
  if (sameName(name, SERVICES_META) && (type === "PTR" || any)) {
    return { answers: [{ name: SERVICES_META, type: "PTR", ttl: OTHER_TTL, data: SERVICE }], additionals: [] };
  }
  if (sameName(name, records.instance)) {
    const answers = [records.srv, records.txt].filter((r) => any || r.type === type);
    return answers.length > 0 ? { answers, additionals: records.addresses } : null;
  }
  if (sameName(name, records.host)) {
    const answers = records.addresses.filter((r) => any || r.type === type);
    return answers.length > 0 ? { answers, additionals: [] } : null;
  }
  return null;
}

const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;

// The part of a multicast-dns instance the responder uses, so the spec can
// drive it without a socket. "joined" says the socket has joined the group
// on its interface, and lists any optional setting that failed.
export type MdnsSocket = {
  on(event: "query" | "response", listener: (packet: Packet, rinfo: RemoteInfo) => void): unknown;
  on(event: "joined", listener: (skipped?: string[]) => void): unknown;
  on(event: "error" | "warning", listener: (err: Error) => void): unknown;
  respond(packet: Reply, cb?: (err: Error | null) => void): void;
  destroy(cb?: () => void): void;
};

// One interface's socket. It binds 5353 on every address, because on Linux
// a socket bound to one address gets no multicast, then joins the group on
// this interface alone. Until it has joined, and if joining fails, the
// responder sends nothing on it. The other settings are optional, as they
// are in multicast-dns itself: without its multicast interface, a socket
// still hears its link, and sends through the system's default one.
export function openMdnsSocket(iface: LanInterface): MdnsSocket {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const mdns = makeMdns({ socket, bind: "0.0.0.0", multicast: false });
  mdns.once("ready", () => {
    let skipped: string[];
    try {
      skipped = joinGroup(socket, iface.address);
    } catch (err) {
      mdns.emit("error", err);
      return;
    }
    mdns.emit("joined", skipped);
  });
  return mdns as unknown as MdnsSocket;
}

type MulticastSetting = "addMembership" | "setMulticastInterface" | "setMulticastTTL" | "setMulticastLoopback";

// Joins the group on the interface at `address` and sends through it.
// Throws if it can't join; returns what else it couldn't set.
export function joinGroup(socket: Pick<Socket, MulticastSetting>, address: string): string[] {
  try {
    socket.addMembership(MDNS_GROUP, address);
  } catch (err) {
    throw new Error(`joining ${MDNS_GROUP}: ${(err as Error).message}`);
  }
  const optional: [string, () => void][] = [
    // So an answer goes out on this interface's link.
    ["the multicast interface", () => socket.setMulticastInterface(address)],
    // RFC 6762 §11: responses go out with IP TTL 255.
    ["TTL 255", () => socket.setMulticastTTL(255)],
    // So avahi, or a browser, on this same machine hears it too.
    ["multicast loopback", () => socket.setMulticastLoopback(true)],
  ];
  const skipped: string[] = [];
  for (const [what, set] of optional) {
    try {
      set();
    } catch (err) {
      skipped.push(`${what} (${(err as Error).message})`);
    }
  }
  return skipped;
}

// The address this machine reaches `source` from. For a client on none of
// the server's subnets, that's the best guess at which link it's on: on
// Linux every socket hears the group on every interface, so the socket
// that heard it doesn't say. Connecting a UDP socket sends nothing; it only
// asks the routing table.
export function localAddressToward(source: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = createSocket("udp4");
    let settled = false;
    const done = (address: string | null) => {
      if (settled) return;
      settled = true;
      probe.close();
      resolve(address);
    };
    const local = () => {
      try {
        return probe.address().address;
      } catch {
        return null;
      }
    };
    probe.on("error", () => done(null));
    try {
      probe.connect(MDNS_PORT, source, () => done(local()));
    } catch {
      done(null);
    }
  });
}

export type ResponderOptions = {
  log: AdvertiseLog;
  interfaces?: () => LanInterface[];
  openSocket?: (iface: LanInterface) => MdnsSocket;
  // localAddressToward, so the spec can say where a client is.
  route?: (source: string) => Promise<string | null>;
  // How often to look for an interface or address that came or went (DHCP,
  // a cable plugged in, a laptop changing networks), and announce on it.
  recheckMs?: number;
};

// The same query heard on several sockets, or on two interfaces on one
// network, within this long is one query. A client asks again no sooner
// than a second later (RFC 6762 §5.2).
const DUPLICATE_MS = 500;

// One interface's socket, and where it's got to.
type Link = {
  iface: LanInterface;
  socket: MdnsSocket;
  subnets: BlockList;
  // What it announces and answers with, and its addresses as one string to
  // spot a change.
  records: Records;
  advertised: string;
  joined: boolean;
  failed: boolean;
  // A send through it has worked.
  sent: boolean;
  // Failures in a row, and rechecks left before the next try.
  failures: number;
  wait: number;
  // Says "now advertising" once a send works: an interface that came after
  // startup, or one that had failed.
  sayWhenUp: boolean;
  second?: ReturnType<typeof setTimeout>;
};

const unique = (list: string[]) => [...new Set(list)];
const ipv4Of = (iface: LanInterface) => iface.subnets.map((cidr) => cidr.split("/")[0]!);

export function startResponder(ad: Advertisement, options: ResponderOptions): Advertiser {
  const { log } = options;
  const interfaces = options.interfaces ?? (() => lanInterfaces());
  const openSocket = options.openSocket ?? openMdnsSocket;
  const route = options.route ?? localAddressToward;
  const host = hostLabel(ad.serverId);
  let links = new Map<string, Link>();
  let label = instanceLabel(ad.name);
  let instance = `${label}.${SERVICE}`;
  // What a client on none of the server's subnets is told: every address.
  let everywhere = serviceRecords(ad, label, []);
  let everyAddress = "";
  let stopped = false;
  const heard = new Map<string, number>();

  const live = (link: Link) => !stopped && links.get(link.iface.name) === link;
  const onLink = (link: Link, address: string) => isIPv4(address) && link.subnets.check(address, "ipv4");
  const shareSubnet = (a: Link, b: Link) => ipv4Of(b.iface).some((x) => onLink(a, x)) || ipv4Of(a.iface).some((x) => onLink(b, x));

  // Rebuilds what a link says when its addresses change, and every link's
  // after a rename, and returns the links whose addresses changed.
  // Interfaces that share a subnet (eth0 and wlan0 on one router) are one
  // network to a client there, so each of them advertises all of their
  // addresses, its own first: the cache-flush bit on an answer with only
  // some of them would wipe the rest from that client's cache.
  const refresh = (renamed = false): Link[] => {
    const all = [...links.values()];
    for (const link of all) link.subnets = subnetList(link.iface.subnets);
    const lan = all.filter((link) => !link.iface.loopback);
    const every = unique(lan.flatMap((link) => link.iface.addresses));
    if (renamed || every.join() !== everyAddress) everywhere = serviceRecords(ad, label, every);
    everyAddress = every.join();
    const changed: Link[] = [];
    for (const link of all) {
      const addresses = link.iface.loopback
        ? every
        : unique([link, ...lan.filter((other) => other !== link && shareSubnet(link, other))].flatMap((l) => l.iface.addresses));
      if (!renamed && addresses.join() === link.advertised) continue;
      if (addresses.join() !== link.advertised) changed.push(link);
      link.advertised = addresses.join();
      link.records = serviceRecords(ad, label, addresses);
    }
    return changed;
  };

  // A socket that couldn't bind, join or send sends nothing more, and the
  // next recheck opens it again, backing off while it keeps failing. A send
  // fails for good once its interface has been re-created under the same
  // name and address (a USB adapter replugged, tailscaled restarting): the
  // socket's membership points at the interface that's gone. One line says
  // it failed, and one more says when it works again.
  const fail = (link: Link, message: string) => {
    if (link.failed) return;
    link.failed = true;
    link.joined = false;
    clearTimeout(link.second);
    link.failures += 1;
    link.wait = Math.min(2 ** (link.failures - 1), 8) - 1;
    if (link.failures === 1) log("warn", `mdns: ${message}`);
  };

  const send = (link: Link, packet: Reply) => {
    if (!link.joined) return;
    link.socket.respond(packet, (err) => {
      if (!live(link)) return;
      if (err) return fail(link, `couldn't send on ${link.iface.name} (${err.message}); opening it again`);
      if (link.sent) return;
      link.sent = true;
      if (link.sayWhenUp) log("info", `mdns: now advertising on ${link.iface.name}`);
      link.failures = 0;
    });
  };
  const announce = (link: Link) => {
    const { ptr, srv, txt, addresses } = link.records;
    send(link, { answers: [ptr, srv, txt, ...addresses], additionals: [] });
  };

  const firstHeard = (packet: Packet, rinfo: RemoteInfo) => {
    const key = `${rinfo.address} ${rinfo.port} ${packet.id} ${(packet.questions ?? []).map((q) => `${q.name} ${q.type}`).join(" ")}`;
    const now = Date.now();
    for (const [each, at] of heard) if (now - at >= DUPLICATE_MS) heard.delete(each);
    if (heard.has(key)) return false;
    heard.set(key, now);
    return true;
  };

  // A query can reach any of the sockets: on Linux every one of them hears
  // the group on every interface, and a unicast query (RFC 6762 §5.5)
  // reaches just one, maybe another interface's. So whichever socket heard
  // it, the answer goes by the client's address: on the link whose subnet
  // it's on, with that link's addresses. A client on none of them (a
  // 169.254 address after DHCP failed, a static address on a second subnet
  // of the same LAN) gets every address, as before issue #326, on the link
  // this machine's route to it leaves by, since that's all that says where
  // it is. Each query is answered once, however many sockets heard it.
  const answer = (heardOn: Link, packet: Packet, rinfo: RemoteInfo) => {
    const all = [...links.values()];
    const local = all.filter((link) => onLink(link, rinfo.address));
    const via = local.find((link) => link.joined);
    if (local.length > 0 && !via) return;
    const records = via?.records ?? everywhere;
    const replies = (packet.questions ?? []).flatMap((question) => answerQuestion(records, question) ?? []);
    if (replies.length === 0 || !firstHeard(packet, rinfo)) return;
    if (via) {
      for (const reply of replies) send(via, reply);
      return;
    }
    void route(rinfo.address).then((address) => {
      const out = all.find((link) => address !== null && ipv4Of(link.iface).includes(address)) ?? heardOn;
      for (const reply of replies) send(out, reply);
    });
  };

  // Another server already answers for this instance name (two machines
  // both called "musicbox"): this one moves to "musicbox (2)" and so on,
  // which is what mDNSResponder and avahi do. The TXT name doesn't change.
  // Every socket hears it; the first renames, and the rest no longer match.
  const clashes = (records: Answer[] = []) =>
    records.some((r) => r.type === "SRV" && sameName(r.name, instance) && !sameName(r.data.target, host));
  const checkName = (packet: Packet) => {
    if (!clashes(packet.answers) && !clashes(packet.additionals)) return;
    const taken = /\((\d+)\)$/.exec(label);
    label = `${instanceLabel(ad.name).replace(/ \(\d+\)$/, "").slice(0, 57)} (${taken ? Number(taken[1]) + 1 : 2})`;
    instance = `${label}.${SERVICE}`;
    log("info", `mdns: another server is advertising as "${ad.name}", so this one is "${label}"`);
    refresh(true);
    for (const link of links.values()) announce(link);
  };

  const open = (iface: LanInterface, { failures = 0, later = true } = {}) => {
    const link: Link = {
      iface,
      socket: openSocket(iface),
      subnets: subnetList(iface.subnets),
      records: everywhere,
      advertised: "",
      joined: false,
      failed: false,
      sent: false,
      failures,
      wait: 0,
      sayWhenUp: later || failures > 0,
    };
    links.set(iface.name, link);
    link.socket.on("joined", (skipped = []) => {
      if (!live(link) || link.failed) return;
      link.joined = true;
      if (skipped.length > 0 && failures === 0) {
        log("warn", `mdns: couldn't set ${skipped.join(" or ")} on ${iface.name}; advertising there anyway`);
      }
      // RFC 6762 §8.3: at least two announcements, a second apart.
      announce(link);
      link.second = setTimeout(() => live(link) && announce(link), 1000);
      link.second.unref?.();
    });
    link.socket.on("query", (packet, rinfo) => live(link) && answer(link, packet, rinfo));
    link.socket.on("response", (packet) => live(link) && checkName(packet));
    link.socket.on("error", (err) => live(link) && fail(link, `not advertising on ${iface.name} (${err.message})`));
    link.socket.on("warning", () => {});
  };

  const close = (link: Link) => {
    links.delete(link.iface.name);
    clearTimeout(link.second);
    link.socket.destroy();
  };

  const first = interfaces();
  for (const iface of first) open(iface, { later: false });
  refresh();
  const recheck = setInterval(() => {
    const next = interfaces();
    const names = new Set(next.map((iface) => iface.name));
    for (const link of [...links.values()]) {
      if (names.has(link.iface.name)) continue;
      close(link);
      log("info", `mdns: no longer advertising on ${link.iface.name}`);
    }
    for (const iface of next) {
      const link = links.get(iface.name);
      if (!link) {
        open(iface);
      } else if (iface.address !== link.iface.address) {
        // The socket joined the group on the old address; a new one joins
        // on the new address, and announces there.
        close(link);
        open(iface, { failures: link.failed ? link.failures : 0, later: false });
      } else if (link.failed && link.wait === 0) {
        close(link);
        open(iface, { failures: link.failures, later: false });
      } else {
        if (link.failed) link.wait -= 1;
        link.iface = iface;
      }
    }
    // In the order the system lists them, which is the order an answer
    // picks a link in.
    links = new Map(next.map((iface) => [iface.name, links.get(iface.name)!]));
    for (const link of refresh()) announce(link);
  }, options.recheckMs ?? 30_000);
  recheck.unref?.();

  const names = first.map((iface) => iface.name).join(", ");
  log("info", `mdns: advertising ${SERVICE_TYPE} as "${ad.name}" on port ${ad.port} (${names || "no network yet"})`);

  return {
    backend: "responder",
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(recheck);
      await Promise.all(
        [...links.values()].map(
          (link) =>
            new Promise<void>((resolve) => {
              clearTimeout(link.second);
              const destroy = () => link.socket.destroy(() => resolve());
              if (!link.joined) return destroy();
              // A goodbye (TTL 0) takes it off every client's list at once
              // rather than when the records expire.
              const { ptr, srv, txt } = link.records;
              const goodbye = [ptr, srv, txt].map((r) => ({ ...r, ttl: 0 }) as Answer);
              link.socket.respond({ answers: goodbye, additionals: [] }, destroy);
            }),
        ),
      );
    },
  };
}

export const DNS_SD_PATH = "/usr/bin/dns-sd";

// dns-sd -R keeps the registration for as long as it runs. It's wrapped in
// a shell that kills it when this process's end of stdin closes, so a server
// that dies without cleaning up (SIGKILL, a crash) doesn't leave an
// advertisement behind for a server that's gone.
export function dnsSdCommand(ad: Advertisement): { command: string; args: string[] } {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      `"${DNS_SD_PATH}" "$@" & child=$!; read -r _; kill "$child" 2>/dev/null`,
      "legato-dns-sd",
      "-R",
      instanceLabel(ad.name),
      SERVICE_TYPE,
      "local",
      String(ad.port),
      ...txtEntries(ad),
    ],
  };
}

export type DnsSdOptions = { log: AdvertiseLog; spawnImpl?: typeof spawn; retryMs?: number };

export function startDnsSd(ad: Advertisement, options: DnsSdOptions): Advertiser {
  const { log } = options;
  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ChildProcess | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let announced = false;

  const run = () => {
    const { command, args } = dnsSdCommand(ad);
    const proc = spawnImpl(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    child = proc;
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (!announced && /Name now registered and active/.test(chunk.toString())) {
        announced = true;
        log("info", `mdns: advertising ${SERVICE_TYPE} as "${ad.name}" on port ${ad.port}, through mDNSResponder`);
      }
    });
    proc.on("error", (err) => log("warn", `mdns: couldn't start dns-sd (${err.message}); not advertising on the LAN`));
    // mDNSResponder restarting ends the registration; register again.
    proc.on("exit", () => {
      if (child === proc) child = null;
      if (stopped) return;
      announced = false;
      log("warn", "mdns: dns-sd stopped; advertising again in a minute");
      retry = setTimeout(run, options.retryMs ?? 60_000);
      retry.unref?.();
    });
  };
  run();

  return {
    backend: "dns-sd",
    stop: async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      child?.stdin?.end();
    },
  };
}

export function chooseBackend(platform: NodeJS.Platform, hasDnsSd: () => boolean): Advertiser["backend"] {
  return platform === "darwin" && hasDnsSd() ? "dns-sd" : "responder";
}

export function advertise(ad: Advertisement, log: AdvertiseLog): Advertiser {
  return chooseBackend(process.platform, () => existsSync(DNS_SD_PATH)) === "dns-sd"
    ? startDnsSd(ad, { log })
    : startResponder(ad, { log });
}
