# Real Google and GitHub sign-in

What Daniel does, and what has to be built, to get production Google and GitHub OAuth working. The OAuth routes can be tested on a throwaway server; this is about sign-in that works for real users. It covers the decisions, the console steps, the secrets and the code gaps, in the order they have to happen.

_Written 2026-09-30, against `main` at `147e008`. The plan this follows is [02-identity-and-accounts.md](02-identity-and-accounts.md); where the two disagree, 02 wins._

## The short version

- Real Google and GitHub sign-in belongs on **the legato.fm service** (today's relay on Fly), not on each home server. That's decision D1 in plan 02, and it's also the only place Google will accept: Google wants an `https` redirect on a domain you've verified, and a Pi on `http://100.100.20.30:8899` is neither.
- **You** do five things outside the code:
  1. Pick the sign-in hostname.
  2. Point DNS at Fly.
  3. Publish a privacy policy and terms page.
  4. Register one Google client and two GitHub OAuth apps.
  5. Put the secrets on Fly.
- **The code** has three gaps before those credentials mean anything to a home server:
  1. #114 (legato.fm as identity provider).
  2. A way to hand a browser sign-in back to the desktop app (no issue yet).
  3. `Secure` cookies on the relay.
- You can do all of your part now. It's safe, it changes nothing for anyone, and Google's brand verification takes days, so starting early saves waiting later.

## Where things stand today

There are two separate OAuth implementations, and neither is configured anywhere.

| | Home server | legato.fm service (relay) |
|---|---|---|
| Code | `server/src/routes/auth.ts` | `relay/src/routes/auth.ts` |
| Routes | `/api/v1/auth/{google,github}` and `…/callback` | `/auth/{google,github}` and `…/callback`, `/auth/me` |
| Env vars | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_CALLBACK_BASE_URL` | the same names with a `RELAY_` prefix, including `RELAY_AUTH_CALLBACK_BASE_URL` |
| Scopes | Google `openid email profile`; GitHub `read:user user:email` | same |
| What a sign-in does | Since #112, **only signs in an account the server already has**. It never creates one. | Creates or finds a relay account and sets a relay session cookie |
| Users that exist | **None**. The Pi and the AIO were both checked on 2026-09-29. | None; secrets aren't set (the relay is live on Fly, `/health` passes) |

Both scopes are the non-sensitive "basic sign-in" set. That matters for Google: no security assessment, only brand verification.

Two facts that shape everything below:

- **Home-server OAuth can't sign anyone in on the Pi today.** The Pi's only user is the local owner you created, and #112 deliberately stopped OAuth creating new users, since that would let anyone with a Google account in. There is also no "link my Google account to the owner" feature yet. So even perfectly configured Google/GitHub credentials on the Pi would only ever answer "This server doesn't know that account". Don't configure OAuth on the Pi.
- **The OAuth session is a cookie, and the desktop app can't use it.** The desktop app talking to the Pi, or the packaged app on `tauri://localhost`, is cross-site. Without TLS, a cookie there can't be `SameSite=None`. PR #205 flagged this: the browser window that did the sign-in has no safe way to hand the session back. That's code gap 2 below.

## Decisions to make first

1. **The sign-in hostname.** Recommendation: **`auth.legato.fm`**. It's short, it says what it is, and it stays correct when the relay tunnel becomes just one of the service's jobs. The alternative is `id.legato.fm`. Whatever you pick is baked into every OAuth callback URL, and changing it later means editing every provider registration, so choose once.
2. **Who owns the GitHub OAuth apps.** Recommendation: **your personal account for now.** An OAuth app can be transferred to an organization later with the same client ID. The alternative is creating a `legato-fm` GitHub organization now, so the consent screen reads "by legato-fm", not "by danielbchurchill".
3. **Which Google account owns the Cloud project.** Use the account you want Google's verification emails going to for years. Recommendation: a `legato.fm` Google Workspace address (for example `dev@legato.fm`), if you plan to have one. Otherwise your personal Gmail, adding a second owner later. Keep it off the `thinkubik` account: this project is deliberately personal (CLAUDE.md, Git section).
4. **A support email address** for the Google consent screen, for example `hello@legato.fm`. Google shows it to users, so it should be monitored.

## Step 1: DNS and TLS for the sign-in hostname

The relay runs on Fly as app `legato-relay` (`relay/fly.toml`). Fly issues the certificate; Cloudflare holds `legato.fm`'s DNS (the marketing site deploys to Cloudflare Pages, `site/DEPLOY.md`).

```sh
cd relay
fly certs add auth.legato.fm --app legato-relay
```

Fly prints the DNS records it wants. In Cloudflare → `legato.fm` → DNS, add:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `auth` | `legato-relay.fly.dev` | **DNS only (grey cloud)** |

DNS only matters. With Cloudflare's proxy on, Fly can't complete its certificate check, and you'd end up with two TLS layers to debug. If Fly also asks for an `_acme-challenge` CNAME, add that too.

Check it:

```sh
fly certs check auth.legato.fm --app legato-relay   # wait for "Ready"
curl https://auth.legato.fm/health                  # expect {"status":"ok"}
```

## Step 2: prove you own legato.fm to Google

Google won't brand a consent screen with a domain you haven't verified.

1. Open [Google Search Console](https://search.google.com/search-console), then **Add property**, then **Domain** (not "URL prefix"), and enter `legato.fm`.
2. It gives you a `TXT` record. Add it in Cloudflare DNS: Name `@`, Type `TXT`, value as given.
3. Click **Verify**. This usually takes minutes, occasionally a few hours.

Do this with the same Google account that will own the Cloud project (decision 3).

## Step 3: privacy policy and terms on legato.fm

Google's brand verification requires a public privacy policy link, and the homepage has to link to it. The site (`site/index.html`) has neither page today. The waitlist form on it already collects email addresses, so a privacy policy is due regardless of OAuth.

What you need live on `https://legato.fm`:

- `/privacy`: what's collected on sign-in (Google/GitHub account ID, name, email, avatar), what it's used for (signing you in and linking your home servers), where it's stored (the legato.fm service on Fly, region `iad`), and that it's never sold or shared. Say that your music library never leaves your server. It doesn't, and it's the reassuring line. Add how to delete an account (#145 builds the button; until then, "email us").
- `/terms`: short is fine.
- Links to both in the homepage footer.

This is content work in `site/`, not a code change. A worker can draft both pages from this list if you want, but you should read them before they go live: they're statements you're legally making.

## Step 4: Google

All of this is in the [Google Cloud console](https://console.cloud.google.com), signed in as the account from decision 3.

1. **Create a project:** top bar, then **New project**. Name: `legato-fm`. No organization is needed.
2. **Open Google Auth Platform** (left menu, "Google Auth Platform", or `console.cloud.google.com/auth`). Click **Get started**.
   - **App information:** App name `Legato`, User support email = decision 4.
   - **Audience:** **External**.
   - **Contact information:** your address. Google sends verification and policy mail here.
   - Agree to the user data policy, then **Create**.
3. **Branding** (left menu):
   - App logo: the Legato mark, square, 120×120 px, PNG or JPG, under 1 MB.
   - App home page: `https://legato.fm`
   - Privacy policy: `https://legato.fm/privacy`
   - Terms of service: `https://legato.fm/terms`
   - Authorized domains: `legato.fm`. It must be the domain verified in step 2.
   - Save.
4. **Data Access** (left menu), then **Add or remove scopes**. Tick exactly `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. They're all non-sensitive, and adding anything else would trigger a much heavier review.
5. **Clients** (left menu), then **Create client**:
   - Application type: **Web application**
   - Name: `legato.fm production`
   - Authorized JavaScript origins: leave empty. The sign-in happens on the server, not in page JavaScript.
   - Authorized redirect URIs: `https://auth.legato.fm/auth/google/callback`
   - **Create**. Copy the **Client ID** and **Client secret** straight into step 6. Don't paste them anywhere else. The secret can be viewed again later in the console, but treat it as if it can't.
6. **A second client for development** (optional, recommended), so you never point a laptop at production credentials:
   - Name: `legato.fm dev`
   - Redirect URI: `http://127.0.0.1:8901/auth/google/callback`
   - Google allows plain `http` only for loopback, so this one works without TLS. Its values go in `relay/.env.local`, which is gitignored.
7. **Audience, then Publish app.**
   - While the app is in **Testing**, only the test users you list (up to 100) can sign in, and everyone else gets "Access blocked". You can stay in Testing while #114 is being built. Add yourself and anyone testing.
   - Publishing moves it to **In production**. With only basic scopes there's no security review, but **brand verification** starts then (the Branding page shows its status). It typically takes a few business days, and Google may email questions.
   - Until it passes, users may see your domain in place of the app name and logo. Publish before real users arrive, not on launch day.

## Step 5: GitHub

A GitHub **OAuth app**, not a GitHub App: this is sign-in only, and an OAuth app is the right shape for it.

GitHub allows **one callback URL per OAuth app**. The `redirect_uri` sent at sign-in must match that URL's host and port. It may add a sub-path, but can't point anywhere else. So production and development need two separate apps.

1. GitHub, then **Settings → Developer settings → OAuth Apps → New OAuth App** (or the organization's Developer settings, per decision 2).
2. **Production:**
   - Application name: `Legato`
   - Homepage URL: `https://legato.fm`
   - Application description: one line, for example "Sign in to Legato."
   - Authorization callback URL: `https://auth.legato.fm/auth/github/callback`
   - Leave **Enable Device Flow** off.
   - **Register application**, then **Generate a new client secret**. GitHub shows it **once**; copy the Client ID and the secret straight into step 6.
   - Upload the Legato logo in the app settings. It's shown on the consent page.
3. **Development:** the same, named `Legato (dev)`, with Homepage `http://127.0.0.1:8901` and callback `http://127.0.0.1:8901/auth/github/callback`. Its values go in `relay/.env.local`.

No verification or review exists for GitHub OAuth apps. It works as soon as the secrets are in place.

`user:email` is required, not optional. Many GitHub users hide their email, and both implementations read `/user/emails`. They take the primary verified address, then any verified one, and leave email empty instead of guessing (`server/src/routes/auth.ts:172-180`). Verified email is how #114 will match accounts, so don't drop that scope.

## Step 6: secrets on Fly

Secrets go straight from your clipboard into Fly and nowhere else: not in chat, not in a file in the repo.

```sh
cd relay
fly secrets set --app legato-relay --stage \
  RELAY_AUTH_CALLBACK_BASE_URL="https://auth.legato.fm" \
  RELAY_GOOGLE_CLIENT_ID="…" \
  RELAY_GOOGLE_CLIENT_SECRET="…" \
  RELAY_GITHUB_CLIENT_ID="…" \
  RELAY_GITHUB_CLIENT_SECRET="…"
```

`--stage` stores them without restarting the machine. They take effect on the next `fly deploy`. Leave out `--stage` to apply them immediately with a restart.

To keep secrets out of your shell history, put a space before `fly`: bash skips commands that start with a space when `HISTCONTROL` includes `ignorespace`, which is the default on most distros. Or type `fly secrets set` one value at a time.

`RELAY_AUTH_CALLBACK_BASE_URL` must be the `https://auth.legato.fm` origin with no trailing slash. The code builds `${base}/auth/<provider>/callback` (`relay/src/routes/auth.ts:53`), and it has to match the registered URIs character for character. A mismatch shows up as Google's `redirect_uri_mismatch` or GitHub's "The redirect_uri is not associated with this application".

Check what's set:

```sh
fly secrets list --app legato-relay   # names and digests only, never values
```

## Step 7: check the live sign-in

Once the secrets are applied:

1. Open `https://auth.legato.fm/auth/github` in a browser. You should see GitHub's consent page for "Legato", and after approving, a signed-in page.
2. Then `https://auth.legato.fm/auth/me` should show your account.
3. Repeat with `/auth/google`. While the app is in Testing, only listed test users get through.

That proves the providers, DNS, TLS and secrets all work. It doesn't yet sign you in to your Pi; that's what the code work below adds.

## Code that has to exist before this reaches home servers

None of these need you at a console. They're issues for workers.

1. **#114: legato.fm as the identity provider.** The home server verifies short-lived signed tokens from legato.fm (EdDSA, `aud` = server id, `exp` ≤ 15 min), and `users` gains `legato_account_id`. This is what turns the Google and GitHub sign-ins above into access to your Pi. It's in wave 5, and it depends on #112 (merged) and #101 (merged).
2. **Handing a sign-in back to the desktop app (no issue yet).**
   - Today the OAuth window ends with a cookie. The desktop app and the Mac → Pi setup authenticate with a bearer token, and can't read that cookie.
   - The fix PR #205 recommends: the callback issues a **one-time exchange code**; the app opens the sign-in in the system browser with a PKCE-style verifier and redeems the code for a token. The token itself never goes over `postMessage` or into a URL.
   - It needs a small design and should land with or just after #114. I can file it.
3. **`Secure` cookies on the relay.** The relay's session and OAuth-state cookies are set without `Secure` (`relay/src/routes/auth.ts`, the `reply.setCookie` calls). That was right for loopback development, but on `https://auth.legato.fm` they should be `Secure`, set whenever `RELAY_AUTH_CALLBACK_BASE_URL` starts with `https://`. It's a one-line fix per cookie, plus a test. It belongs in #114, or can be a tiny issue of its own, and must land **before real users sign in**.
4. **Retire home-server OAuth once #114 lands.** No server has Google/GitHub users, so `server/src/routes/auth.ts`'s provider flow and its env vars can go. That removes the need for any per-server OAuth registration. Keep them until #114 is verified.
5. **Passkeys, email links and Sign in with Apple** (#137) come after. Apple needs an Apple Developer account, the same one #129's signing needs, and its own domain verification. It's out of scope here.

## Order of operations

| # | What | Who | Blocks |
|---|---|---|---|
| 1 | Decide the hostname, GitHub owner, Google account and support email | Daniel | everything |
| 2 | `fly certs add`, and the Cloudflare CNAME set to DNS only | Daniel | 6, 7 |
| 3 | Verify `legato.fm` in Search Console | Daniel | 4 |
| 4 | Privacy and terms pages live on legato.fm | Daniel (a worker can draft) | 5 publishing |
| 5 | Google project, branding, scopes, clients; publish to start brand verification | Daniel | 7 for non-test users |
| 6 | GitHub OAuth apps (prod and dev) | Daniel | 7 |
| 7 | `fly secrets set`, then the live check | Daniel | nothing (it's the proof) |
| 8 | `Secure` cookies on the relay | worker | real users |
| 9 | #114 identity provider | worker, wave 5 | home-server sign-in |
| 10 | Desktop sign-in handoff | worker, with or after #114 | desktop and Mac → Pi sign-in |
| 11 | Retire home-server OAuth | worker, after #114 | — |

Steps 1–7 can all happen this week, in parallel with wave 5. Nothing you set up changes behaviour for anyone until #114 ships.

## Things that commonly go wrong

- **`redirect_uri_mismatch` (Google) or "redirect_uri is not associated" (GitHub):** the base URL secret doesn't match what's registered. Check for a trailing slash, `http` vs `https`, or a port.
- **The Fly certificate stuck on "Awaiting configuration":** the Cloudflare record is proxied (orange cloud). Set it to DNS only.
- **"Access blocked: Legato has not completed the Google verification process":** the app is in Testing and that account isn't a listed test user. Add them, or publish.
- **GitHub sign-in with no email:** `user:email` scope is missing, or the user has no verified email. The second is expected and handled; the first is a registration mistake.
- **Secrets set but nothing changed:** they were staged with `--stage` and nothing has redeployed since. Run `fly deploy`, or re-set without `--stage`.
