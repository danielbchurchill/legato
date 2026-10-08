import { BlockList, isIP } from "node:net";
import { randomInt } from "node:crypto";
import type { FastifyRequest } from "fastify";

// Who may create the owner on a server that doesn't have one yet (issue
// #112). Without some proof of physical access, the first stranger on the
// LAN or tailnet to open a freshly upgraded Pi would become its owner.
//
// The desktop app's own embedded server is exempt: it's reached over
// loopback, from a loopback or tauri:// page, so whoever is sitting at that
// window already owns the machine. Everything else has to send the setup
// code. Issue #113 shows that code on a /setup page as well as in the log,
// with a QR code and a countdown, and replaces it every ten minutes so a
// code read off a screen yesterday is worth nothing today.

// Crockford base32: digits plus the alphabet minus I, L, O and U. Eight
// characters is 40 bits, shown as K7QM-4XRD. relay/src/claimCode.ts is the
// same alphabet and the same rules for the legato.fm pairing code; the two
// packages share no code, so a change here belongs there too.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

export const SETUP_CODE_TTL_MS = 10 * 60 * 1000;

export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What a person typed, in the K7QM-4XRD form, or null when it can't be a
 * code at all. Forgiving the way Crockford's own decoding is: any case, the
 * dash or spaces anywhere or nowhere, and O read as 0, I and L read as 1,
 * since those are exactly the pairs people misread off a terminal.
 */
export function normalizeCode(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const code = candidate
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH || [...code].some((char) => !CODE_ALPHABET.includes(char))) return null;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface IssuedCode {
  code: string;
  // Epoch milliseconds.
  expiresAt: number;
}

export type CodeCheck = "ok" | "expired" | "wrong";

type IssueListener = (issued: IssuedCode, replaced: string | null) => void;

/**
 * One live setup code at a time. A code is made on first use and replaced
 * whenever it's read after expiring: by a request, or by the timer
 * scheduleRefresh() starts, so the log gets the new one even when nobody
 * has the page open (H9: never make someone restart the server to get a
 * working code).
 */
export class SetupCodes {
  #issued: IssuedCode | null = null;
  // The code just replaced, kept only to tell "that code expired" apart
  // from "that code is wrong" when someone submits it a moment too late,
  // and to keep asking legato.fm about it for a little while (claimable).
  #previous: string | null = null;
  #replacedAt = Number.NEGATIVE_INFINITY;
  #listeners: IssueListener[] = [];
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #generate: () => string;

  constructor(options: { ttlMs?: number; now?: () => number; generate?: () => string } = {}) {
    this.#ttlMs = options.ttlMs ?? SETUP_CODE_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#generate = options.generate ?? generateCode;
  }

  onIssue(listener: IssueListener): void {
    this.#listeners.push(listener);
  }

