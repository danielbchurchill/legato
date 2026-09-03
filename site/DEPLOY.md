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

## 4. Before calling it launched

- **Waitlist email.** The signup form (see the root README/PR description for why) is a
  `mailto:` link, not a real backend, pointed at `waitlist@legato.fm`. That address does
  nothing until [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)
  is turned on for the zone and a forwarding rule is added — it's free and a five-minute
  dashboard action, but it's not done as part of this deploy. Until then, either set it
  up or change `WAITLIST_ADDRESS` in `site/src/main.ts` to an inbox that already exists.
- **Screenshots are real but small-scale.** The three app screenshots on the page came
  from a live dev instance of the app against a real (test-sized) library — see the PR
  description. They hold up fine at the sizes used on the page; if the hero image is
  ever swapped for something higher-resolution, recapture rather than upscale.

## Follow-up, not done here

A real waitlist backend — a Cloudflare Pages Function (`site/functions/waitlist.ts`)
writing to a KV namespace, replacing the `mailto:` link — is the natural next step once
someone wants actual submission data instead of individual emails. Deliberately not
built speculatively in this pass: it means provisioning a new KV namespace on an account
this session has no access to, and the `mailto:` fallback is honest and fully working in
the meantime. See the PR description for the full reasoning.
