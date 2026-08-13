import type { WebSocket } from "ws";

// Shared pub/sub for the whole app — scan progress today, enrichment
// progress and live node updates (M4/M5/M7/M8) reuse this same broadcaster
// rather than each milestone standing up its own socket set.
const sockets = new Set<WebSocket>();

export function registerSocket(socket: WebSocket): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
}

export function broadcast(event: string, payload: unknown): void {
  const message = JSON.stringify({ event, payload });
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
}
