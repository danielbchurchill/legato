# Deploying legato.fm

This is a static site (Vite, no server, no framework) in `site/`, meant for Cloudflare
Pages. `legato.fm` is already registered and already sits in a Cloudflare account, but
no Pages project exists yet and this session has no access to that account — the steps
below are what a human with dashboard/API access actually runs.

## 1. Build

```bash
cd site
npm install
npm run build
```

Output goes to `site/dist/` — plain HTML/CSS/JS plus the self-hosted font files and
screenshot images. No environment variables, no secrets, nothing to configure for the
build itself.

## 2. Create the Pages project and deploy

Two ways to do this — pick one, don't do both:

### Option A: `wrangler` (manual or CI-driven deploys)

```bash
cd site
npx wrangler login          # once, authenticates against the Cloudflare account
npx wrangler pages deploy dist --project-name=legato-marketing-site
```

The first deploy creates the Pages project if it doesn't already exist (wrangler will
prompt). Every subsequent run of that same command ships a new deployment. This is the
right path if deploys are triggered from a script or a CI job outside GitHub's own
integration.

### Option B: Cloudflare dashboard, connected to this GitHub repo

In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**,
pick this repository, and set:

- **Root directory:** `site`
- **Build command:** `npm run build`
- **Build output directory:** `dist`

This gives you automatic deploys on every push to `main` (and preview deploys on PRs)
with no CI config of our own to maintain. This is the recommended path unless there's a
specific reason to script deploys instead.

## 3. Point legato.fm at it (DNS)

Once the Pages project exists (either option above), Cloudflare assigns it a
`<project-name>.pages.dev` address and — because `legato.fm`'s DNS already lives in the
same Cloudflare account — adding the custom domain is a dashboard action, not a manual
DNS edit:

1. Open the Pages project → **Custom domains → Set up a custom domain**.
2. Enter `legato.fm` (and, if you want it too, `www.legato.fm`).
3. Cloudflare creates the correct DNS record for you automatically — an apex domain on
   a Cloudflare-managed zone gets CNAME-flattened transparently, so there's no manual
   A/AAAA/CNAME value to invent or copy here. Accept what the dashboard generates.
4. Propagation is typically near-instant since the zone is already on Cloudflare; SSL
   provisions automatically.

Do not hand-author a DNS record ahead of this step — the target hostname doesn't exist
until step 2 creates the project.

## 4. Set up the waitlist backend

The signup form POSTs to `/waitlist`, a Cloudflare Pages Function
(`site/functions/waitlist.ts`) that validates the email, rate-limits and dedups by IP,
and stores entries in a Workers KV namespace. It deploys as part of the same Pages
project as the static site — no separate service, no separate domain, no CORS to
configure — but the KV namespace it reads and writes has to exist first.

### Create the KV namespace

```bash
cd site
npx wrangler login                      # once, if you haven't already
npx wrangler kv namespace create WAITLIST_KV
npx wrangler kv namespace create WAITLIST_KV --preview
```

Each command prints an `id`. Put the first into `id` and the second into `preview_id`
in `site/wrangler.toml`'s `[[kv_namespaces]]` block, replacing the
`REPLACE_WITH_..._KV_NAMESPACE_ID` placeholders that are checked in. `preview_id` backs
`wrangler pages dev` locally and Pages' preview deploys; `id` backs production.

### Deploy

Pages Functions ship automatically with the Pages deploy — whichever of the two options
in step 2 you use, `functions/waitlist.ts` goes out with it. There's no separate
`wrangler deploy` for this piece; it isn't a standalone Worker.

### No secrets needed

The Worker doesn't call out to anything that needs a key — it only touches the KV
namespace bound in `wrangler.toml`. If that changes later (an email-verification
service, a Slack notification on new signups, etc.), add the key the normal Cloudflare
way — `npx wrangler secret put SOME_KEY` from `site/`, or the same field in the
dashboard under the Pages project's Settings → Environment variables — not a `.env`
file. Nothing about this repo's own secrets convention (`server/.env.local`, see the
root `AGENTS.md`) applies here; that's for the Fastify service, not this Worker.

### Read what's been collected

There's no admin endpoint — one more piece of public surface area isn't worth it for
reading a mailing list. Pull it straight from KV instead:

```bash
cd site
npx wrangler kv key list --binding=WAITLIST_KV --remote --prefix="email:"
npx wrangler kv key get --binding=WAITLIST_KV --remote "email:someone@example.com"
```

(Local testing uses `--local --preview` instead of `--remote` — see below.)

### Local testing

```bash
cd site
npm run dev:functions   # builds the site, then wrangler pages dev dist
```

This serves the built site *and* `/waitlist` together on `http://127.0.0.1:8788`,
against a local KV store under `site/.wrangler/` (gitignored, safe to delete anytime).
Plain `npm run dev` (Vite only, for frontend iteration) has nothing listening on
`/waitlist` — submitting the form there will fail with a network error, which is
expected; use `dev:functions` when the waitlist flow itself needs testing.

### What the abuse protection actually does

- **Real email format**, checked server-side against the same regex browsers use for
  `<input type="email">` — not a full RFC 5322 parser, just enough to catch typos and
  garbage.
- **A honeypot field** (`#waitlist-company`, hidden from sighted and screen-reader users
  alike) — a bot that fills in every input trips it; the request is accepted and
  silently dropped instead of stored, so the bot has no signal that it failed.
- **Per-IP rate limiting**, 5 submissions per 10 minutes, tracked in the same KV
  namespace. KV writes aren't atomic, so a burst of truly concurrent requests from one
  IP can occasionally slip a couple over the limit — a real gap, acceptable for a
  low-traffic waitlist form, not a defense against a determined attacker. If actual
  abuse shows up, the fix is Cloudflare's native Workers Rate Limiting binding, not a
  more elaborate hand-rolled counter.
- **Dedup by email** — resubmitting the same address is a no-op (`200`, not a second KV
  write), so the count in KV reflects unique signups even if someone's form-happy.

### Screenshots are real but small-scale

The three app screenshots on the page came from a live dev instance of the app against
a real (test-sized) library — see the PR description. They hold up fine at the sizes
used on the page; if the hero image is ever swapped for something higher-resolution,
recapture rather than upscale.