  current(): IssuedCode {
    const now = this.#now();
    if (!this.#issued || now >= this.#issued.expiresAt) {
      const replaced = this.#issued?.code ?? null;
      let code = this.#generate();
      // 1 in 2^40, but an "expired" message for a code that's still on
      // screen would be a baffling thing to debug.
      while (code === replaced) code = this.#generate();
      this.#previous = replaced;
      this.#replacedAt = now;
      this.#issued = { code, expiresAt: now + this.#ttlMs };
      for (const listener of this.#listeners) listener(this.#issued, replaced);
    }
    return this.#issued;
  }

  /** How long the live code has left, on this object's own clock. */
  remainingMs(): number {
    return Math.max(this.current().expiresAt - this.#now(), 0);
  }

  /**
   * Retires the live code now and issues the next one, as if it had
   * expired: someone used it to claim a different server on legato.fm
   * (issue #237), so it shouldn't stay on screen.
   */
  replace(): IssuedCode {
    if (this.#issued) this.#issued = { ...this.#issued, expiresAt: this.#now() };
    return this.current();
  }

  /**
   * The codes a claim on legato.fm could be waiting under (issue #237): the
   * live one, and the one it replaced if that was under graceMs ago. A
   * phone that scanned a code a minute before it changed is still signing
   * in when it claims it.
   */
  claimable(graceMs: number): string[] {
    const { code } = this.current();
    const recent = this.#previous !== null && this.#now() - this.#replacedAt < graceMs;
    return recent ? [code, this.#previous!] : [code];
  }

  check(candidate: unknown): CodeCheck {
    const code = normalizeCode(candidate);
    const { code: live } = this.current();
    if (code === live) return "ok";
    return code !== null && code === this.#previous ? "expired" : "wrong";
  }

  /**
   * Replaces the code as each one expires, for as long as stillNeeded()
   * says so (until there's an owner). Returns a function that stops it.
   */
  scheduleRefresh(stillNeeded: () => boolean): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      // A few milliseconds past expiry, so current() is sure to see it
      // expired rather than rearming for 0 ms in a loop.
      const wait = Math.max(this.current().expiresAt - this.#now(), 0) + 50;
      timer = setTimeout(() => {
        if (!stillNeeded()) return;
        this.current();
        arm();
      }, wait);
      timer.unref?.();
    };
    if (stillNeeded()) arm();
    return () => clearTimeout(timer);
  }
}

// The server's own. Routes take it as an option so tests can pass one on a
// fake clock.
export const setupCodes = new SetupCodes();

/** The live code, for log lines and tests. */
export function setupCode(): string {
  return setupCodes.current().code;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

function isTauriOrigin(url: URL): boolean {
  // tauri://localhost on macOS and Linux, http(s)://tauri.localhost on
  // Windows: the packaged desktop app's own page.
  return url.protocol === "tauri:" || url.hostname === "tauri.localhost";
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isTauriOrigin(url) || LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * True when this request came from this machine and from a page this
 * machine serves. All three parts matter:
 *   * the peer address — not someone on the LAN;
 *   * the Host header — not a DNS-rebinding page that resolved its own
 *     hostname to 127.0.0.1;
 *   * the Origin — not some website open in a browser on this machine,
 *     which can POST to 127.0.0.1 like anything else can.
 * A request with no Origin at all is a non-browser client (curl on this
 * machine), which is someone with a shell here already.
 */
export function isLocalRequest(request: FastifyRequest): boolean {
  if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "")) return false;
  const host = hostnameOf(request.headers.host);
  if (!host || !LOOPBACK_HOSTNAMES.has(host)) return false;
  const origin = request.headers.origin;
  return origin === undefined || isLocalOrigin(origin);
}

// Loopback, RFC 1918, link-local, Tailscale's CGNAT range and IPv6 unique
// local addresses (Tailscale's fd7a:115c:a1e0::/48 among them).
const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_NETWORKS.addAddress("::1", "ipv6");
PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NETWORKS.addSubnet("fe80::", 10, "ipv6");

function isPrivateAddress(address: string): boolean {
  const unmapped = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const family = isIP(unmapped);
  if (family === 0) return false;
  return PRIVATE_NETWORKS.check(unmapped, family === 4 ? "ipv4" : "ipv6");
}

// Names a public DNS record can't hand a victim's browser: a bare IP, a
// single label ("musicbox"), mDNS, the reserved home-network suffixes,
// and Tailscale's MagicDNS.
const HOME_NETWORK_SUFFIXES = [".local", ".lan", ".home", ".home.arpa", ".internal", ".localhost", ".ts.net"];

function isHomeNetworkHostname(hostname: string): boolean {
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (!name.includes(".")) return true;
  return HOME_NETWORK_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Whether this request may be *shown* the setup code (GET /auth/setup).
 * Issue #113 accepts that anyone on the home network can claim an unclaimed
 * server; this is what keeps it to the home network and to pages that
 * aren't someone else's:
 *   * the peer is on a private network, and not behind a reverse proxy
 *     (whose own address says nothing about who's on the far side of it);
 *   * the Host is a name only the home network can resolve, so a
 *     DNS-rebinding page on a public domain can't read it same-origin;
 *   * the Origin, if any, is this same host or the desktop app. CORS here
 *     reflects every origin (index.ts), so without this any website open
 *     on the LAN could fetch the code and post it straight back.
 * Anyone refused still gets in by typing the code from the server's log.
 */
export function maySeeSetupCode(request: FastifyRequest): boolean {
  if (isLocalRequest(request)) return true;
  const headers = request.headers;
  if (headers["x-forwarded-for"] || headers.forwarded || headers["x-real-ip"]) return false;
  if (!isPrivateAddress(request.socket.remoteAddress ?? "")) return false;
  const host = hostnameOf(headers.host);
  if (!host || !isHomeNetworkHostname(host)) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return isTauriOrigin(url) || url.hostname === host;
  } catch {
    return false;
  }
}
