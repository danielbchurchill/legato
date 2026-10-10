import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import {
  createSession,
  deleteSession,
  generateState,
  getUserById,
  getUserBySessionToken,
  isValidState,
  upsertUser,
  describeClient,
  type OAuthProfile,
} from "./accounts.js";
import { openDb } from "./db.js";

// Covers what doesn't require a live network round trip against Google/
// GitHub — the actual code exchange (exchangeGoogleCode/exchangeGithubCode
// in routes/auth.ts) is exercised only against real provider APIs, so it
// stays untested here the same way server/'s auth.spec.ts leaves its own
// equivalents untested. The routes themselves are thin pass-through over
// these functions, so testing the functions directly covers the logic
// that actually matters.

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

const googleProfile: OAuthProfile = {
  providerUserId: "google-123",
  email: "dylan@example.com",
  displayName: "Bob Dylan",
  avatarUrl: "https://example.com/bob.jpg",
};

describe("isValidState", () => {
  it("accepts a query state that matches the cookie state", () => {
    const state = generateState();
    expect(isValidState(state, state)).toBe(true);
  });

  it("rejects a mismatched state", () => {
    expect(isValidState(generateState(), generateState())).toBe(false);
  });

  it("rejects when either side is missing", () => {
    const state = generateState();
    expect(isValidState(undefined, state)).toBe(false);
    expect(isValidState(state, undefined)).toBe(false);
    expect(isValidState(undefined, undefined)).toBe(false);
  });
});

describe("generateState", () => {
  it("produces a different value on every call", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("upsertUser", () => {
  it("creates a new user on first sign-in", () => {
    const user = upsertUser(db, "google", googleProfile);

    expect(user.provider).toBe("google");
    expect(user.provider_user_id).toBe("google-123");
    expect(user.email).toBe("dylan@example.com");
    expect(user.display_name).toBe("Bob Dylan");
    expect(user.avatar_url).toBe("https://example.com/bob.jpg");
  });

  it("returning sign-in updates the existing row instead of inserting a second one", () => {
    const first = upsertUser(db, "google", googleProfile);

    const second = upsertUser(db, "google", {
      ...googleProfile,
      displayName: "Robert Zimmerman",
      avatarUrl: "https://example.com/robert.jpg",
    });

    expect(second.id).toBe(first.id);
    expect(second.display_name).toBe("Robert Zimmerman");
    expect(second.avatar_url).toBe("https://example.com/robert.jpg");

    const count = db.prepare("SELECT COUNT(*) AS count FROM relay_users").get() as { count: number };
    expect(count.count).toBe(1);
  });

  it("keeps google and github accounts separate even with the same provider_user_id", () => {
    const googleUser = upsertUser(db, "google", { ...googleProfile, providerUserId: "shared-id" });
    const githubUser = upsertUser(db, "github", { ...googleProfile, providerUserId: "shared-id" });

    expect(googleUser.id).not.toBe(githubUser.id);
  });

  it("stores a null email when the provider doesn't supply one", () => {
    const user = upsertUser(db, "github", { ...googleProfile, email: null });
    expect(user.email).toBeNull();
  });
});

describe("getUserById", () => {
  it("finds an account by its id, and answers null for one that's gone", () => {
    const user = upsertUser(db, "google", googleProfile);
    expect(getUserById(db, user.id)).toEqual(user);
    db.prepare("DELETE FROM relay_users WHERE id = ?").run(user.id);
    expect(getUserById(db, user.id)).toBeNull();
  });
});

describe("sessions", () => {
  it("creates a session that resolves back to its user", () => {
    const user = upsertUser(db, "google", googleProfile);
    const { token, expiresAt } = createSession(db, user.id);

    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const resolved = getUserBySessionToken(db, token);
    expect(resolved?.id).toBe(user.id);
  });

  it("returns null for a token that was never issued", () => {
    expect(getUserBySessionToken(db, "not-a-real-token")).toBeNull();
  });

  it("returns null for an expired session", () => {
    const user = upsertUser(db, "google", googleProfile);
    const token = "expired-token";
    db.prepare("INSERT INTO relay_sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))").run(
      token,
      user.id,
    );

    expect(getUserBySessionToken(db, token)).toBeNull();
  });

  it("logging out deletes the session so the token no longer resolves", () => {
    const user = upsertUser(db, "google", googleProfile);
    const { token } = createSession(db, user.id);

    deleteSession(db, token);

    expect(getUserBySessionToken(db, token)).toBeNull();
  });

  it("deleting a user cascades to their sessions", () => {
    const user = upsertUser(db, "google", googleProfile);
    const { token } = createSession(db, user.id);

    db.prepare("DELETE FROM relay_users WHERE id = ?").run(user.id);

    expect(getUserBySessionToken(db, token)).toBeNull();
  });
});

// Issue #115: the label an account's settings show for each session.
describe("describeClient", () => {
  it("names the app or the browser, and the system, from the User-Agent", () => {
    const cases: [string | undefined, "app" | "browser", string][] = [
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", "app", "Legato app on macOS"],
      ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", "app", "Legato app on Linux"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", "app", "Legato app on Windows"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", "browser", "Edge on Windows"],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "browser", "Firefox on Linux"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "browser", "Safari on iOS"],
      ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", "browser", "Chrome on Android"],
      ["curl/8.7.1", "browser", "A browser"],
      [undefined, "app", "Legato app"],
    ];
    for (const [ua, kind, label] of cases) expect(describeClient(ua, kind)).toBe(label);
  });
});

