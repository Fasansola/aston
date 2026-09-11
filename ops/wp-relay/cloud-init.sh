#!/bin/bash
# ops/wp-relay/cloud-init.sh — "User data" for a zero-touch relay droplet.
#
# create-droplet.sh fills in the two placeholders and passes this to
# DigitalOcean; it runs once, as root, at first boot. The relay comes up on
# https://<ip-with-dashes>.sslip.io unless a RELAY_HOST is given. Progress:
# /var/log/wp-relay-install.log on the droplet.
set -euo pipefail
RELAY_KEY="__RELAY_KEY__"
RELAY_HOST="__RELAY_HOST__"
WP_ORIGIN_HOST="aston.ae"
ACME_EMAIL=""

export DEBIAN_FRONTEND=noninteractive
exec > >(tee -a /var/log/wp-relay-install.log) 2>&1
echo "wp-relay cloud-init starting $(date -u +%FT%TZ)"
apt-get update -qq
apt-get install -y -qq git curl
IP="$(curl -s -m 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || true)"
[ -n "$IP" ] || IP="$(curl -4 -s https://api.ipify.org)"
[ -n "$RELAY_HOST" ] || RELAY_HOST="${IP//./-}.sslip.io"
git clone --depth 1 https://github.com/Fasansola/aston.git /opt/aston
bash /opt/aston/ops/wp-relay/install.sh "$RELAY_HOST" "$WP_ORIGIN_HOST" "$RELAY_KEY" "$ACME_EMAIL"
echo "WP_RELAY_READY https://$RELAY_HOST $IP"
