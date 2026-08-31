import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

const SECRET = "top-secret-value";

async function listenWs(app: FastifyInstance): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address.replace(/^http/, "ws");
}

describe("tunnel auth handshake", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("rejects a tunnel connection with a missing secret", async () => {
    app = buildApp({ sharedSecret: SECRET });
    const wsUrl = await listenWs(app);
    const socket = new WebSocket(`${wsUrl}/tunnel`);

    const result = await new Promise<{ code: number; authError?: string }>((resolve) => {
      let authError: string | undefined;
      socket.addEventListener("open", () => {
        // No auth frame at all — the very first message it sends is
        // already the wrong shape, which the handshake must still reject.
        socket.send(JSON.stringify({ type: "request", requestId: "x", method: "GET", path: "/", headers: {} }));
      });
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "auth-error") authError = frame.message;
      });
      socket.addEventListener("close", (event) => resolve({ code: event.code, authError }));
    });

    expect(result.code).toBe(4001);
    expect(result.authError).toBeTruthy();
  });

  it("rejects a tunnel connection with the wrong secret", async () => {
    app = buildApp({ sharedSecret: SECRET });
    const wsUrl = await listenWs(app);
    const socket = new WebSocket(`${wsUrl}/tunnel`);

    const result = await new Promise<{ code: number; authError?: string }>((resolve) => {
      let authError: string | undefined;
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "auth", secret: "definitely-not-it" }));
      });
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "auth-error") authError = frame.message;
      });
      socket.addEventListener("close", (event) => resolve({ code: event.code, authError }));
    });

    expect(result.code).toBe(4001);
    expect(result.authError).toBeTruthy();
  });

  it("accepts a tunnel connection with the correct secret", async () => {
    app = buildApp({ sharedSecret: SECRET });
    const wsUrl = await listenWs(app);
    const socket = new WebSocket(`${wsUrl}/tunnel`);

    const authOk = await new Promise<boolean>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "auth", secret: SECRET }));
      });
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "auth-ok") resolve(true);
        if (frame.type === "auth-error") reject(new Error(frame.message));
      });
      socket.addEventListener("close", (event) => reject(new Error(`closed before auth-ok, code ${event.code}`)));
    });

    expect(authOk).toBe(true);
    socket.close();
  });
});
