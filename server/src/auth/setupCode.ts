import { randomInt } from "node:crypto";
import type { FastifyRequest } from "fastify";

// Who may create the owner on a server that doesn't have one yet (issue
// #112). Without some proof of physical access, the first stranger on the
// LAN or tailnet to open a freshly upgraded Pi would become its owner.
//
// The desktop app's own embedded server is exempt: it's reached over
// loopback, from a loopback or tauri:// page, so whoever is sitting at that
// window already owns the machine. Everything else has to type the setup
// code the server logs at startup. #113 replaces "read it from the log"
// with a /setup page, QR code and countdown; the check here stays.

// Crockford base32 without the letters it drops: no 0/O, 1/I/L or U to
// misread off a terminal. Eight characters, shown as K7QM-4XRD.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

let current: string | null = null;

/** The code for this boot, created on first use. Stable until restart. */
export function setupCode(): string {
  if (!current) {
    let code = "";
    for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    current = `${code.slice(0, 4)}-${code.slice(4)}`;
  }
  return current;
}

// Forgiving about what a person types: case, the dash, stray spaces.
function normalize(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function isSetupCode(candidate: unknown): boolean {
  return typeof candidate === "string" && normalize(candidate) === normalize(setupCode());
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

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    // tauri://localhost on macOS and Linux, http(s)://tauri.localhost on
    // Windows: the packaged desktop app's own page.
    if (url.protocol === "tauri:" || url.hostname === "tauri.localhost") return true;
    return LOOPBACK_HOSTNAMES.has(url.hostname);
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
