// Cloudflare Pages Function — handles POST /waitlist for the legato.fm
// signup form. Deployed alongside the static site (see ../DEPLOY.md for the
// KV namespace this needs). Bots that autofill every input trip the
// honeypot field; everyone else is rate-limited and deduped in KV.

interface Env {
  WAITLIST_KV: KVNamespace;
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

// The WHATWG HTML5 spec's <input type="email"> validation regex — strict
// enough to catch typos and garbage, not a full RFC 5322 parser.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const MAX_EMAIL_LENGTH = 254; // RFC 5321 4.5.3.1.3

const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 5; // per IP, per window

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Fixed-window limiter keyed by IP. KV writes aren't atomic, so a handful
// of concurrent requests from the same IP right at the boundary can slip
// through — acceptable for a low-traffic waitlist form, not a defense
// against a determined attacker. If real abuse shows up, move this to
// Cloudflare's native Workers Rate Limiting binding instead of hand-rolling
// it further.
async function isRateLimited(kv: KVNamespace, ip: string, now: number): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const record = await kv.get<RateLimitRecord>(key, 'json');

  if (!record || now >= record.resetAt) {
    const resetAt = now + RATE_LIMIT_WINDOW_SECONDS * 1000;
    await kv.put(key, JSON.stringify({ count: 1, resetAt }), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });
    return false;
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  const remainingTtl = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  await kv.put(key, JSON.stringify({ count: record.count + 1, resetAt: record.resetAt }), {
    expirationTtl: remainingTtl,
  });
  return false;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Expected a JSON body.' }, 400);
  }

  const { email, company } = (body ?? {}) as { email?: unknown; company?: unknown };

  // Honeypot: a hidden field real users never see or fill in. Accept
  // silently so a bot filling it can't tell it was dropped.
  if (typeof company === 'string' && company.trim() !== '') {
    return jsonResponse({ ok: true, alreadyJoined: false }, 200);
  }

  if (typeof email !== 'string') {
    return jsonResponse({ ok: false, error: 'Email is required.' }, 400);
  }

  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(trimmed)) {
    return jsonResponse({ ok: false, error: "That doesn't look like a valid email address." }, 400);
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (await isRateLimited(env.WAITLIST_KV, ip, Date.now())) {
    return jsonResponse({ ok: false, error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }

  const key = `email:${trimmed.toLowerCase()}`;
  const existing = await env.WAITLIST_KV.get(key);
  if (existing) {
    return jsonResponse({ ok: true, alreadyJoined: true }, 200);
  }

  await env.WAITLIST_KV.put(key, JSON.stringify({ email: trimmed, joinedAt: new Date().toISOString() }));

  return jsonResponse({ ok: true, alreadyJoined: false }, 201);
};
