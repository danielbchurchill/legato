import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import {
  createSession,
  deleteSession,
  generateState,
  getUserBySessionToken,
  isValidState,
  upsertUser,
  type OAuthProfile,
} from "./auth.js";

// Covers what doesn't require a live network round trip against Google/
// GitHub — the actual code exchange (exchangeGoogleCode/exchangeGithubCode)
// is exercised only against real provider APIs, so it stays untested here
// the same way enrich/mbClient.ts's live MusicBrainz calls aren't unit
// tested either. The routes themselves are thin pass-through over these
// functions (favourites.ts is the same shape), so testing the functions
// directly covers the logic that actually matters.

let db: Database.Database;

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

    const count = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
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
    db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))").run(
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

    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);

    expect(getUserBySessionToken(db, token)).toBeNull();
  });
});

// The behavior GET /auth/me relies on when signed out: no cookie means no
// lookup is even attempted, and the route falls back to `user: null`
// exactly the way this helper does for any token it can't resolve.
describe("signed-out lookup (what GET /auth/me falls back to)", () => {
  it("resolves to no user when there is no session token at all", () => {
    expect(getUserBySessionToken(db, "")).toBeNull();
  });
});
