import { randomBytes } from "node:crypto";
import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  AUTH_CALLBACK_BASE_URL,
} from "../config.js";
import { USER_AGENT } from "../enrich/mbClient.js";

// Rough OAuth account provisioning — see migration 0021_users.sql for the
// schema and CLAUDE.md's "Secrets: none yet" for why this is the first
// feature in the repo that needs one. This is provisioning plumbing, not
// an access-control system: nothing else in the server checks for a
// signed-in user, and nothing here should ever gate an existing route.
//
// State is a plain (unsigned) httpOnly cookie compared against the
// provider's callback `state` query param. That's enough CSRF protection
// for what this is — an attacker can't read or set a cookie on this
// origin from another one — without needing a signing secret, which would
// be one more required env var for a feature explicitly scoped as rough.

export type Provider = "google" | "github";

export function isGoogleConfigured(): boolean {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && AUTH_CALLBACK_BASE_URL);
}

export function isGithubConfigured(): boolean {
  return Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && AUTH_CALLBACK_BASE_URL);
}

// --- user / session storage (exported for auth.spec.ts) ---

export type UserRow = {
  id: number;
  provider: Provider;
  provider_user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_login_at: string;
};

export type OAuthProfile = {
  providerUserId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

// One row per (provider, providerUserId) forever — the second sign-in from
// the same account refreshes the profile fields and last_login_at rather
// than inserting a new row, so a session created before this call keeps
// pointing at a valid user.id.
export function upsertUser(db: Database, provider: Provider, profile: OAuthProfile): UserRow {
  db.prepare(
    `INSERT INTO users (provider, provider_user_id, email, display_name, avatar_url)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_user_id) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       last_login_at = datetime('now')`,
  ).run(provider, profile.providerUserId, profile.email, profile.displayName, profile.avatarUrl);

  return db
    .prepare("SELECT * FROM users WHERE provider = ? AND provider_user_id = ?")
    .get(provider, profile.providerUserId) as UserRow;
}

// 30 days: long enough a rough single-user setup doesn't nag to re-auth
// every session, short enough a token nobody explicitly revoked doesn't
// live forever.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(db: Database, userId: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expiresAt.toISOString(),
  );
  return { token, expiresAt };
}

export function getUserBySessionToken(db: Database, token: string): UserRow | null {
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .get(token) as UserRow | undefined;
  return row ?? null;
}

export function deleteSession(db: Database, token: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(token);
}

// --- CSRF state ---

export function generateState(): string {
  return randomBytes(16).toString("hex");
}

// Split out from the callback route so the check itself is unit-testable
// without a live OAuth round trip.
export function isValidState(cookieState: string | undefined, queryState: string | undefined): boolean {
  return Boolean(cookieState) && cookieState === queryState;
}

// --- provider glue ---

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

function callbackUrl(provider: Provider): string {
  return `${AUTH_CALLBACK_BASE_URL}/api/v1/auth/${provider}/callback`;
}

async function exchangeGoogleCode(code: string): Promise<OAuthProfile> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      redirect_uri: callbackUrl("google"),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${access_token}`, "User-Agent": USER_AGENT },
  });
  if (!userRes.ok) {
    throw new Error(`Google userinfo fetch failed: ${userRes.status} ${await userRes.text()}`);
  }
  const profile = (await userRes.json()) as { sub: string; email?: string; name?: string; picture?: string };

  return {
    providerUserId: profile.sub,
    email: profile.email ?? null,
    displayName: profile.name ?? null,
    avatarUrl: profile.picture ?? null,
  };
}

async function exchangeGithubCode(code: string): Promise<OAuthProfile> {
  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: GITHUB_CLIENT_ID!,
      client_secret: GITHUB_CLIENT_SECRET!,
      redirect_uri: callbackUrl("github"),
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`GitHub token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const headers = {
    Authorization: `Bearer ${access_token}`,
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };
  const userRes = await fetch(GITHUB_USER_URL, { headers });
  if (!userRes.ok) {
    throw new Error(`GitHub user fetch failed: ${userRes.status} ${await userRes.text()}`);
  }
  const profile = (await userRes.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
    email: string | null;
  };

  // /user only carries `email` when the account has made one public.
  // /user/emails (needs the user:email scope requested below) is the
  // reliable source — take the primary verified address, falling back to
  // any verified one, and leave it null rather than guess.
  let email = profile.email;
  if (!email) {
    const emailsRes = await fetch(GITHUB_EMAILS_URL, { headers });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
    }
  }

  return {
    providerUserId: String(profile.id),
    email,
    displayName: profile.name ?? profile.login,
    avatarUrl: profile.avatar_url,
  };
}

