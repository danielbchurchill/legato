import { isIPv6 } from "node:net";
import { ON_FLY } from "./config.js";

// Brute-force brake for POST /auth/token. The same shape as server/'s
// SignInLimiter (server/src/auth/rateLimit.ts); relay/ is its own package
// and can't import from server/, so this is a copy, not a share. A
// sign-in code is 32 random bytes and lives 60 seconds, so guessing one
// is already hopeless; this keeps a script from even trying at speed.
// In memory on purpose: a restart clearing it costs an attacker a restart
// they can't trigger, and a failed guess never becomes a database write.
//
// Two layers:
//   * per client address: 5 free failures, then a lockout that starts at
//     one minute and doubles on every further failure, capped at 15;
//   * across all addresses: more than 30 failures in a minute locks
//     everyone out until the window drains, so spreading guesses over
//     many addresses doesn't buy a faster rate. A brake can leave this
//     layer out (POST /link/redeem does, routes/link-page.ts).
// A success clears that address's record.

const FREE_FAILURES = 5;
const FIRST_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_FAILURES = 30;

type AddressRecord = { failures: number; lockedUntil: number };

export class TokenLimiter {
  private readonly byAddress = new Map<string, AddressRecord>();
  private globalFailures: number[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: { global: boolean } = { global: true },
  ) {}

  /** Seconds until this address may try again, or 0 if it may now. */
  retryAfterSeconds(address: string): number {
    const now = this.now();
    this.globalFailures = this.globalFailures.filter((at) => at > now - GLOBAL_WINDOW_MS);
    let waitMs = 0;
    if (this.options.global && this.globalFailures.length >= GLOBAL_MAX_FAILURES) {
      waitMs = this.globalFailures[0]! + GLOBAL_WINDOW_MS - now;
    }
    const record = this.byAddress.get(address);
    if (record && record.lockedUntil > now) waitMs = Math.max(waitMs, record.lockedUntil - now);
    return Math.ceil(waitMs / 1000);
  }

  recordFailure(address: string): void {
    const now = this.now();
    if (this.options.global) this.globalFailures.push(now);
    const record = this.byAddress.get(address) ?? { failures: 0, lockedUntil: 0 };
    record.failures++;
    if (record.failures >= FREE_FAILURES) {
      const doublings = record.failures - FREE_FAILURES;
      record.lockedUntil = now + Math.min(MAX_LOCKOUT_MS, FIRST_LOCKOUT_MS * 2 ** doublings);
    }
    this.byAddress.set(address, record);
  }

  recordSuccess(address: string): void {
    this.byAddress.delete(address);
  }
}

// A lighter brake for POST /pair/exchange (issue #324). It guards cost, not
// codes. A claim names the server whose QR was scanned, and the exchange
// redeems it for that server only (pairing.ts), so a guessed code is
// worthless: a code claimed for another server gets the same 404 as one
// nobody claimed. And a code claimed for the server asking never comes
// here: routes/pair.ts looks it up first and answers it whatever this says,
// so nothing else asking from that server's address can hold its claim up.
// What's left is everything else, the asks about codes this relay has no
// claim of for the server asking. Each costs a primary-key lookup, and is
// answered 404 without checking the signature.
//
// A home server asks about its own code every five seconds at most while
// its /setup page is open (server/src/auth/claim.ts, POLL_INTERVAL_MS; one
// page checking in every three seconds makes that every six), and gets a
// 404 every time until someone claims it. For the two minutes after its
// code changes it asks about the one it replaced as well. So one server
// asks at most 24 times in any minute, and ten behind one address at most
// 240, about at most three codes each in any fifteen minutes (a code is
// asked about for twelve minutes at most, and /setup can open late in one's
// life). Two limits, each well past that:
//   * every ask counts, repeats included: ASKS_PER_WINDOW in each minute,
//     then nothing more until the minute is up. That's what bounds a loop.
//   * each new code counts once. Each address remembers the codes it asked
//     about for CODE_MEMORY_MS from the first ask; FREE_CODES of them are
//     free, and each new one past them locks the address out of new codes
//     for a minute, doubling with each further one, up to fifteen. A code it
//     already asked about is still answered then, within the first limit.
// A refused ask counts toward neither, so a server that keeps asking while
// it's refused doesn't stretch the wait.
//
// Per address only. A global cap would let anyone with enough addresses
// refuse every server's first ask, everywhere at once. An IPv6 address
// counts as its /64, the block one subscriber is given, so one host can't
// step through its own addresses for a fresh allowance each time.
//
// The clock is monotonic, so a wall-clock step can't lift or stretch a
// wait. Memory stays bounded: a record goes once its codes age out and its
// minute is up, and past MAX_ADDRESSES the least recently used record that
// isn't holding its address back makes room (AddressRecords).
export const ASK_WINDOW_MS = 60_000;
export const ASKS_PER_WINDOW = 300;
export const CODE_MEMORY_MS = 15 * 60_000;
export const FREE_CODES = 30;
// How often an ask also drops other addresses' aged-out records. Each
// address's own are dropped whenever it asks.
const SWEEP_EVERY_MS = 60_000;

type ExchangeRecord = { codes: Map<string, number>; lockedUntil: number; windowStart: number; asks: number };

