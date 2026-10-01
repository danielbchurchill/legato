import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import {
  RELAY_AUTH_CALLBACK_BASE_URL,
  RELAY_GITHUB_CLIENT_ID,
  RELAY_GITHUB_CLIENT_SECRET,
  RELAY_GOOGLE_CLIENT_ID,
  RELAY_GOOGLE_CLIENT_SECRET,
} from "../config.js";
import {
  createSession,
  deleteSession,
  generateState,
  getUserBySessionToken,
  isValidState,
  SESSION_COOKIE,
  upsertUser,
  type OAuthProfile,
  type Provider,
} from "../accounts.js";

// Relay-side OAuth account provisioning. This mirrors server/'s pattern
// (server/src/routes/auth.ts) deliberately: hand-rolled Authorization
// Code flow via plain fetch (no passport, no OAuth library), a real
// revocable sessions table rather than a JWT, a state cookie for CSRF,
// and graceful absence — an unconfigured provider's two routes 503,
// nothing else in this service is gated by whether a relay account is
// signed in. What's different from server/ is *why* this exists: these
// accounts answer "which relay account owns which home server's tunnel,"
// a real multi-tenant mapping — see accounts.ts and migrations/
// 0001_relay_users.sql.

const USER_AGENT = "Legato-Relay/0.1 (+https://github.com/danielbchurchill/legato)";

export function isGoogleConfigured(): boolean {
  return Boolean(RELAY_GOOGLE_CLIENT_ID && RELAY_GOOGLE_CLIENT_SECRET && RELAY_AUTH_CALLBACK_BASE_URL);
}

export function isGithubConfigured(): boolean {
  return Boolean(RELAY_GITHUB_CLIENT_ID && RELAY_GITHUB_CLIENT_SECRET && RELAY_AUTH_CALLBACK_BASE_URL);
}

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

function callbackUrl(provider: Provider): string {
  return `${RELAY_AUTH_CALLBACK_BASE_URL}/auth/${provider}/callback`;
}

async function exchangeGoogleCode(code: string): Promise<OAuthProfile> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: RELAY_GOOGLE_CLIENT_ID!,
      client_secret: RELAY_GOOGLE_CLIENT_SECRET!,
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
      client_id: RELAY_GITHUB_CLIENT_ID!,
      client_secret: RELAY_GITHUB_CLIENT_SECRET!,
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

const STATE_COOKIE = "relay_oauth_state";

// Every cookie this relay sets or clears shares these attributes. Secure
// is on whenever the relay is served over https, as it is in production
// (https://auth.legato.fm). Without it a browser still attaches the
// session cookie to a plain-http request; Fly's http->https redirect only
// answers after that request is already on the wire, so anyone on the
// same network (cafe wifi, hotel LAN) could copy a signed-in session.
// Loopback development (http://127.0.0.1:8901) stays non-Secure, because
// a browser refuses to store a Secure cookie over http.
//
// Clears pass the same attributes: a browser only replaces a cookie when
// the clearing Set-Cookie matches it, so a non-Secure clear could leave a
// Secure session cookie in place after logout.
export function cookieAttributes(callbackBaseUrl: string | undefined) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: Boolean(callbackBaseUrl?.startsWith("https://")),
  };
}

const COOKIE = cookieAttributes(RELAY_AUTH_CALLBACK_BASE_URL);

function notConfiguredMessage(provider: Provider): string {
  const vars =
    provider === "google"
      ? "RELAY_GOOGLE_CLIENT_ID/RELAY_GOOGLE_CLIENT_SECRET"
      : "RELAY_GITHUB_CLIENT_ID/RELAY_GITHUB_CLIENT_SECRET";
  return `${provider} OAuth isn't configured on this relay — set ${vars} and RELAY_AUTH_CALLBACK_BASE_URL in relay/.env.local.`;
}

function escapeHtml(s: string): string {
  const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => escapes[c]!);
}

// A bare confirmation page: the relay has no frontend of its own, so the
// sign-in button that got here (in whatever client — desktop app, phone)
// opens this flow in a new window/tab and re-checks GET /auth/me itself.
function successPage(displayName: string | null): string {
  const name = displayName ? escapeHtml(displayName) : "your account";
  return `<!doctype html>
<html>
  <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#14181A;color:#c9c9c9;font-family:system-ui,sans-serif;font-size:14px;">
    <p>Signed in as ${name}. You can close this window.</p>
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
      reply.setCookie(STATE_COOKIE, state, { ...COOKIE, maxAge: 600 });
      const url = `${GOOGLE_AUTHORIZE_URL}?${new URLSearchParams({
        client_id: RELAY_GOOGLE_CLIENT_ID!,
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
      reply.clearCookie(STATE_COOKIE, COOKIE);
      if (!request.query.code || !isValidState(cookieState, request.query.state)) {
        reply.code(400);
        return { error: "invalid or missing OAuth state" };
      }

      const profile = await exchangeGoogleCode(request.query.code);
      const user = upsertUser(db, "google", profile);
      const { token, expiresAt } = createSession(db, user.id);
      reply.setCookie(SESSION_COOKIE, token, { ...COOKIE, expires: expiresAt });
      reply.type("text/html");
      return successPage(user.display_name);
    });

    app.get("/auth/github", async (_request, reply) => {
      if (!isGithubConfigured()) {
        reply.code(503);
        return { error: notConfiguredMessage("github") };
      }
      const state = generateState();
      reply.setCookie(STATE_COOKIE, state, { ...COOKIE, maxAge: 600 });
      const url = `${GITHUB_AUTHORIZE_URL}?${new URLSearchParams({
        client_id: RELAY_GITHUB_CLIENT_ID!,
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
      reply.clearCookie(STATE_COOKIE, COOKIE);
      if (!request.query.code || !isValidState(cookieState, request.query.state)) {
        reply.code(400);
        return { error: "invalid or missing OAuth state" };
      }

      const profile = await exchangeGithubCode(request.query.code);
      const user = upsertUser(db, "github", profile);
      const { token, expiresAt } = createSession(db, user.id);
      reply.setCookie(SESSION_COOKIE, token, { ...COOKIE, expires: expiresAt });
      reply.type("text/html");
      return successPage(user.display_name);
    });

    app.post("/auth/logout", async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) deleteSession(db, token);
      reply.clearCookie(SESSION_COOKIE, COOKIE);
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
