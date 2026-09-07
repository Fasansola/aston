#!/usr/bin/env bash
# ops/wp-relay/install.sh — set up the fixed-IP WordPress relay on a fresh
# Ubuntu 22.04/24.04 machine (Caddy + systemd + ufw). Idempotent.
#
#   sudo bash install.sh <relay-host> <origin-host> <acme-email> <relay-key>
#   e.g. sudo bash install.sh wp-relay.aston.ae aston.ae ops@aston.ae "$(openssl rand -hex 32)"
#
# Before running: create a DNS A record <relay-host> → this machine's IPv4
# (DNS only, not proxied through Cloudflare). Let's Encrypt needs ports 80/443.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi
if [ $# -ne 4 ]; then echo "usage: $0 <relay-host> <origin-host> <acme-email> <relay-key>" >&2; exit 1; fi
RELAY_HOST="$1"; WP_ORIGIN_HOST="$2"; ACME_EMAIL="$3"; RELAY_KEY="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "→ installing Caddy"
apt-get update -qq
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg ufw
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

echo "→ writing configuration"
install -m 600 /dev/null /etc/caddy/wp-relay.env
cat > /etc/caddy/wp-relay.env <<ENV
RELAY_HOST=${RELAY_HOST}
WP_ORIGIN_HOST=${WP_ORIGIN_HOST}
ACME_EMAIL=${ACME_EMAIL}
RELAY_KEY=${RELAY_KEY}
ENV
cp "${HERE}/Caddyfile" /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/wp-relay.env\n' > /etc/systemd/system/caddy.service.d/wp-relay.conf
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy

echo "→ validating"
set -a; . /etc/caddy/wp-relay.env; set +a
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "→ firewall (SSH, 80, 443)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "→ starting"
systemctl daemon-reload
systemctl enable caddy >/dev/null
systemctl restart caddy
sleep 2
systemctl --no-pager --lines=5 status caddy || true

IP4="$(curl -4 -s https://api.ipify.org || true)"
cat <<DONE

Relay is up.
  Hostname : https://${RELAY_HOST}
  Static IP: ${IP4:-<run: curl -4 https://api.ipify.org>}   ← the address to give SiteGround

Next, in Vercel → Settings → Environment Variables (Production):
  WP_API_URL   = https://${RELAY_HOST}
  WP_RELAY_KEY = (the key you passed to this script; mark it Sensitive)
then redeploy and press Re-check on the dashboard: the WordPress light should read
"REST API reachable via relay".

Test from anywhere (expect JSON, not 404):
  curl -s -u 'WP_USER:APP_PASSWORD' -H 'X-Relay-Key: <key>' 'https://${RELAY_HOST}/wp-json/wp/v2/posts?per_page=1&_fields=id'
Without the key the relay answers 404.
DONE
