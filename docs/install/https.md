# Serving Legato over https

Opened at `http://<your server>:8899`, Legato's web app plays on a phone, lock-screen controls included, but it can't be installed. Browsers only install a web app from a secure address: https, or `localhost` on the server itself. The same rule keeps out the service worker that lets an installed app open when the server can't be reached. Over plain http, Legato says so the first time a track plays, and links here.

The fix is something in front of the server that answers on https and passes every request through to port 8899. The server itself doesn't change: it keeps answering on plain http, so nothing that already uses that address stops working. This page covers two ways to do it:

- **[Tailscale](#with-tailscale)**, if the server and the phone are both on your tailnet. A real certificate in one command, with no domain to buy and no port to open. Only devices on your tailnet can reach it.
- **[A reverse proxy with its own certificate](#with-caddy)**, for anyone without Tailscale. The examples use [Caddy](https://caddyserver.com), which gets and renews certificates by itself.

**Create the owner account first**, at the server's http address on your home network (see the README). Behind a proxy, the server can't tell who's on the other side, so `/setup` doesn't show the setup code there. The code is still in the server's log if you need it.

## With Tailscale

You need Tailscale on the server and on the phone, signed in to the same tailnet. In the [admin console's DNS page](https://login.tailscale.com/admin/dns), MagicDNS and **HTTPS Certificates** both have to be on.

1. On the server, run:

   ```sh
   tailscale serve --bg 8899
   ```

   It prints the address, `https://<machine>.<tailnet>.ts.net`, and keeps serving it after a reboot. On Linux, run it with `sudo`, or once run `sudo tailscale set --operator=$USER` so your user can change Tailscale's settings. If Legato runs in Docker, give the host port (`LEGATO_HOST_PORT`, 8899 unless you changed it).

2. Open that address on any device on the tailnet. The very first visit can take a few seconds while Tailscale fetches the certificate.

`tailscale serve status` shows what's being served, and `tailscale serve --https=443 off` stops it.

## With Caddy

Install Caddy on the server ([caddyserver.com/docs/install](https://caddyserver.com/docs/install); on Debian, Ubuntu and Raspberry Pi OS it comes from Caddy's own apt repository and runs as a service). Caddy can also run on another machine on your network: point `reverse_proxy` at `<your server>:8899` instead.

Caddy needs a certificate the phone trusts. Which kind depends on whether you have a domain name.

### With a domain name

1. Make a DNS record for a name under your domain, say `music.example.com`, pointing at the server's address on your home network (give the server a fixed address in your router first).
2. Caddy has to prove the name is yours. The name points at a private address that Let's Encrypt can't reach, so Caddy proves it through your DNS provider instead (the DNS challenge). That needs Caddy's module for your provider. For Cloudflare, run `sudo caddy add-package github.com/caddy-dns/cloudflare` and make an API token that can edit the zone's DNS. An apt upgrade puts the stock Caddy back, so run `add-package` again after one. Other providers have their own modules: see [caddyserver.com/download](https://caddyserver.com/download).
3. Put this in `/etc/caddy/Caddyfile`:

   ```caddyfile
   music.example.com {
   	tls {
   		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
   	}
   	reverse_proxy 127.0.0.1:8899
   }
   ```

4. Give the Caddy service the token (`sudo systemctl edit caddy`, then add `Environment=CLOUDFLARE_API_TOKEN=<token>` under `[Service]`), then run `sudo systemctl restart caddy`.

Some routers refuse DNS answers that point a public name at a private address, as protection against DNS rebinding. If `music.example.com` doesn't resolve at home, add the domain to your router's rebind exceptions.

### Without a domain name

Caddy can sign a certificate with its own local authority. The phone then has to trust that authority, once.

1. Put this in `/etc/caddy/Caddyfile`, with the server's own address on your home network (give it a fixed one in your router first):

   ```caddyfile
   {
   	default_sni 192.168.1.20
   }
   https://192.168.1.20 {
   	tls internal
   	reverse_proxy 127.0.0.1:8899
   }
   ```

   A browser opening an address by number doesn't say which name it wants, and `default_sni` tells Caddy which certificate to answer with. Then run `sudo systemctl reload caddy`.

2. Copy Caddy's root certificate to the phone. For the apt package, it's `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`. In Caddy's Docker image, it's `/data/caddy/pki/authorities/local/root.crt`.
3. On Android, open **Settings → Security & privacy → More security & privacy → Encryption & credentials → Install a certificate → CA certificate**, and pick that file. The menu names vary between phone makers: search Settings for "CA certificate". Android then shows a notice that the network may be monitored, because the phone now trusts this authority for every site.

The root lasts ten years. The certificate Caddy serves renews by itself, so the phone never needs another file. Whoever holds the root's private key, in Caddy's data folder, could pose as any site to that phone, so only do this with a server that's yours.

### Another reverse proxy

Any reverse proxy works if it does two things:

- **Keeps the browser's `Host` header.** The server trusts a request from its own machine to its own name (`localhost`), and a proxy that rewrites `Host` to `127.0.0.1` makes every request look like that. nginx rewrites it by default, so set `proxy_set_header Host $host;`. Caddy and `tailscale serve` keep it already.
- **Passes WebSocket upgrades through**, for `/api/v1/ws`, which carries the app's live updates. In nginx, that's `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`.

## Installing on Android

1. Open the https address in Chrome and sign in. The app keeps a separate sign-in for each address, so you sign in again here even if the phone already used the http one.
2. Play any track. A few seconds after it starts, Legato offers **install legato**. Press **install**, then **Install** in Chrome's dialog.
3. If you dismissed the offer, use Chrome's **⋮** menu → **Add to home screen** → **Install** instead.
4. Open Legato from the home screen. It opens in its own window, without Chrome's address bar, and keeps the lock-screen controls.
