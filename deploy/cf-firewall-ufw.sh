#!/usr/bin/env bash
# Restrict inbound HTTP/HTTPS to Cloudflare's published IP ranges, so the
# origin can only be reached through the proxy and the rate limiter's
# CF-Connecting-IP key stays trustworthy.
#
# Run ON THE VPS as root:
#   bash cf-firewall-ufw.sh
#
# Requires: ufw, curl. SSH (port 22) is allowed before anything else, so the
# session this runs in survives. The script adds rules but leaves ufw's
# enabled/disabled state unchanged unless it was already active.
set -euo pipefail

if ! command -v ufw >/dev/null; then
  echo "ufw is not installed (apt install ufw)."
  exit 1
fi

tmp=$(mktemp)
for url in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
  curl -fsS --max-time 20 "$url" >> "$tmp" 2>/dev/null || {
    echo "Could not fetch Cloudflare IP ranges from $url"; exit 1;
  }
  echo >> "$tmp"
done
grep -qE '^[0-9]+\.' "$tmp" || { echo "Fetched ranges look wrong — aborting."; exit 1; }

# never lock ourselves out of SSH
ufw allow ssh >/dev/null 2>&1 || true

echo "Adding allow rules for $(grep -c . "$tmp") Cloudflare ranges..."
while IFS= read -r ip; do
  [ -n "$ip" ] || continue
  if [[ $ip == *:* ]]; then
    ufw allow proto tcp from "$ip" to any port 80,443 comment 'cf-v6' >/dev/null
  else
    ufw allow proto tcp from "$ip" to any port 80,443 comment 'cf-v4' >/dev/null
  fi
done < "$tmp"

# everything else that arrives directly at the web ports is dropped
ufw deny proto tcp from any to any port 80,443 >/dev/null

if ufw status | head -1 | grep -q "inactive"; then
  echo
  echo "Rules added. ufw is currently INACTIVE — review with 'ufw status' and"
  echo "activate with 'ufw enable' when ready (make sure SSH is allowed first)."
else
  ufw reload >/dev/null 2>&1 || true
  echo "Rules added and firewall reloaded."
fi

echo
echo "Verify afterwards: the site loads normally, and 'curl -m 5 https://ORIGIN_IP/'"
echo "(the raw VPS address) times out or is refused."
rm -f "$tmp"
