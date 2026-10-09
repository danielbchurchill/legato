import { spawn, type ChildProcess } from "node:child_process";
import { createSocket, type RemoteInfo } from "node:dgram";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
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
// mDNSResponder and avahi do: one socket per interface, sending through it,
// and telling a client only the addresses on its own link. A Pi on wlan0
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
// from `address`, takes questions from clients on its IPv4 `subnets`, and
// advertises `addresses`: its own, and no other interface's. A client
// on wlan0 can reach wlan0's address, but not necessarily eth0's, and never
// tailscale0's 100.64.0.0/10 one unless it runs Tailscale itself.
export type LanInterface = {
  name: string;
  address: string;
  subnets: { address: string; netmask: string }[];
  addresses: string[];
};

// Every interface a LAN client could be on. Loopback is left out, and so is
// an interface with no IPv4 address, since the responder multicasts over
// IPv4. IPv6 link-local addresses aren't advertised: a URL can't use one
// without its interface's scope id.
export function lanInterfaces(table: ReturnType<typeof networkInterfaces> = networkInterfaces()): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, entries] of Object.entries(table)) {
    const usable = (entries ?? []).filter((e) => !e.internal && !(e.family === "IPv6" && /^fe80:/i.test(e.address)));
    const subnets = usable.filter((e) => e.family === "IPv4").map(({ address, netmask }) => ({ address, netmask }));
    if (subnets.length === 0) continue;
    out.push({ name, address: subnets[0]!.address, subnets, addresses: usable.map((e) => e.address) });
  }
  return out;
}

function ipv4(address: string): number {
  return address.split(".").reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
}