export class ExchangeLimiter {
  private readonly records = new AddressRecords<ExchangeRecord>();
  private lastSweepAt: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.lastSweepAt = now();
  }

  /**
   * An ask about a code this relay has no claim of for the server asking.
   * Seconds until this address may ask it, or 0 if it's answered now, and
   * then it's counted.
   */
  ask(address: string, code: string): number {
    const now = this.now();
    const block = addressBlock(address);
    this.sweep(now);
    const record = this.current(block, now) ?? { codes: new Map<string, number>(), lockedUntil: 0, windowStart: now, asks: 0 };
    if (now - record.windowStart >= ASK_WINDOW_MS) {
      record.windowStart = now;
      record.asks = 0;
    }
    const known = record.codes.has(code);
    let waitMs = 0;
    if (record.asks >= ASKS_PER_WINDOW) {
      waitMs = record.windowStart + ASK_WINDOW_MS - now;
    } else if (!known && record.lockedUntil > now) {
      waitMs = record.lockedUntil - now;
    } else {
      record.asks++;
      if (!known) record.codes.set(code, now);
      if (!known && record.codes.size > FREE_CODES) {
        const doublings = record.codes.size - FREE_CODES - 1;
        record.lockedUntil = now + Math.min(MAX_LOCKOUT_MS, FIRST_LOCKOUT_MS * 2 ** doublings);
      }
    }
    const held = record.lockedUntil > now || (record.asks >= ASKS_PER_WINDOW && now - record.windowStart < ASK_WINDOW_MS);
    this.records.use(block, record, held);
    return Math.ceil(waitMs / 1000);
  }

  // A lockout never outlasts the code that set it (MAX_LOCKOUT_MS is no
  // longer than CODE_MEMORY_MS), so a record with no codes left and its
  // minute up has nothing more to say.
  private current(block: string, now: number): ExchangeRecord | undefined {
    const record = this.records.get(block);
    if (!record) return undefined;
    for (const [code, firstAskedAt] of record.codes) {
      if (firstAskedAt <= now - CODE_MEMORY_MS) record.codes.delete(code);
    }
    if (record.codes.size > 0 || now - record.windowStart < ASK_WINDOW_MS) return record;
    this.records.delete(block);
    return undefined;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < SWEEP_EVERY_MS) return;
    this.lastSweepAt = now;
    for (const block of this.records.blocks()) this.current(block, now);
  }
}

// At most MAX_ADDRESSES records, one per address, for a limiter. A new
// address past that makes room by pushing out the least recently used
// record that wasn't holding its address back when it was last used. So
// asking from thousands of other addresses can't push a locked-out one out
// and hand it a fresh allowance. Only when every record is holding its
// address back does the least recently used of those go: that hands its
// address the allowance stepping through enough /64s gets anyway.
export const MAX_ADDRESSES = 10_000;

class AddressRecords<T> {
  // Each in least recently used order: use() moves a record to the end.
  private readonly open = new Map<string, T>();
  private readonly held = new Map<string, T>();

  get(block: string): T | undefined {
    return this.open.get(block) ?? this.held.get(block);
  }

  /** Files a record as just used, and as holding its address back or not. */
  use(block: string, record: T, holding: boolean): void {
    const known = this.open.delete(block) || this.held.delete(block);
    if (!known && this.open.size + this.held.size >= MAX_ADDRESSES) {
      const from = this.open.size > 0 ? this.open : this.held;
      from.delete(from.keys().next().value!);
    }
    (holding ? this.held : this.open).set(block, record);
  }

  delete(block: string): void {
    if (!this.open.delete(block)) this.held.delete(block);
  }

  *blocks(): IterableIterator<string> {
    yield* this.open.keys();
    yield* this.held.keys();
  }
}

// What ExchangeLimiter counts an address as: an IPv4 address as itself, an
// IPv6 one as its /64. An IPv4 address in IPv6 form (::ffff:203.0.113.9, as
// a dual-stack socket reports one, or the same in hex) is the IPv4 address,
// so IPv4 clients never share the one /64 those forms all start with.
export function addressBlock(address: string): string {
  const ip = address.replace(/%.*$/, "");
  if (!isIPv6(ip)) return ip;
  const groups = ipv6Groups(ip);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

// A valid IPv6 address's eight 16-bit groups, with :: filled in and a dotted
// IPv4 tail read as the last two.
function ipv6Groups(ip: string): number[] {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const hex = dotted
    ? `${ip.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : ip;
  const parse = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const [head = "", tail] = hex.split("::");
  if (tail === undefined) return parse(head);
  return [...parse(head), ...Array<number>(8 - parse(head).length - parse(tail).length).fill(0), ...parse(tail)];
}

// Behind Fly's proxy every request's socket peer is the proxy itself, so
// request.ip alone would put every client in one bucket. Fly sets
// Fly-Client-IP to the real peer on every request it forwards. Anywhere
// else nothing does, and the header is whatever the client chose to send,
// so off Fly (loopback dev, tests, a self-hosted relay) it's ignored and
// the socket peer is the address.
export function clientAddress(headers: Record<string, string | string[] | undefined>, socketIp: string, onFly: boolean = ON_FLY): string {
  if (!onFly) return socketIp;
  const fly = headers["fly-client-ip"];
  return (Array.isArray(fly) ? fly[0] : fly) || socketIp;
}
