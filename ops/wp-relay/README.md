# WordPress fixed-IP relay

A one-file Caddy reverse proxy that gives the blog tool a single, stable
source address for its WordPress REST calls. See the main README, section
"SiteGround anti-bot", for why.

## What you need

- A small always-on machine with a **static IPv4** (DigitalOcean $4–6/mo, Hetzner Cloud CX22/CPX11 €4–5/mo, Vultr, Linode…). Pick a US-East region: the app's functions run in Vercel `iad1` (Washington DC). Ubuntu 24.04.
- A hostname you control pointing at it, e.g. `wp-relay.aston.ae` (A record, **not** proxied through Cloudflare). Let's Encrypt issues the certificate automatically.
- A shared key: `openssl rand -hex 32`.

## Install (about five minutes)

```bash
# on the new machine, as root or with sudo
git clone https://github.com/Fasansola/aston.git && cd aston/ops/wp-relay
sudo bash install.sh wp-relay.aston.ae aston.ae ops@aston.ae '<the key>'
```

The script installs Caddy, writes `/etc/caddy/Caddyfile` and `/etc/caddy/wp-relay.env`, opens ports 22/80/443, starts the service and prints the machine's static IP.

Docker instead: `cp .env.example .env`, fill it in, `docker compose up -d`.

## Point the app at it

In Vercel → Settings → Environment Variables (Production):

| Variable | Value |
|---|---|
| `WP_API_URL` | `https://wp-relay.aston.ae` |
| `WP_RELAY_KEY` | the same key (mark Sensitive) |

Redeploy, then press **Re-check** on the dashboard: the WordPress light should read "REST API reachable via relay". `WP_URL` stays `https://aston.ae` (public links, edit links).

## Tell SiteGround

Give support the relay's IP and ask them to exempt it from the Anti-Bot AI for `/wp-json/`. In practice a single address making authenticated, well-formed requests with the `AstonPublisher/1.0` user-agent is rarely challenged even before that.

## Operating it

- Logs: `/var/log/caddy/wp-relay.log` (or `./logs/` with Docker).
- Rotate the key: change `RELAY_KEY` in `/etc/caddy/wp-relay.env`, `systemctl restart caddy`, update `WP_RELAY_KEY` in Vercel, redeploy.
- Updates: `apt-get upgrade caddy` (or `docker compose pull && docker compose up -d`).
- Turn it off: remove `WP_API_URL` from Vercel and redeploy; the app talks to the site directly again.

Security model: only `/wp-json/*` requests carrying the exact `X-Relay-Key` are forwarded; everything else is a 404. The key and all `X-Forwarded-*` headers are stripped before the request reaches WordPress, so the origin sees ordinary requests from the relay's address.
