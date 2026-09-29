import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { createSession, userForSessionToken } from "../auth/sessions.js";
import { setupCode } from "../auth/setupCode.js";
import { buildTestApp, createOwnerForTest, LOCAL_PAGE } from "../auth/test-app.js";
import { generateState, isValidState, signInKnownOAuthUser, type OAuthProfile } from "./auth.js";

// The live code exchange against Google/GitHub (exchangeGoogleCode /
// exchangeGithubCode) is only exercised against the real providers, the
// same way enrich/mbClient.ts's MusicBrainz calls aren't unit tested. What
// happens with the profile it returns is covered here.

let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(":memory:");
  ({ app } = await buildTestApp(db));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// The Mac desktop app talking to the Pi over Tailscale: not loopback, and
// its page is on another host.
const REMOTE_CLIENT = { remoteAddress: "100.64.0.7", headers: { host: "100.100.20.30:8899", origin: "tauri://localhost" } };

function createOwner(payload: Record<string, unknown>, from: { remoteAddress?: string; headers?: Record<string, string> } = { headers: LOCAL_PAGE }) {
  return app.inject({ method: "POST", url: "/api/v1/auth/owner", payload, ...from });
}

function signIn(password: string, remoteAddress = "127.0.0.1") {
  return app.inject({ method: "POST", url: "/api/v1/auth/sign-in", payload: { password }, remoteAddress });
}

