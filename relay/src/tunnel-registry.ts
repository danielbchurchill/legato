import type { WebSocket } from "ws";
import type { RequestFrame, TunnelFrame } from "./protocol.js";

interface PendingHandlers {
  onStart(status: number, headers: Record<string, string>): void;
  onChunk(data: Buffer): void;
  onEnd(): void;
  onError(message: string): void;
}

// Owns the one authenticated home-server tunnel this prototype supports, and
// the demultiplexing table that routes response-* frames back to the HTTP
// request that's waiting on them. This is the actual hard part of the
// design: many /relay/* HTTP requests can be in flight at once, all sharing
// one WebSocket, distinguished only by requestId.
export class TunnelRegistry {
  #tunnel: WebSocket | undefined;
  #pending = new Map<string, PendingHandlers>();

  get connected(): boolean {
    return this.#tunnel !== undefined;
  }

  getTunnel(): WebSocket | undefined {
    return this.#tunnel;
  }

  // A second home server authenticating replaces the first rather than being
  // rejected — simplest behavior for a single-tenant prototype with no real
  // account system yet to say which tunnel *should* win. Real multi-tenant
  // routing (one tunnel per relay account) is exactly the follow-up work
  // Legato.md's "Relay architecture" section defers.
  setTunnel(socket: WebSocket): void {
    if (this.#tunnel && this.#tunnel !== socket) {
      this.#tunnel.close(4000, "replaced by a newer tunnel connection");
    }
    this.#tunnel = socket;
  }

  // Only clears if `socket` is still the active tunnel — an old, already-
  // replaced socket closing later must not clobber a newer one's state.
  clearTunnel(socket: WebSocket): void {
    if (this.#tunnel !== socket) return;
    this.#tunnel = undefined;
    for (const [requestId, handlers] of this.#pending) {
      handlers.onError("home server tunnel disconnected");
      this.#pending.delete(requestId);
    }
  }

  registerPending(requestId: string, handlers: PendingHandlers): void {
    this.#pending.set(requestId, handlers);
  }

  // Lets an HTTP-side abort (mobile client hung up) drop its slot without
  // waiting for a response that will now never be used.
  cancelPending(requestId: string): void {
    this.#pending.delete(requestId);
  }

  sendRequest(socket: WebSocket, frame: RequestFrame): void {
    socket.send(JSON.stringify(frame));
  }

  handleFrame(frame: TunnelFrame): void {
    if (!("requestId" in frame)) return;
    const handlers = this.#pending.get(frame.requestId);
    if (!handlers) return; // unknown, late, or already-settled requestId

    switch (frame.type) {
      case "response-start":
        handlers.onStart(frame.status, frame.headers);
        return;
      case "response-chunk":
        handlers.onChunk(Buffer.from(frame.data, "base64"));
        return;
      case "response-end":
        this.#pending.delete(frame.requestId);
        handlers.onEnd();
        return;
      case "response-error":
        this.#pending.delete(frame.requestId);
        handlers.onError(frame.message);
        return;
      default:
        return;
    }
  }
}
