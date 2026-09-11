# WordPress fixed-IP relay

A one-file Caddy reverse proxy that gives the blog tool a single, stable
source address for its WordPress REST calls. See the main README, section
"SiteGround anti-bot", for why.

## What you need

- A small always-on machine with a **static IPv4**. DigitalOcean's $6/month droplet (`s-1vcpu-1gb`) in `nyc3` is plenty; the app's functions run in Vercel `iad1` (Washington DC). Ubuntu 24.04.
- A hostname that resolves to it. Zero-DNS option: `<ip-with-dashes>.sslip.io` (e.g. `203-0-113-7.sslip.io`), a public wildcard DNS service; Let's Encrypt issues the certificate for it automatically. A subdomain you control (`wp-relay.aston.ae`, A record, **not** proxied through Cloudflare) works the same and can be switched to later.
- A shared key: `openssl rand -hex 32`.

## DigitalOcean, zero-touch (recommended)

```bash
brew install doctl && doctl auth init          # once; paste a DO API token at the prompt
ops/wp-relay/create-droplet.sh '<the key>'     # creates "wp-relay" in nyc3, ~$6/month
```

The droplet installs itself at first boot (`cloud-init.sh` → `install.sh`); after two or three minutes `https://<ip-with-dashes>.sslip.io/wp-json/` answers 404 (the relay is up and refusing key-less requests). Progress log on the droplet: `/var/log/wp-relay-install.log`; service logs: `journalctl -u caddy`. To use a real hostname instead, pass it as the second argument and create its A record first.

## Any other machine

```bash
git clone https://github.com/Fasansola/aston.git && cd aston/ops/wp-relay
sudo bash install.sh <relay-host> aston.ae '<the key>' [letsencrypt-contact-email]
```

The script installs Caddy, writes `/etc/caddy/Caddyfile` and `/etc/caddy/wp-relay.env`, opens ports 22/80/443, starts the service and prints the machine's static IP.

Docker instead: `cp .env.example .env`, fill it in, `docker compose up -d`.

## Point the app at it

In Vercel → Settings → Environment Variables (Production):

| Variable | Value |
|---|---|
| `WP_API_URL` | `https://<relay host>` (e.g. `https://203-0-113-7.sslip.io`) |
| `WP_RELAY_KEY` | the same key (mark Sensitive) |

Redeploy, then press **Re-check** on the dashboard: the WordPress light should read "REST API reachable via relay". `WP_URL` stays `https://aston.ae` (public links, edit links).

## Tell SiteGround

Give support the relay's IP and ask them to exempt it from the Anti-Bot AI for `/wp-json/`. In practice a single address making authenticated, well-formed requests with the `AstonPublisher/1.0` user-agent is rarely challenged even before that.

## Operating it

- Logs: `journalctl -u caddy -f` (or `docker compose logs -f`). Caddy logs to stderr on purpose; a file log needs `/var/log/caddy` writable by the `caddy` user and is easy to break.
- Rotate the key: change `RELAY_KEY` in `/etc/caddy/wp-relay.env`, `systemctl restart caddy`, update `WP_RELAY_KEY` in Vercel, redeploy.
- Updates: `apt-get upgrade caddy` (or `docker compose pull && docker compose up -d`).
- Turn it off: remove `WP_API_URL` from Vercel and redeploy; the app talks to the site directly again.

Security model: only `/wp-json/*` requests carrying the exact `X-Relay-Key` are forwarded; everything else is a 404. The key and all `X-Forwarded-*` headers are stripped before the request reaches WordPress, so the origin sees ordinary requests from the relay's address.
