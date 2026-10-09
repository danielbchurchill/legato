import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import type { FastifyInstance } from "fastify";
import { upsertUser } from "./accounts.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { mintTunnelCredential } from "./pairing.js";

async function listenWs(app: FastifyInstance): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address.replace(/^http/, "ws");
}

async function authAttempt(wsUrl: string, secret: string | undefined): Promise<{ code: number; authError?: string }> {
  const socket = new WebSocket(`${wsUrl}/tunnel`);
  return new Promise((resolve) => {
    let authError: string | undefined;
    socket.addEventListener("open", () => {
      if (secret === undefined) {
        // No auth frame at all — the very first message it sends is
        // already the wrong shape, which the handshake must still reject.
        socket.send(JSON.stringify({ type: "request", requestId: "x", method: "GET", path: "/", headers: {} }));
      } else {
        socket.send(JSON.stringify({ type: "auth", secret }));
      }
    });
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "auth-error") authError = frame.message;
    });
    socket.addEventListener("close", (event) => resolve({ code: event.code, authError }));
  });
}

describe("tunnel auth handshake", () => {
  let db: Database;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("rejects a tunnel connection with a missing secret", async () => {
    app = buildApp({ db });
    const wsUrl = await listenWs(app);

    const result = await authAttempt(wsUrl, undefined);

    expect(result.code).toBe(4001);
    expect(result.authError).toBeTruthy();
  });

  it("rejects a tunnel connection with an unknown credential", async () => {
    app = buildApp({ db });
    const wsUrl = await listenWs(app);

    const result = await authAttempt(wsUrl, "definitely-not-a-real-credential");

    expect(result.code).toBe(4001);
    expect(result.authError).toBeTruthy();
  });

  it("rejects a tunnel connection with an expired credential", async () => {
    const user = upsertUser(db, "google", {
      providerUserId: "expired-user",
      email: null,
      displayName: null,
      avatarUrl: null,
    });
    db.prepare(
      "INSERT INTO tunnel_credentials (token, relay_user_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))",
    ).run("expired-token", user.id);

    app = buildApp({ db });
    const wsUrl = await listenWs(app);

    const result = await authAttempt(wsUrl, "expired-token");

    expect(result.code).toBe(4001);
    expect(result.authError).toBeTruthy();
  });

  it("accepts a tunnel connection with a real minted credential", async () => {
    const user = upsertUser(db, "google", {
      providerUserId: "real-user",
      email: null,
      displayName: null,
      avatarUrl: null,
    });
    const { token } = mintTunnelCredential(db, user.id, "a".repeat(32));

    app = buildApp({ db });
    const wsUrl = await listenWs(app);
    const socket = new WebSocket(`${wsUrl}/tunnel`);

    const authOk = await new Promise<boolean>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "auth", secret: token }));
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

  // Issue #310: a tunnel is registered under the server its credential was
  // minted for, and one minted before migration 0006 names none.
  it("rejects a credential that isn't bound to a server", async () => {
    const user = upsertUser(db, "google", { providerUserId: "unbound", email: null, displayName: null, avatarUrl: null });
    const { token } = mintTunnelCredential(db, user.id);

    app = buildApp({ db });
    const wsUrl = await listenWs(app);

    const result = await authAttempt(wsUrl, token);

    expect(result.code).toBe(4001);
    expect(result.authError).toContain("isn't bound to a server");
  });

  it("lets two different accounts each authenticate their own tunnel at once", async () => {
    const userA = upsertUser(db, "google", { providerUserId: "a", email: null, displayName: null, avatarUrl: null });
    const userB = upsertUser(db, "google", { providerUserId: "b", email: null, displayName: null, avatarUrl: null });
    const credentialA = mintTunnelCredential(db, userA.id, "a".repeat(32)).token;
    const credentialB = mintTunnelCredential(db, userB.id, "b".repeat(32)).token;

    app = buildApp({ db });
    const wsUrl = await listenWs(app);

    const [resultA, resultB] = await Promise.all([
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${wsUrl}/tunnel`);
        socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credentialA })));
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "auth-ok") resolve("ok");
          if (frame.type === "auth-error") reject(new Error(frame.message));
        });
      }),
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${wsUrl}/tunnel`);
        socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credentialB })));
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "auth-ok") resolve("ok");
          if (frame.type === "auth-error") reject(new Error(frame.message));
        });
      }),
    ]);

    expect(resultA).toBe("ok");
    expect(resultB).toBe("ok");
  });
});
