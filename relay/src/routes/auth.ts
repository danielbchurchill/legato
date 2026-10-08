import type { Database } from "../sqlite.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  RELAY_AUTH_CALLBACK_BASE_URL,
  RELAY_GITHUB_CLIENT_ID,
  RELAY_GITHUB_CLIENT_SECRET,
  RELAY_GOOGLE_CLIENT_ID,
  RELAY_GOOGLE_CLIENT_SECRET,
  RELAY_SIGNING_KEYS,
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
  type RelayUserRow,
} from "../accounts.js";
import {
  createNativeRequest,
  mintAuthCode,
  parseNativeStart,
  redeemAuthCode,
  REDEEM_FAILURE_MESSAGES,
  takeNativeRequest,
  type NativeQuery,
} from "../native-sign-in.js";
import { clientAddress, TokenLimiter } from "../rate-limit.js";
import { parseSigningKeys, SERVER_ID_PATTERN, signServerToken, type SigningKeys } from "../signing-keys.js";

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
//
// Two ways through it (issue #215). A browser sign-in ends with the
// relay_session cookie, exactly as it always has. A native sign-in (the
// desktop app) starts with a PKCE challenge and a loopback redirect_uri,
// and ends with a one-time code sent to that loopback, which the app
// redeems at POST /auth/token for a bearer token. The provider's
// registered redirect URI is the relay's own callback either way; the
// loopback is the relay's second hop. See native-sign-in.ts.

const USER_AGENT = "Legato-Relay/0.1 (+https://github.com/danielbchurchill/legato)";

// Everything this file reads from the environment, gathered so tests and
// the end-to-end harness can run the real routes against a stubbed
// provider without touching process.env or global fetch.
export type AuthConfig = {
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  callbackBaseUrl?: string;
};

const ENV_CONFIG: AuthConfig = {
  googleClientId: RELAY_GOOGLE_CLIENT_ID,
  googleClientSecret: RELAY_GOOGLE_CLIENT_SECRET,
  githubClientId: RELAY_GITHUB_CLIENT_ID,
  githubClientSecret: RELAY_GITHUB_CLIENT_SECRET,
  callbackBaseUrl: RELAY_AUTH_CALLBACK_BASE_URL,
};

export function isGoogleConfigured(config: AuthConfig = ENV_CONFIG): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret && config.callbackBaseUrl);
}

export function isGithubConfigured(config: AuthConfig = ENV_CONFIG): boolean {
  return Boolean(config.githubClientId && config.githubClientSecret && config.callbackBaseUrl);
}

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

function callbackUrl(config: AuthConfig, provider: Provider): string {
  return `${config.callbackBaseUrl}/auth/${provider}/callback`;
}

async function exchangeGoogleCode(config: AuthConfig, code: string): Promise<OAuthProfile> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId!,
      client_secret: config.googleClientSecret!,
      redirect_uri: callbackUrl(config, "google"),
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
  const profile = (await userRes.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  return {
    providerUserId: profile.sub,
    email: profile.email ?? null,
    emailVerified: profile.email_verified === true,
    displayName: profile.name ?? null,
    avatarUrl: profile.picture ?? null,
  };
}

async function exchangeGithubCode(config: AuthConfig, code: string): Promise<OAuthProfile> {
  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: config.githubClientId!,
      client_secret: config.githubClientSecret!,
      redirect_uri: callbackUrl(config, "github"),
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

  // Verified either way: GitHub only lets a verified address be public,
  // and the /user/emails fallback above only takes verified ones.
  return {
    providerUserId: String(profile.id),
    email,
    emailVerified: email !== null,
    displayName: profile.name ?? profile.login,
    avatarUrl: profile.avatar_url,
  };
}

type ProviderFlow = {
  isConfigured(config: AuthConfig): boolean;
  authorizeUrl(config: AuthConfig, state: string): string;
  exchange(config: AuthConfig, code: string): Promise<OAuthProfile>;
};

const PROVIDERS: Record<Provider, ProviderFlow> = {
  google: {
    isConfigured: isGoogleConfigured,
    authorizeUrl: (config, state) =>
      `${GOOGLE_AUTHORIZE_URL}?${new URLSearchParams({
        client_id: config.googleClientId!,
        redirect_uri: callbackUrl(config, "google"),
        response_type: "code",
        scope: "openid email profile",
        state,
      })}`,
    exchange: exchangeGoogleCode,
  },
  github: {
    isConfigured: isGithubConfigured,
    authorizeUrl: (config, state) =>
      `${GITHUB_AUTHORIZE_URL}?${new URLSearchParams({
        client_id: config.githubClientId!,
        redirect_uri: callbackUrl(config, "github"),
        scope: "read:user user:email",
        state,
      })}`,
    exchange: exchangeGithubCode,
  },
};

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
  <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0f1214;color:#c9c9c9;font-family:system-ui,sans-serif;font-size:14px;">
    <p>Signed in as ${name}. You can close this window.</p>
  </body>
