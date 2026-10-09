import { randomBytes } from "node:crypto";
import type { Database } from "../sqlite.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  AUTH_CALLBACK_BASE_URL,
  DEFAULT_LEGATO_ID_ORIGIN,
} from "../config.js";
import { USER_AGENT } from "../enrich/mbClient.js";
import { ServerClaims, type ClaimCheck } from "../auth/claim.js";
import { SESSION_COOKIE, bearerToken } from "../auth/gate.js";
import { legatoIdentity } from "../auth/legatoIdentity.js";
import { linkLegatoAccount } from "../auth/legatoLink.js";
import { linkedAccountId, unlinkAccount } from "../auth/legatoUsers.js";
import { createOwner, ownerExists, passwordProblem, verifyOwnerPassword } from "../auth/owner.js";
import { clientAddress } from "../auth/clientAddress.js";
import { SignInLimiter } from "../auth/rateLimit.js";
import { isLocalRequest, maySeeSetupCode, setupCodes as serverSetupCodes, type SetupCodes } from "../auth/setupCode.js";
import { createSession, deleteSession, spendAccessToken, type SessionUser } from "../auth/sessions.js";
import { IDENTITY_NONCE_PATTERN, identityProof, loadServerKey } from "../auth/serverKey.js";
import { forgetTunnelCredential } from "../auth/tunnelCredential.js";
import { syncRelayTunnelOnceAnswered } from "../tunnel/relayTunnel.js";

// Sign-in for this server (issue #112): the local owner's password, plus
// the Google/GitHub accounts provisioned before the owner existed. The
// gate that makes every other route require one of them is auth/gate.ts;
// every route in this file is on its public list.
//
// OAuth state is a plain (unsigned) httpOnly cookie compared against the
// provider's callback `state` query param. That's enough CSRF protection
// here — an attacker can't read or set a cookie on this origin from
// another one — without needing a signing secret.

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
  role: "legacy";
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

// Since 0029 this only signs in an account the server already knows. It
// used to create a row for anyone who completed the Google or GitHub flow,
// which was harmless while nothing checked for a user; now that a users
// row grants access to the whole library, creating one on sign-in would
// let any Google account in. Returns null for an unknown account.
// Profile fields and last_login_at refresh on every sign-in, as before.
export function signInKnownOAuthUser(db: Database, provider: Provider, profile: OAuthProfile): UserRow | null {
  const result = db
    .prepare(
      `UPDATE users SET email = ?, display_name = ?, avatar_url = ?, last_login_at = datetime('now')
       WHERE provider = ? AND provider_user_id = ?`,
    )
    .run(profile.email, profile.displayName, profile.avatarUrl, provider, profile.providerUserId);
  if (result.changes === 0) return null;
  return db
    .prepare("SELECT * FROM users WHERE provider = ? AND provider_user_id = ?")
    .get(provider, profile.providerUserId) as UserRow;
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

function notConfiguredMessage(provider: Provider): string {
  const vars = provider === "google" ? "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET" : "GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET";
  return `${provider} OAuth isn't configured on this server — set ${vars} and AUTH_CALLBACK_BASE_URL in server/.env.local.`;
}

function escapeHtml(s: string): string {
  const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => escapes[c]!);
}