// --- routes ---

const STATE_COOKIE = "legato_oauth_state";
const SESSION_COOKIE = "legato_session";

function notConfiguredMessage(provider: Provider): string {
  const vars = provider === "google" ? "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET" : "GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET";
  return `${provider} OAuth isn't configured on this server — set ${vars} and AUTH_CALLBACK_BASE_URL in server/.env.local.`;
}

function escapeHtml(s: string): string {
  const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => escapes[c]!);
}

// A bare confirmation page, not a redirect back into the app: the frontend
// has no fixed origin this server can assume (Vite dev port, a Tauri
// bundle, a future remote client), so the sign-in button opens this flow
// in a new window and the Account section itself re-checks GET /auth/me on
// window focus. #14181A matches the Tauri window's own background
// (tauri.conf.json) so the flash between pages doesn't look like a crash.
function successPage(displayName: string | null): string {
  const name = displayName ? escapeHtml(displayName) : "your account";
  return `<!doctype html>
<html>
  <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#14181A;color:#c9c9c9;font-family:system-ui,sans-serif;font-size:14px;">
    <p>Signed in as ${name}. You can close this window and go back to Legato.</p>
  </body>
</html>`;
}

export function authRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/auth/google", async (_request, reply) => {
      if (!isGoogleConfigured()) {
        reply.code(503);
        return { error: notConfiguredMessage("google") };
      }
      const state = generateState();
      reply.setCookie(STATE_COOKIE, state, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 600 });
      const url = `${GOOGLE_AUTHORIZE_URL}?${new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID!,
        redirect_uri: callbackUrl("google"),
        response_type: "code",
        scope: "openid email profile",
        state,
      })}`;
      return reply.redirect(url);
    });

    app.get<{ Querystring: { code?: string; state?: string } }>("/auth/google/callback", async (request, reply) => {
      if (!isGoogleConfigured()) {
        reply.code(503);
        return { error: notConfiguredMessage("google") };
      }
      const cookieState = request.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: "/" });
      if (!request.query.code || !isValidState(cookieState, request.query.state)) {
        reply.code(400);
        return { error: "invalid or missing OAuth state" };
      }

      const profile = await exchangeGoogleCode(request.query.code);
      const user = upsertUser(db, "google", profile);
      const { token, expiresAt } = createSession(db, user.id);
      reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", expires: expiresAt });
      reply.type("text/html");
      return successPage(user.display_name);
    });

    app.get("/auth/github", async (_request, reply) => {
      if (!isGithubConfigured()) {
        reply.code(503);
        return { error: notConfiguredMessage("github") };
      }
      const state = generateState();
      reply.setCookie(STATE_COOKIE, state, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 600 });
      const url = `${GITHUB_AUTHORIZE_URL}?${new URLSearchParams({
        client_id: GITHUB_CLIENT_ID!,
        redirect_uri: callbackUrl("github"),
        scope: "read:user user:email",
        state,
      })}`;
      return reply.redirect(url);
    });

    app.get<{ Querystring: { code?: string; state?: string } }>("/auth/github/callback", async (request, reply) => {
      if (!isGithubConfigured()) {
        reply.code(503);
        return { error: notConfiguredMessage("github") };
      }
      const cookieState = request.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: "/" });
      if (!request.query.code || !isValidState(cookieState, request.query.state)) {
        reply.code(400);
        return { error: "invalid or missing OAuth state" };
      }

      const profile = await exchangeGithubCode(request.query.code);
      const user = upsertUser(db, "github", profile);
      const { token, expiresAt } = createSession(db, user.id);
      reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", expires: expiresAt });
      reply.type("text/html");
      return successPage(user.display_name);
    });

    app.post("/auth/logout", async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) deleteSession(db, token);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    });

    app.get("/auth/me", async (request) => {
      const token = request.cookies[SESSION_COOKIE];
      const user = token ? getUserBySessionToken(db, token) : null;
      return {
        user: user
          ? {
              id: user.id,
              provider: user.provider,
              email: user.email,
              displayName: user.display_name,
              avatarUrl: user.avatar_url,
            }
          : null,
        configured: { google: isGoogleConfigured(), github: isGithubConfigured() },
      };
    });
  };
}