</html>`;
}

function publicUser(user: RelayUserRow) {
  return {
    id: user.id,
    provider: user.provider,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
  };
}

// A bearer token wins over the cookie: the desktop app only ever sends
// the header, and a browser only ever has the cookie, so in practice a
// request carries one or the other.
export function sessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim() || undefined;
  return request.cookies[SESSION_COOKIE];
}

// The endpoints a desktop webview calls directly. Its origin is
// tauri://localhost (Linux, macOS), http(s)://tauri.localhost (Windows),
// or a loopback Vite in development, all cross-origin to auth.legato.fm.
// No Access-Control-Allow-Credentials: these callers send a bearer token
// and nothing else, so a cookie never rides along cross-site.
const CORS_ROUTES = new Set(["/auth/token", "/auth/me", "/auth/logout", "/auth/server-token"]);
const LOOPBACK_DEV_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

export function isAllowedAppOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") {
    return true;
  }
  return LOOPBACK_DEV_ORIGIN.test(origin);
}

function applyCors(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("Vary", "Origin");
  const origin = request.headers.origin;
  if (!isAllowedAppOrigin(origin)) return;
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Access-Control-Allow-Methods", "GET, POST");
  reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  reply.header("Access-Control-Max-Age", "600");
}

export interface AuthRoutesOptions {
  config?: AuthConfig;
  // Swaps a provider's token exchange for a stub. Tests and the local
  // end-to-end harness (testing/native-sign-in-e2e.ts) use it; production
  // never passes it.
  exchange?: Partial<Record<Provider, (code: string) => Promise<OAuthProfile>>>;
  tokenLimiter?: TokenLimiter;
  // Token signing keys (issue #114). Undefined reads RELAY_SIGNING_KEYS;
  // null is "signing off", which is what tests of the unconfigured path pass.
  signingKeys?: SigningKeys | null;
}

const SIGNING_NOT_CONFIGURED =
  "legato.fm can't sign server tokens yet: RELAY_SIGNING_KEYS isn't set on this relay. " +
  "Generate one with `bun relay/scripts/generate-signing-key.ts` and set it as a secret.";

export function authRoutes(db: Database, options: AuthRoutesOptions = {}) {
  const config = options.config ?? ENV_CONFIG;
  const cookie = cookieAttributes(config.callbackBaseUrl);
  const limiter = options.tokenLimiter ?? new TokenLimiter();

  return async function routes(app: FastifyInstance) {
    let signingKeys: SigningKeys | null = null;
    if (options.signingKeys !== undefined) {
      signingKeys = options.signingKeys;
    } else {
      try {
        signingKeys = parseSigningKeys(RELAY_SIGNING_KEYS);
      } catch (err) {
        app.log.error(`${err instanceof Error ? err.message : String(err)} Server token signing is off until it's fixed.`);
      }
    }

    app.addHook("onRequest", async (request, reply) => {
      if (CORS_ROUTES.has(request.routeOptions.url ?? "")) applyCors(request, reply);
    });
    for (const url of CORS_ROUTES) {
      app.options(url, async (_request, reply) => reply.code(204).send());
    }

    for (const provider of ["google", "github"] as const) {
      const flow = PROVIDERS[provider];
      const exchange = options.exchange?.[provider] ?? ((code: string) => flow.exchange(config, code));

      app.get<{ Querystring: NativeQuery }>(`/auth/${provider}`, async (request, reply) => {
        if (!flow.isConfigured(config)) {
          reply.code(503);
          return { error: notConfiguredMessage(provider) };
        }
        const start = parseNativeStart(request.query);
        if (start.kind === "invalid") {
          reply.code(400);
          return { error: start.message };
        }
        const state = generateState();
        reply.setCookie(STATE_COOKIE, state, { ...cookie, maxAge: 600 });
        if (start.kind === "native") createNativeRequest(db, state, provider, start.params);
        return reply.redirect(flow.authorizeUrl(config, state));
      });

      app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
        `/auth/${provider}/callback`,
        async (request, reply) => {
          if (!flow.isConfigured(config)) {
            reply.code(503);
            return { error: notConfiguredMessage(provider) };
          }
          const cookieState = request.cookies[STATE_COOKIE];
          reply.clearCookie(STATE_COOKIE, cookie);
          const stateOk = isValidState(cookieState, request.query.state);
          const native = stateOk ? takeNativeRequest(db, request.query.state!, provider) : null;

          // The user said no at Google or GitHub. Tell the waiting app now,
          // rather than leaving it to time out on a listener nobody calls.
          if (native && request.query.error) {
            const error = request.query.error === "access_denied" ? "access_denied" : "provider_error";
            return reply.redirect(`${native.redirectUri}?error=${error}`);
          }
          if (!request.query.code || !stateOk) {
            reply.code(400);
            return { error: "invalid or missing OAuth state" };
          }

          if (native) {
            let profile: OAuthProfile;
            try {
              profile = await exchange(request.query.code);
            } catch (err) {
              request.log.error(err, `${provider} exchange failed during a native sign-in`);
              return reply.redirect(`${native.redirectUri}?error=provider_error`);
            }
            const user = upsertUser(db, provider, profile);
            // No relay_session cookie here: the browser didn't ask for a
            // session, the app did, and it gets one at /auth/token.
            const code = mintAuthCode(db, user.id, native);
            return reply.redirect(`${native.redirectUri}?code=${encodeURIComponent(code)}`);
          }

          const profile = await exchange(request.query.code);
          const user = upsertUser(db, provider, profile);
          const { token, expiresAt } = createSession(db, user.id);
          reply.setCookie(SESSION_COOKIE, token, { ...cookie, expires: expiresAt });
          reply.type("text/html");
          return successPage(user.display_name);
        },
      );
    }

    app.post<{ Body: { code?: unknown; code_verifier?: unknown; redirect_uri?: unknown } | null }>(
      "/auth/token",
      async (request, reply) => {
        const address = clientAddress(request.headers, request.ip);
        const retryAfter = limiter.retryAfterSeconds(address);
        if (retryAfter > 0) {
          reply.code(429).header("Retry-After", String(retryAfter));
          return {
            error: "rate_limited",
            message: `Too many failed sign-in attempts from this address. Try again in ${retryAfter} seconds.`,
          };
        }

        const result = redeemAuthCode(db, {
          code: request.body?.code,
          codeVerifier: request.body?.code_verifier,
          redirectUri: request.body?.redirect_uri,
        });
        if (!result.ok) {
          limiter.recordFailure(address);
          reply.code(400);
          return { error: "invalid_grant", reason: result.reason, message: REDEEM_FAILURE_MESSAGES[result.reason] };
        }
        limiter.recordSuccess(address);

        const { token, expiresAt } = createSession(db, result.relayUserId);
        const user = db.prepare("SELECT * FROM relay_users WHERE id = ?").get(result.relayUserId) as RelayUserRow;
        return { token, expiresAt: expiresAt.toISOString(), user: publicUser(user) };
      },
    );

    // Public keys for every home server that trusts legato.fm (issue #114).
    // Fetched by a server only once its owner has linked an account, then
    // daily (server/src/auth/legatoIdentity.ts). An hour of caching is far
    // inside the day-long overlap a rotation leaves (signing-keys.ts).
    app.get("/.well-known/jwks.json", async (_request, reply) => {
      reply.header("Cache-Control", "public, max-age=3600");
      return { keys: signingKeys?.published ?? [] };
    });

    // A short-lived token for one home server, for a signed-in account.
    // The token says who the account is; the server decides what that
    // account may do there (server/src/auth/gate.ts).
    //
    // Always scope "link" for now. An "access" token for a server the
    // account hasn't linked would let a hostile server that claims a real
    // server's (public) id replay a visitor's token against the real one.
    // So "access" is only for (account, server) pairs legato.fm has on
    // record, and nothing records them yet: a server can't prove it owns
    // an id to the relay until it has a tunnel credential. Until that
    // follow-up lands (#231, which blocks #117), the only thing a token can do on a
    // server is link the owner's account.
    app.post<{ Body: { serverId?: unknown } | null }>("/auth/server-token", async (request, reply) => {
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401);
        return { error: "Sign in to legato.fm first.", reason: "signed_out" };
      }
      if (!signingKeys || !config.callbackBaseUrl) {
        reply.code(503);
        return { error: SIGNING_NOT_CONFIGURED, reason: "signing_not_configured" };
      }
      const serverId = request.body?.serverId;
      if (typeof serverId !== "string" || !SERVER_ID_PATTERN.test(serverId)) {
        reply.code(400);
        return {
          error: "serverId must be the 32-character id from the server's GET /api/v1/auth/status (legato.serverId).",
          reason: "bad_server_id",
        };
      }
      const issued = signServerToken(signingKeys, { issuer: config.callbackBaseUrl, user, serverId, scope: "link" });
      return { token: issued.token, expiresAt: issued.expiresAt.toISOString(), scope: issued.scope };
    });

    app.post("/auth/logout", async (request, reply) => {
      const token = sessionToken(request);
      if (token) deleteSession(db, token);
      reply.clearCookie(SESSION_COOKIE, cookie);
      return { ok: true };
    });

    app.get("/auth/me", async (request) => {
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      return {
        user: user ? publicUser(user) : null,
        configured: { google: isGoogleConfigured(config), github: isGithubConfigured(config) },
      };
    });
  };
}