// A bare page, not a redirect back into the app: the frontend has no fixed
// origin this server can assume (Vite dev port, a Tauri bundle, a future
// remote client), so the sign-in button opens this flow in a new window
// and the Account section itself re-checks GET /auth/me on window focus.
// The background is tokens.css's ink canvas, the same as the Tauri window's
// own (tauri.conf.json), so the flash between pages doesn't look like a
// crash. src/styles/canvasCopies.spec.ts checks every copy against the token.
function messagePage(message: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0f1214;color:#c9c9c9;font-family:system-ui,sans-serif;font-size:14px;">
    <p style="max-width:420px;text-align:center;">${message}</p>
  </body>
</html>`;
}

const PROVIDER_NAMES: Record<Provider, string> = { google: "Google", github: "GitHub" };

function publicUser(user: SessionUser) {
  return {
    id: user.id,
    provider: user.provider,
    role: user.role,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
  };
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", expires: expiresAt });
}

// The body every successful sign-in returns. The client keeps token and
// mediaTicket itself (localStorage, keyed by server origin) because the
// cookie set alongside them never reaches a cross-site client — see
// auth/gate.ts for which client needs which.
function issueSession(db: Database, reply: FastifyReply, user: SessionUser) {
  const { token, mediaTicket, expiresAt } = createSession(db, user.id);
  setSessionCookie(reply, token, expiresAt);
  return { token, mediaTicket, expiresAt: expiresAt.toISOString(), user: publicUser(user) };
}

// A signed-in Google/GitHub user from before 0029 already proved who they
// are to this server, so they can create the owner without the setup code.
function setupCodeRequired(request: FastifyRequest): boolean {
  return !isLocalRequest(request) && request.authUser?.role !== "legacy";
}

const SETUP_CODE_LOG_HELP = "It's in the server's log; on a Linux service, run journalctl --user-unit legato-server.";
const SETUP_CODE_HELP =
  "It's on the server's /setup page, and in its log; on a Linux service, run journalctl --user-unit legato-server.";

// Where the /setup page's QR code points: the claim page (issue #237),
// which signs the phone in to legato.fm and claims this server for that
// account (auth/claim.ts). For legato.fm itself that's legato.fm/claim, the
// URL #113 already printed; the static site sends it on to the page on
// auth.legato.fm (site/public/_redirects). Any other LEGATO_ID_ORIGIN, a
// relay on this machine say, serves the page itself. Null when legato.fm
// is off, and then there's no QR.
const CLAIM_URL_BASE = "https://legato.fm/claim";

function claimUrl(origin: string | null, code: string): string | null {
  if (!origin) return null;
  const base = origin === DEFAULT_LEGATO_ID_ORIGIN ? CLAIM_URL_BASE : `${origin}/claim`;
  return `${base}?code=${encodeURIComponent(code)}`;
}

const CLAIM_CHECK_MESSAGES: Record<Exclude<ClaimCheck, "ok">, string> = {
  no_claim: "Nobody has claimed this server on legato.fm, so there's no account to link. Create the owner on its own.",
  mismatch:
    "This server's claim is for a different legato.fm account than the one this page showed, so nothing was created. Check the page again.",
  lapsed:
    "The claim lapsed before the owner was created, so there's nothing to link. Scan the code again to claim it, or create the owner on its own.",
};

export function authRoutes(
  db: Database,
  options: { limiter?: SignInLimiter; setupCodes?: SetupCodes; claims?: ServerClaims } = {},
) {
  const limiter = options.limiter ?? new SignInLimiter();
  const setupCodes = options.setupCodes ?? serverSetupCodes;

  function tooManyAttempts(request: FastifyRequest, reply: FastifyReply) {
    const retryAfter = limiter.retryAfterSeconds(clientAddress(request));
    if (retryAfter === 0) return null;
    reply.code(429).header("Retry-After", String(retryAfter));
    return { error: "Too many attempts. Wait a moment, then try again.", reason: "rate_limited", retryAfter };
  }

  async function finishOAuth(provider: Provider, profile: OAuthProfile, reply: FastifyReply) {
    reply.type("text/html");
    const user = signInKnownOAuthUser(db, provider, profile);
    if (!user) {
      reply.code(403);
      return messagePage(
        `This server doesn't know that ${PROVIDER_NAMES[provider]} account, so it can't sign you in with it. ` +
          "Close this window and sign in with the owner's password instead.",
      );
    }
    const { token, expiresAt } = createSession(db, user.id);
    setSessionCookie(reply, token, expiresAt);
    const name = user.display_name ? escapeHtml(user.display_name) : "your account";
    return messagePage(`Signed in as ${name}. You can close this window and go back to Legato.`);
  }

  return async function routes(app: FastifyInstance) {
    const claims =
      options.claims ??
      new ServerClaims({
        setupCodes,
        identity: () => legatoIdentity(db),
        log: (level, message) => (level === "warn" ? app.log.warn(message) : app.log.info(message)),
      });

    // Public: the client calls this before it knows whether to show "create
    // the owner", "sign in", or the app itself.
    app.get("/auth/status", async (request) => {
      const hasOwner = ownerExists(db);
      return {
        ownerExists: hasOwner,
        setupCodeRequired: !hasOwner && setupCodeRequired(request),
        user: request.authUser ? publicUser(request.authUser) : null,
        // Lets a Google/GitHub user from before 0029 find their way in from
        // the sign-in screen, since the settings panel that used to hold
        // these buttons is behind the gate now.
        oauth: { google: isGoogleConfigured(), github: isGithubConfigured() },
        // What a client needs to ask legato.fm for a token for this server
        // (issue #114): the id goes in as the token's audience, and the
        // issuer says which legato.fm to ask. issuer is null when
        // LEGATO_ID_ORIGIN=off. linked only tells the signed-in caller
        // about their own row.
        // publicKey (issue #117) is what the id is a hash of, for a client
        // checking POST /auth/identity's signature.
        legato: {
          serverId: legatoIdentity(db).serverId(),
          publicKey: loadServerKey(db).publicKey,
          issuer: legatoIdentity(db).origin,
          linked: request.authUser ? linkedAccountId(db, request.authUser.id) !== null : null,
        },
      };
    });

    // Public, like /auth/status (issue #117): this server signs a nonce the
    // client just made, with the key its id is derived from, so a client can
    // tell it apart from anything else on the LAN claiming the same id before
    // it sends a legato.fm access token (auth/serverKey.ts).
    app.post<{ Body: { nonce?: unknown } | null }>("/auth/identity", async (request, reply) => {
      const nonce = request.body?.nonce;
      if (typeof nonce !== "string" || !IDENTITY_NONCE_PATTERN.test(nonce)) {
        reply.code(400);
        return { error: "Send a fresh nonce of 16 to 128 base64url characters as `nonce`.", reason: "bad_nonce" };
      }
      return identityProof(loadServerKey(db), nonce);
    });

    // Public, and only while there's no owner: what the /setup page shows
    // (issue #113). maySeeSetupCode() decides who gets the code itself;
    // everyone else is pointed at the log. expiresInMs rather than only a
    // timestamp, so the page's countdown is right even when the browser's
    // clock isn't.
    //
    // The open page asks again every few seconds, and that's what lets
    // this server ask legato.fm whether the code has been claimed (issue
    // #237, auth/claim.ts). claim says where that stands; null when
    // legato.fm is off.
    app.get("/auth/setup", async (request, reply) => {
      if (ownerExists(db)) {
        reply.code(409);
        return { error: "This server already has an owner. Sign in instead.", reason: "owner_exists" };
      }
      if (!maySeeSetupCode(request)) {
        reply.code(403);
        return {
          error: `This page can't show the setup code from where you're connecting. ${SETUP_CODE_LOG_HELP}`,
          reason: "setup_code_hidden",
        };
      }
      const claim = claims.enabled ? claims.checkIn() : null;
      const { code, expiresAt } = setupCodes.current();
      return {
        code,
        expiresAt: new Date(expiresAt).toISOString(),
        expiresInMs: setupCodes.remainingMs(),
        claimUrl: claimUrl(legatoIdentity(db).origin, code),
        claim,
      };
    });

    // linkAccountId (issue #237): the legato.fm account /setup showed as
    // having claimed this server, sent only when the person chose to link
    // it. It's checked against the claim before anything is created, so a
    // claim that changed or lapsed since the page last looked links nobody
    // and creates nobody. Without it, a pending claim is dropped.
    app.post<{ Body: { password?: unknown; displayName?: unknown; setupCode?: unknown; linkAccountId?: unknown } | null }>(
      "/auth/owner",
      async (request, reply) => {
        if (ownerExists(db)) {
          reply.code(409);
          return { error: "This server already has an owner. Sign in instead.", reason: "owner_exists" };
        }
        const password = request.body?.password;
        const problem = passwordProblem(password);
        if (problem) {
          reply.code(400);
          return { error: problem, reason: "bad_password" };
        }

        if (setupCodeRequired(request)) {
          const limited = tooManyAttempts(request, reply);
          if (limited) return limited;
          const check = setupCodes.check(request.body?.setupCode);
          if (check !== "ok") {
            limiter.recordFailure(clientAddress(request));
            reply.code(403);
            return check === "expired"
              ? {
                  error: "That setup code expired. The server has made a new one; use that instead.",
                  reason: "expired_setup_code",
                }
              : { error: `That setup code doesn't match. ${SETUP_CODE_HELP}`, reason: "bad_setup_code" };
          }
          limiter.recordSuccess(clientAddress(request));
        }

        const linkAccountId = request.body?.linkAccountId;
        const linking = typeof linkAccountId === "string" && linkAccountId !== "";
        const claimCheck = linking ? claims.check(linkAccountId) : "ok";
        if (claimCheck !== "ok") {
          reply.code(409);
          return { error: CLAIM_CHECK_MESSAGES[claimCheck], reason: `claim_${claimCheck}` };
        }

        const rawName = request.body?.displayName;
        const displayName = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 200) : null;
        const owner = await createOwner(db, password as string, displayName);
        if (!owner) {
          reply.code(409);
          return { error: "This server already has an owner. Sign in instead.", reason: "owner_exists" };
        }
        request.log.info("auth: owner account created");

        // The owner exists whatever happens next. A link that fails says
        // why alongside the session, and the owner can link from the app.
        let legato: { linked: { accountId: string; email: string | null; name: string | null } | null; error?: string; reason?: string } | undefined;
        if (linking) {
          const linkToken = claims.take(linkAccountId);
          const outcome = linkToken
            ? await linkLegatoAccount(db, owner.id, linkToken)
            : { ok: false as const, error: CLAIM_CHECK_MESSAGES.lapsed, reason: "claim_lapsed" };
          legato = outcome.ok ? { linked: outcome.linked } : { linked: null, error: outcome.error, reason: outcome.reason };
          if (outcome.ok) request.log.info("auth: owner linked the legato.fm account that claimed this server");
        }
        claims.drop();
        reply.code(201);
        return { ...issueSession(db, reply, owner), ...(legato ? { legato } : {}) };
      },
    );

    app.post<{ Body: { password?: unknown } | null }>("/auth/sign-in", async (request, reply) => {
      const limited = tooManyAttempts(request, reply);
      if (limited) return limited;
      if (!ownerExists(db)) {
        reply.code(409);
        return { error: "This server doesn't have an owner yet. Create one first.", reason: "owner_required" };
      }
      const password = request.body?.password;
      const owner = typeof password === "string" && !passwordProblem(password) ? await verifyOwnerPassword(db, password) : null;
      if (!owner) {
        limiter.recordFailure(clientAddress(request));
        reply.code(401);
        return { error: "That password doesn't match this server's owner.", reason: "bad_password" };
      }
      limiter.recordSuccess(clientAddress(request));
      return issueSession(db, reply, owner);
    });

    app.post("/auth/sign-out", async (request, reply) => {
      const token = bearerToken(request) ?? request.cookies[SESSION_COOKIE];
      if (token) deleteSession(db, token);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    });

    // Issue #114: the owner attaches their legato.fm account to this server,
    // so a token legato.fm signs for it maps to the owner's row. Takes a
    // token rather than an account id, so the server sees legato.fm's own
    // signature on who the account is. Unless it was claimed from /setup,
    // this is the first time the server contacts legato.fm at all
    // (auth/legatoIdentity.ts's privacy note): the keys it needs to verify
    // the token are fetched here, and the daily refresh starts once the
    // link is stored.
    //
    // Issue #231: legato.fm only signs `access` tokens for servers an
    // account has linked, so the link is reported to legato.fm too, signed
    // with this server's identity key. auth/legatoLink.ts does both halves.
    app.post<{ Body: { token?: unknown } | null }>("/auth/legato/link", async (request, reply) => {
      if (request.authUser?.role !== "owner") {
        reply.code(403);
        return { error: "Only this server's owner can link it to a legato.fm account.", reason: "owner_only" };
      }
      const identity = legatoIdentity(db);
      if (!identity.enabled) {
        reply.code(503);
        return {
          error: "legato.fm sign-in is turned off on this server (LEGATO_ID_ORIGIN=off).",
          reason: "legato_disabled",
        };
      }
      const token = request.body?.token;
      if (typeof token !== "string" || !token) {
        reply.code(400);
        return { error: "Send the legato.fm token to link as `token`.", reason: "missing_token" };
      }

      const outcome = await linkLegatoAccount(db, request.authUser.id, token);
      if (!outcome.ok) {
        reply.code(outcome.status);
        const { error, reason, legatoReason } = outcome;
        return legatoReason === undefined ? { error, reason } : { error, reason, legatoReason };
      }
      request.log.info("auth: owner linked a legato.fm account");
      return { linked: outcome.linked };
    });

    // Unlinking the last account also stops the daily key refresh, so the
    // server goes back to never contacting legato.fm. The cached keys stay;
    // they're public and harmless, and a relink can use them. The tunnel
    // credential doesn't (issue #310): it's forgotten, and the tunnel it
    // kept open closes, once this answer has gone. An unlink made from a
    // phone through legato.fm comes down that very tunnel, and closing it
    // first would turn an unlink that happened into a 502.
    //
    // legato.fm is told (issue #231), but the unlink here happens first and
    // doesn't depend on it: the owner wants out, and may be offline. If
    // legato.fm can't be reached, it keeps the pair and goes on signing
    // `access` tokens for the account, which this server refuses because
    // the account isn't linked here any more. legatoNotified says which
    // happened, for a client to suggest removing the server on legato.fm as
    // well, and is null when there was no link to report.
    app.delete("/auth/legato/link", async (request, reply) => {
      if (request.authUser?.role !== "owner") {
        reply.code(403);
        return { error: "Only this server's owner can unlink its legato.fm account.", reason: "owner_only" };
      }
      const identity = legatoIdentity(db);
      const accountId = linkedAccountId(db, request.authUser.id);
      unlinkAccount(db, request.authUser.id);
      if (accountId) forgetTunnelCredential(db, accountId);
      identity.syncSchedule();
      syncRelayTunnelOnceAnswered(db, reply);
      const legatoNotified = accountId && identity.enabled ? (await identity.recordUnlink(accountId)).ok : null;
      return { ok: true, legatoNotified };
    });

    // Issue #117: a client signed in to legato.fm swaps an `access` token for
    // a session, so covers and audio get a media ticket. Only the token can
    // call this, never a session (the gate sets legatoClaims for a verified
    // token alone), so a session can't mint sessions. Each token works once,
    // and the session lasts a fixed twelve hours without sliding
    // (auth/sessions.ts). The client checks this server's identity before
    // the token leaves it (src/connect/identity.ts).
    app.post("/auth/legato/session", async (request, reply) => {
      const claims = request.legatoClaims;
      if (!request.authUser || !claims) {
        reply.code(403);
        return { error: "Only a legato.fm access token can open a legato.fm session here.", reason: "legato_token_required" };
      }
      if (!claims.jti || !spendAccessToken(db, claims.jti, claims.exp)) {
        reply.code(409);
        return { error: "That legato.fm token was already used. Ask legato.fm for a fresh one.", reason: "token_used" };
      }
      const { token, mediaTicket, expiresAt } = createSession(db, request.authUser.id, claims.sub);
      return { token, mediaTicket, expiresAt: expiresAt.toISOString(), user: publicUser(request.authUser) };
    });

    app.get("/auth/me", async (request) => ({
      user: request.authUser ? publicUser(request.authUser) : null,
      configured: { google: isGoogleConfigured(), github: isGithubConfigured() },
    }));

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
      return finishOAuth("google", await exchangeGoogleCode(request.query.code), reply);
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
      return finishOAuth("github", await exchangeGithubCode(request.query.code), reply);
    });
  };
}
