import { sanitizeHeaders } from "../headers.js";
import { parseFrame, type RequestFrame } from "../protocol.js";

export interface FakeHomeServerHandle {
  close(): void;
}

// Plays the home-server side of the tunnel in tests: a real WebSocket
// client that authenticates against the relay's /tunnel endpoint, then for
// every request frame it receives, makes a real HTTP request against
// `targetBaseUrl` (a fixture server, also real) and streams the real
// response back through the framing protocol. Deliberately not a synthetic
// in-memory echo — see the relay-tunnel-prototype brief on why that's the
// more convincing test.
export async function connectFakeHomeServer(options: {
  tunnelUrl: string;
  secret: string;
  targetBaseUrl: string;
}): Promise<FakeHomeServerHandle> {
  const socket = new WebSocket(options.tunnelUrl);

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", secret: options.secret }));
    });
    const onAuthResult = (event: MessageEvent) => {
      const frame = parseFrame(String(event.data));
      if (!frame) return;
      if (frame.type === "auth-ok") {
        socket.removeEventListener("message", onAuthResult);
        resolve();
      } else if (frame.type === "auth-error") {
        socket.removeEventListener("message", onAuthResult);
        reject(new Error(frame.message));
      }
    };
    socket.addEventListener("message", onAuthResult);
    socket.addEventListener("error", () => reject(new Error("tunnel connection failed")));
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    const frame = parseFrame(String(event.data));
    if (!frame || frame.type !== "request") return;
    void forward(frame);
  });

  async function forward(frame: RequestFrame): Promise<void> {
    try {
      const response = await fetch(new URL(frame.path, options.targetBaseUrl), {
        method: frame.method,
        headers: frame.headers,
        body: frame.body ? Buffer.from(frame.body, "base64") : undefined,
      });

      socket.send(
        JSON.stringify({
          type: "response-start",
          requestId: frame.requestId,
          status: response.status,
          headers: sanitizeHeaders(Object.fromEntries(response.headers.entries())),
        }),
      );

      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          socket.send(
            JSON.stringify({
              type: "response-chunk",
              requestId: frame.requestId,
              data: Buffer.from(value).toString("base64"),
            }),
          );
        }
      }

      socket.send(JSON.stringify({ type: "response-end", requestId: frame.requestId }));
    } catch (err) {
      socket.send(
        JSON.stringify({
          type: "response-error",
          requestId: frame.requestId,
          message: err instanceof Error ? err.message : "unknown error forwarding to local target",
        }),
      );
    }
  }

  return {
    close: () => socket.close(),
  };
}