// Whether a question from `source` came from this interface's link. On
// Linux a socket on 5353 gets the group's multicast from every interface,
// not just the one it joined on, so this is how each socket picks out the
// questions that are its own to answer. One from no interface's subnet
// gets no answer: none of this server's addresses is on its link.
export function onLink(iface: LanInterface, source: string): boolean {
  return iface.subnets.some(({ address, netmask }) => ((ipv4(source) ^ ipv4(address)) & ipv4(netmask)) === 0);
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

// What this responder says to one question, or null when it isn't about
// this service. Additional records save the client a second round trip.
export function answerQuestion(records: Records, question: Question): Pick<Packet, "answers" | "additionals"> | null {
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

// The part of a multicast-dns instance the responder uses, so the spec can
// drive it without a socket. "joined" says the socket has joined the group
// on its interface and sends through it.
export type MdnsSocket = {
  on(event: "query" | "response", listener: (packet: Packet, rinfo: RemoteInfo) => void): unknown;
  on(event: "joined", listener: () => void): unknown;
  on(event: "error" | "warning", listener: (err: Error) => void): unknown;
  respond(packet: Pick<Packet, "answers" | "additionals">, cb?: (err: Error | null) => void): void;
  destroy(cb?: () => void): void;
};

// One interface's socket. It binds 5353 on every address, because on Linux
// a socket bound to one address gets no multicast, then joins the group on
// this interface alone and sends through it, so an answer goes out on the
// link its question came in on. Until it has joined, and if joining fails,
// the responder sends nothing on it: the kernel would pick the default
// interface, and this interface's addresses would go out on another link.
export function openMdnsSocket(iface: LanInterface): MdnsSocket {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const mdns = makeMdns({ socket, bind: "0.0.0.0", multicast: false });
  mdns.once("ready", () => {
    try {
      socket.addMembership(MDNS_GROUP, iface.address);
      socket.setMulticastInterface(iface.address);
      // RFC 6762 §11: responses go out with IP TTL 255.
      socket.setMulticastTTL(255);
      // So avahi, or a browser, on this same machine hears it too.
      socket.setMulticastLoopback(true);
    } catch (err) {
      mdns.emit("error", err);
      return;
    }
    mdns.emit("joined");
  });
  return mdns as unknown as MdnsSocket;
}

export type ResponderOptions = {
  log: AdvertiseLog;
  interfaces?: () => LanInterface[];
  openSocket?: (iface: LanInterface) => MdnsSocket;
  // How often to look for an interface or address that came or went (DHCP,
  // a cable plugged in, a laptop changing networks), and announce on it.
  recheckMs?: number;
};

// One interface's socket, and where it's got to.
type Link = {
  iface: LanInterface;
  socket: MdnsSocket;
  joined: boolean;
  failed: boolean;
  warned: boolean;
  second?: ReturnType<typeof setTimeout>;
};

export function startResponder(ad: Advertisement, options: ResponderOptions): Advertiser {
  const { log } = options;
  const interfaces = options.interfaces ?? (() => lanInterfaces());
  const openSocket = options.openSocket ?? openMdnsSocket;
  const links = new Map<string, Link>();
  let label = instanceLabel(ad.name);
  let stopped = false;

  const records = (link: Link) => serviceRecords(ad, label, link.iface.addresses);
  const live = (link: Link) => !stopped && links.get(link.iface.name) === link;

  const send = (link: Link, packet: Pick<Packet, "answers" | "additionals">) => {
    if (!link.joined) return;
    link.socket.respond(packet, (err) => {
      // A send that fails (no route, a network going away) is retried by
      // the next query or announcement; one line says it's happening.
      if (err && !link.warned) {
        link.warned = true;
        log("warn", `mdns: couldn't send on ${link.iface.name} (${err.message}); clients there may not find this server`);
      }
    });
  };
  const announce = (link: Link) => {
    const { ptr, srv, txt, addresses } = records(link);
    send(link, { answers: [ptr, srv, txt, ...addresses], additionals: [] });
  };

  const open = (iface: LanInterface, warned = false) => {
    const link: Link = { iface, socket: openSocket(iface), joined: false, failed: false, warned };
    links.set(iface.name, link);
    link.socket.on("joined", () => {
      if (!live(link)) return;
      link.joined = true;
      // RFC 6762 §8.3: at least two announcements, a second apart.
      announce(link);
      link.second = setTimeout(() => live(link) && announce(link), 1000);
      link.second.unref?.();
    });

    link.socket.on("query", (packet, rinfo) => {
      if (!live(link) || !onLink(link.iface, rinfo.address)) return;
      for (const question of packet.questions ?? []) {
        const reply = answerQuestion(records(link), question);
        if (reply) send(link, reply);
      }
    });

    // Another server already answers for this instance name (two machines
    // both called "musicbox"): this one moves to "musicbox (2)" and so on,
    // which is what mDNSResponder and avahi do. The TXT name doesn't change.
    link.socket.on("response", (packet) => {
      if (!live(link)) return;
      const { instance, host } = records(link);
      const clash = [...(packet.answers ?? []), ...(packet.additionals ?? [])].some(
        (r) => r.type === "SRV" && sameName(r.name, instance) && !sameName(r.data.target, host),
      );
      if (!clash) return;
      const taken = /\((\d+)\)$/.exec(label);
      label = `${instanceLabel(ad.name).replace(/ \(\d+\)$/, "").slice(0, 57)} (${taken ? Number(taken[1]) + 1 : 2})`;
      log("info", `mdns: another server is advertising as "${ad.name}", so this one is "${label}"`);
      for (const each of links.values()) announce(each);
    });

    // A socket that couldn't bind or join sends nothing. The next recheck
    // tries that interface again, without another log line.
    link.socket.on("error", (err) => {
      link.joined = false;
      link.failed = true;
      if (!link.warned) log("warn", `mdns: not advertising on ${iface.name} (${err.message})`);
      link.warned = true;
    });
    link.socket.on("warning", () => {});
  };

  const close = (link: Link) => {
    links.delete(link.iface.name);
    clearTimeout(link.second);
    link.socket.destroy();
  };

  const first = interfaces();
  for (const iface of first) open(iface);
  const recheck = setInterval(() => {
    const next = new Map(interfaces().map((iface) => [iface.name, iface]));
    for (const link of [...links.values()]) {
      const iface = next.get(link.iface.name);
      if (!iface) {
        close(link);
        log("info", `mdns: no longer advertising on ${link.iface.name}`);
      } else if (link.failed || iface.address !== link.iface.address) {
        // The socket joined the group on the old address; a new one joins
        // on the new address, and announces there.
        close(link);
        open(iface, link.warned);
      } else {
        const changed = iface.addresses.join() !== link.iface.addresses.join();
        link.iface = iface;
        if (changed) announce(link);
      }
    }
    for (const iface of next.values()) {
      if (links.has(iface.name)) continue;
      open(iface);
      log("info", `mdns: now advertising on ${iface.name}`);
    }
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
              const { ptr, srv, txt } = records(link);
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