describe("first-run owner creation", () => {
  it("creates the owner once and signs them straight in", async () => {
    const res = await createOwner({ password: "correct horse battery", displayName: "Daniel" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.role).toBe("owner");
    expect(body.user.displayName).toBe("Daniel");

    const stats = await app.inject({
      method: "GET",
      url: "/api/v1/stats",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(stats.statusCode).toBe(200);
  });

  it("refuses a second owner, even with the right conditions", async () => {
    await createOwnerForTest(app);
    const res = await createOwner({ password: "another password" });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("owner_exists");
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner'").get() as { count: number };
    expect(count).toBe(1);
  });

  it("produces exactly one owner when two first-run requests race", async () => {
    const results = await Promise.all([
      createOwner({ password: "first password" }),
      createOwner({ password: "second password" }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner'").get() as { count: number };
    expect(count).toBe(1);
  });

  it("stores an argon2id hash, never the password", async () => {
    await createOwnerForTest(app, "correct horse battery");
    const { password_hash } = db.prepare("SELECT password_hash FROM users WHERE role = 'owner'").get() as {
      password_hash: string;
    };
    expect(password_hash.startsWith("$argon2id$")).toBe(true);
    expect(password_hash).not.toContain("correct horse battery");
  });

  it("rejects a password that's too short", async () => {
    const res = await createOwner({ password: "short" });
    expect(res.statusCode).toBe(400);
  });

  it("asks a remote client for the setup code", async () => {
    const status = await app.inject({ method: "GET", url: "/api/v1/auth/status", ...REMOTE_CLIENT });
    expect(status.json().setupCodeRequired).toBe(true);

    const without = await createOwner({ password: "correct horse battery" }, REMOTE_CLIENT);
    expect(without.statusCode).toBe(403);
    expect(without.json().error).toContain("journalctl --user-unit legato-server");

    const withCode = await createOwner(
      { password: "correct horse battery", setupCode: setupCode().toLowerCase() },
      REMOTE_CLIENT,
    );
    expect(withCode.statusCode).toBe(201);
  });

  it("doesn't ask the desktop app's own page on loopback", async () => {
    for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:5173", "http://localhost:5173"]) {
      const status = await app.inject({
        method: "GET",
        url: "/api/v1/auth/status",
        headers: { host: "127.0.0.1:8899", origin },
      });
      expect(status.json().setupCodeRequired).toBe(false);
    }
  });

  it("asks a website open in a browser on the same machine", async () => {
    const res = await createOwner(
      { password: "correct horse battery" },
      { headers: { host: "127.0.0.1:8899", origin: "https://evil.example" } },
    );
    expect(res.statusCode).toBe(403);
  });

  it("asks a DNS-rebinding page whose hostname resolved to 127.0.0.1", async () => {
    const res = await createOwner(
      { password: "correct horse battery" },
      { headers: { host: "rebind.evil.example:8899", origin: "http://rebind.evil.example:8899" } },
    );
    expect(res.statusCode).toBe(403);
  });

  it("rate-limits setup-code guesses", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await createOwner({ password: "correct horse battery", setupCode: "AAAA-AAAA" }, REMOTE_CLIENT);
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses[6]).toBe(429);
  });
});

describe("owner sign-in", () => {
  beforeEach(async () => {
    await createOwnerForTest(app, "correct horse battery");
  });

  it("signs in with the right password", async () => {
    const res = await signIn("correct horse battery");
    expect(res.statusCode).toBe(200);
    expect(userForSessionToken(db, res.json().token)?.role).toBe("owner");
  });

  it("rejects the wrong password", async () => {
    const res = await signIn("incorrect horse");
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe("bad_password");
  });

  it("locks an address out after five failures, with Retry-After", async () => {
    for (let i = 0; i < 5; i++) await signIn("wrong password", "192.168.1.50");
    const locked = await signIn("correct horse battery", "192.168.1.50");
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);

    // Someone else on the network isn't punished for it.
    expect((await signIn("correct horse battery", "192.168.1.51")).statusCode).toBe(200);
  });

  it("says to create the owner when there isn't one", async () => {
    const fresh = await buildTestApp(openDb(":memory:"));
    await fresh.app.ready();
    const res = await fresh.app.inject({ method: "POST", url: "/api/v1/auth/sign-in", payload: { password: "anything at all" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("owner_required");
    await fresh.app.close();
  });
});

// Google/GitHub users from before migration 0029 keep working until the
// identity migration (#114).
describe("existing OAuth users", () => {
  const profile: OAuthProfile = {
    providerUserId: "google-123",
    email: "dylan@example.com",
    displayName: "Bob Dylan",
    avatarUrl: "https://example.com/bob.jpg",
  };

  function insertLegacyUser(provider: "google" | "github", providerUserId: string): number {
    db.prepare("INSERT INTO users (provider, provider_user_id, role) VALUES (?, ?, 'legacy')").run(provider, providerUserId);
    return (db.prepare("SELECT id FROM users WHERE provider_user_id = ?").get(providerUserId) as { id: number }).id;
  }

  it("still sign in, and their profile refreshes", () => {
    const id = insertLegacyUser("google", "google-123");
    const user = signInKnownOAuthUser(db, "google", profile);
    expect(user?.id).toBe(id);
    expect(user?.display_name).toBe("Bob Dylan");
  });

  it("get full access through the gate once signed in", async () => {
    const id = insertLegacyUser("github", "gh-9");
    const { token } = createSession(db, id);
    const res = await app.inject({ method: "GET", url: "/api/v1/stats", headers: { cookie: `legato_session=${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it("can create the owner without the setup code", async () => {
    const id = insertLegacyUser("google", "google-123");
    const { token } = createSession(db, id);
    const res = await createOwner(
      { password: "correct horse battery" },
      { ...REMOTE_CLIENT, headers: { ...REMOTE_CLIENT.headers, authorization: `Bearer ${token}` } },
    );
    expect(res.statusCode).toBe(201);
  });

  it("an account the server has never seen is not created and not signed in", () => {
    expect(signInKnownOAuthUser(db, "google", { ...profile, providerUserId: "stranger" })).toBeNull();
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    expect(count).toBe(0);
  });

  it("keeps google and github accounts with the same id apart", () => {
    insertLegacyUser("google", "shared-id");
    expect(signInKnownOAuthUser(db, "github", { ...profile, providerUserId: "shared-id" })).toBeNull();
  });
});

describe("OAuth state", () => {
  it("accepts a query state that matches the cookie state", () => {
    const state = generateState();
    expect(isValidState(state, state)).toBe(true);
  });

  it("rejects a mismatched or missing state", () => {
    const state = generateState();
    expect(isValidState(generateState(), state)).toBe(false);
    expect(isValidState(undefined, state)).toBe(false);
    expect(isValidState(state, undefined)).toBe(false);
  });
});
