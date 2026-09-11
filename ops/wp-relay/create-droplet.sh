#!/usr/bin/env bash
# ops/wp-relay/create-droplet.sh — create the relay droplet with doctl.
#
#   ops/wp-relay/create-droplet.sh <relay-key> [relay-host] [region] [size]
#
# Defaults: sslip.io hostname (no DNS needed), region nyc3 (nearest to Vercel
# iad1), size s-1vcpu-512mb-10gb (~$4/month), Ubuntu 24.04, every SSH key on
# the account attached. Requires `doctl auth init` to have been run.
set -euo pipefail
KEY="${1:?relay key required (openssl rand -hex 32)}"
HOST="${2:-}"; REGION="${3:-nyc3}"; SIZE="${4:-s-1vcpu-512mb-10gb}"
HERE="$(cd "$(dirname "$0")" && pwd)"
USERDATA="$(sed -e "s|__RELAY_KEY__|${KEY}|" -e "s|__RELAY_HOST__|${HOST}|" "${HERE}/cloud-init.sh")"
SSH_KEYS="$(doctl compute ssh-key list --format ID --no-header | paste -sd, -)"
echo "→ creating droplet wp-relay in ${REGION} (${SIZE})${SSH_KEYS:+ with SSH keys ${SSH_KEYS}}"
doctl compute droplet create wp-relay \
  --region "${REGION}" --size "${SIZE}" --image ubuntu-24-04-x64 \
  ${SSH_KEYS:+--ssh-keys "${SSH_KEYS}"} \
  --user-data "${USERDATA}" --tag-names wp-relay \
  --wait --format ID,Name,PublicIPv4,Region,Status
IP="$(doctl compute droplet list --tag-name wp-relay --format PublicIPv4 --no-header | head -1)"
echo
echo "Droplet IP: ${IP}"
echo "Relay URL : https://${HOST:-${IP//./-}.sslip.io}"
echo "First boot installs Caddy (2–3 minutes). Then: curl -si https://${HOST:-${IP//./-}.sslip.io}/wp-json/ | head -1   → expect HTTP/2 404"
