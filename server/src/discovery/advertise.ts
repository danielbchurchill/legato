import { spawn, type ChildProcess } from "node:child_process";
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

// Addresses a client on the LAN could connect to. IPv6 link-local addresses
// are left out: a URL can't use one without its interface's scope id.
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv6" && /^fe80:/i.test(entry.address)) continue;
      out.push(entry.address);
    }
  }
  return out;
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

// The part of a multicast-dns instance the responder uses, so the spec can
// drive it without a socket.
export type MdnsSocket = {
  on(event: "query" | "response", listener: (packet: Packet) => void): unknown;
  on(event: "error" | "warning", listener: (err: Error) => void): unknown;
  respond(packet: Pick<Packet, "answers" | "additionals">, cb?: (err: Error | null) => void): void;
  destroy(cb?: () => void): void;
};

export type ResponderOptions = {
  log: AdvertiseLog;
  mdns?: MdnsSocket;
  addresses?: () => string[];
  // How often to look for a changed address (DHCP, a laptop changing
  // networks), and re-announce if there is one.
  recheckMs?: number;
};

export function startResponder(ad: Advertisement, options: ResponderOptions): Advertiser {
  const { log } = options;
  const addresses = options.addresses ?? (() => lanAddresses());
  const mdns: MdnsSocket = options.mdns ?? (makeMdns() as unknown as MdnsSocket);
  let label = instanceLabel(ad.name);
  let current = addresses();
  let records = serviceRecords(ad, label, current);
  let stopped = false;
  let warned = false;

  const send = (packet: Pick<Packet, "answers" | "additionals">) =>
    mdns.respond(packet, (err) => {
      // A send that fails (no route, a network going away) is retried by
      // the next query or announcement; one line says it's happening.
      if (err && !warned) {
        warned = true;
        log("warn", `mdns: couldn't send on the LAN (${err.message}); clients may not find this server`);
      }
    });
  const announce = () => send({ answers: [records.ptr, records.srv, records.txt, ...records.addresses], additionals: [] });

  mdns.on("query", (packet) => {
    if (stopped) return;
    for (const question of packet.questions ?? []) {
      const reply = answerQuestion(records, question);
      if (reply) send(reply);
    }
  });

  // Another server already answers for this instance name (two machines
  // both called "musicbox"): this one moves to "musicbox (2)" and so on,
  // which is what mDNSResponder and avahi do. The TXT name doesn't change.
  mdns.on("response", (packet) => {
    if (stopped) return;
    const clash = [...(packet.answers ?? []), ...(packet.additionals ?? [])].some(
      (r) => r.type === "SRV" && sameName(r.name, records.instance) && !sameName(r.data.target, records.host),
    );
    if (!clash) return;
    const taken = /\((\d+)\)$/.exec(label);
    label = `${instanceLabel(ad.name).replace(/ \(\d+\)$/, "").slice(0, 57)} (${taken ? Number(taken[1]) + 1 : 2})`;
    records = serviceRecords(ad, label, current);
    log("info", `mdns: another server is advertising as "${ad.name}", so this one is "${label}"`);
    announce();
  });

  mdns.on("error", (err) => {
    if (!warned) log("warn", `mdns: not advertising on the LAN (${err.message})`);
    warned = true;
  });
  mdns.on("warning", () => {});

  // RFC 6762 §8.3: at least two announcements, a second apart.
  announce();
  const second = setTimeout(announce, 1000);
  second.unref?.();
  const recheck = setInterval(() => {
    const next = addresses();
    if (next.join() === current.join()) return;
    current = next;
    records = serviceRecords(ad, label, current);
    announce();
  }, options.recheckMs ?? 30_000);
  recheck.unref?.();

  log("info", `mdns: advertising ${SERVICE_TYPE} as "${ad.name}" on port ${ad.port}`);

  return {
    backend: "responder",
    stop: () =>
      new Promise((resolve) => {
        if (stopped) return resolve();
        stopped = true;
        clearTimeout(second);
        clearInterval(recheck);
        // A goodbye (TTL 0) takes it off every client's list at once rather
        // than when the records expire.
        const goodbye = [records.ptr, records.srv, records.txt].map((r) => ({ ...r, ttl: 0 }) as Answer);
        mdns.respond({ answers: goodbye, additionals: [] }, () => mdns.destroy(() => resolve()));
      }),
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
