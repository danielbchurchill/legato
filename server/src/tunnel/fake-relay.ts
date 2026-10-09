// Test-only: a stand-in for legato.fm's tunnel endpoint, speaking the
// relay's protocol (relay/src/protocol.ts) just far enough to test this
// server's tunnel client on its own. Not a *.spec.ts, so `bun test` never
// runs it as a suite of its own. The relay's specs run the same client
// against the real relay (relay/src/tunnel.spec.ts).
import type { ServerWebSocket } from "bun";
import type { RequestFrame, TunnelFrame } from "../../../relay/src/protocol.js";

export type RelayedResponse = { status: number; headers: Record<string, string>; body: Buffer; chunks: number };

type SocketData = { userAgent: string | null };

export type FakeRelay = {
  /** http://127.0.0.1:<port>, what LEGATO_ID_ORIGIN would be. */
  origin: string;
  /** ws://127.0.0.1:<port>/tunnel */
  url: string;
  /** Every connection that reached /tunnel. */
  opened: number;
  /** The credential each auth frame carried, in order. */
  auths: string[];
  userAgents: (string | null)[];
  closed: number;
  /** Pings that reached it, from any tunnel. */
  pings: number;
  /** Sends a request down the newest signed-in tunnel and collects the answer. */
  request(frame: Omit<RequestFrame, "type" | "requestId">): Promise<RelayedResponse>;
  /** Sends any frame at all down the newest signed-in tunnel, the way a broken or hostile relay could. */
  send(frame: unknown): void;
  stop(): void;
};

export function startFakeRelay(options: { accept: (credential: string) => boolean; port?: number }): FakeRelay {
  const signedIn: ServerWebSocket<SocketData>[] = [];
  const waiting = new Map<string, (frame: TunnelFrame) => void>();
  // What each request is waiting on, so a tunnel that closes fails its
  // requests the way the relay does, rather than leaving them hanging.
  const waitingOn = new Map<string, ServerWebSocket<SocketData>>();
  let nextId = 0;

  const server = Bun.serve<SocketData>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/tunnel") return new Response("not found", { status: 404 });
      relay.opened += 1;
      if (srv.upgrade(req, { data: { userAgent: req.headers.get("user-agent") } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as TunnelFrame;
        if (frame.type === "auth") {
          relay.auths.push(frame.secret);
          relay.userAgents.push(ws.data.userAgent);
          if (options.accept(frame.secret)) {
            signedIn.push(ws);
            ws.send(JSON.stringify({ type: "auth-ok" }));
          } else {
            ws.send(JSON.stringify({ type: "auth-error", message: "missing or invalid tunnel credential" }));
            ws.close(4001, "missing or invalid tunnel credential");
          }
          return;
        }
        if ("requestId" in frame) waiting.get(frame.requestId)?.(frame);
      },
      ping() {
        relay.pings += 1;
      },
      close(ws) {
        relay.closed += 1;
        for (const [requestId, socket] of waitingOn) {
          if (socket === ws) waiting.get(requestId)?.({ type: "response-error", requestId, message: "home server tunnel disconnected" });
        }
        const at = signedIn.indexOf(ws);
        if (at >= 0) signedIn.splice(at, 1);
      },
    },
  });

  const relay: FakeRelay = {
    origin: `http://127.0.0.1:${server.port}`,
    url: `ws://127.0.0.1:${server.port}/tunnel`,
    opened: 0,
    auths: [],
    userAgents: [],
    closed: 0,
    pings: 0,
    request(frame) {
      const socket = signedIn.at(-1);
      if (!socket) return Promise.reject(new Error("no tunnel is signed in"));
      const requestId = `request-${++nextId}`;
      return new Promise((resolve, reject) => {
        let status = 0;
        let headers: Record<string, string> = {};
        const parts: Buffer[] = [];
        waiting.set(requestId, (answer) => {
          if (answer.type === "response-start") {
            status = answer.status;
            headers = answer.headers;
          } else if (answer.type === "response-chunk") {
            parts.push(Buffer.from(answer.data, "base64"));
          } else if (answer.type === "response-end") {
            waiting.delete(requestId);
            waitingOn.delete(requestId);
            resolve({ status, headers, body: Buffer.concat(parts), chunks: parts.length });
          } else if (answer.type === "response-error") {
            waiting.delete(requestId);
            waitingOn.delete(requestId);
            reject(new Error(answer.message));
          }
        });
        waitingOn.set(requestId, socket);
        socket.send(JSON.stringify({ type: "request", requestId, ...frame }));
      });
    },
    send(frame) {
      const socket = signedIn.at(-1);
      if (!socket) throw new Error("no tunnel is signed in");
      socket.send(JSON.stringify(frame));
    },
    stop() {
      server.stop(true);
    },
  };
  return relay;
}
