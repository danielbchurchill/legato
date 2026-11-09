import { networkInterfaces } from "node:os";
import type { ReadTailscaleStatus } from "./status.js";
import { localNetworks, whereIs, type LocalNetwork, type TailscaleStatus, type Whereabouts as Where } from "./where.js";

/* Issue #412: each device's home/away answer, pushed down its own WebSocket
 * (routes/ws.ts). A socket gets its answer as it connects, and again
 * whenever it changes.
 *
 * One `tailscale status --json` serves every device, run every POLL_MS
 * while any socket from a tailnet address is open and never otherwise, so a
 * server nobody reaches over Tailscale never runs it. A socket from any
 * other address is told "unknown" once and left alone. */

export const WHEREABOUTS_EVENT = "device:where";
export const WHEREABOUTS_POLL_MS = 5_000;

type Socket = {
  readonly readyState: number;
  readonly OPEN: number;
  send(message: string): void;
  on(event: "close", listener: () => void): unknown;
};

type Log = (level: "info" | "warn", message: string) => void;

export class Whereabouts {
  private readonly watched = new Map<Socket, { device: string; last: Where | null }>();
  private latest: { status: TailscaleStatus | null } | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failure: string | null = null;
  private readonly readStatus: ReadTailscaleStatus;
  private readonly networks: () => LocalNetwork[];
  private readonly pollMs: number;
  private readonly log: Log;

  constructor(options: { readStatus: ReadTailscaleStatus; networks?: () => LocalNetwork[]; pollMs?: number; log?: Log }) {
    this.readStatus = options.readStatus;
    this.networks = options.networks ?? (() => localNetworks(networkInterfaces()));
    this.pollMs = options.pollMs ?? WHEREABOUTS_POLL_MS;
    this.log = options.log ?? (() => {});
  }

  /** Tells `socket` where the device at tailnet address `device` is, now
   * and whenever that changes, until it closes. A null `device` (not a
   * tailnet address) is "unknown", said once. */
  watch(socket: Socket, device: string | null): void {
    if (!device) {
      send(socket, "unknown");
      return;
    }
    const entry = { device, last: null };
    // While other sockets keep the reads going, the last one is at most a
    // read old and answers at once. Otherwise it may be from long ago, so
    // this socket waits for a read of its own.
    const reading = this.running || this.timer !== null;
    this.watched.set(socket, entry);
    socket.on("close", () => this.forget(socket));
    if (reading && this.latest) this.tell(socket, entry, this.networks());
    if (!reading) void this.poll();
  }

  /** Stops reading the status. Sockets still open get nothing more. */
  stop(): void {
    this.watched.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private forget(socket: Socket): void {
    this.watched.delete(socket);
    if (this.watched.size === 0 && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    this.timer = null;
    this.running = true;
    let status: TailscaleStatus | null = null;
    try {
      status = await this.readStatus();
      this.noteFailure(null);
    } catch (error) {
      this.noteFailure(error instanceof Error ? error.message : String(error));
    }
    this.latest = { status };
    this.running = false;
    const networks = this.networks();
    for (const [socket, entry] of this.watched) this.tell(socket, entry, networks);
    if (this.watched.size > 0) {
      this.timer = setTimeout(() => void this.poll(), this.pollMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private tell(socket: Socket, entry: { device: string; last: Where | null }, networks: LocalNetwork[]): void {
    const where = whereIs(this.latest?.status ?? null, entry.device, networks);
    if (where === entry.last) return;
    entry.last = where;
    send(socket, where);
  }

  // One line when reading the status starts failing, or fails differently,
  // and one when it works again: not one every few seconds.
  private noteFailure(message: string | null): void {
    if (message === this.failure) return;
    if (message) {
      this.log("warn", `tailscale: can't tell whether devices on the tailnet are at home, so none is told it's away: ${message}`);
    } else {
      this.log("info", "tailscale: reading tailscaled's status again");
    }
    this.failure = message;
  }
}

function send(socket: Socket, where: Where): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event: WHEREABOUTS_EVENT, payload: { where } }));
}
