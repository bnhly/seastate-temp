#!/bin/bash
# tls.sh - https for the Sea State data host (seastate-data.thrustm.com).
#
# Typed from the Hetzner web console, which drops the Shift key (so no
# _ > & | : in what is typed):
#   curl -fsSL -L raw.githubusercontent.com/bnhly/seastate-temp/kit/tls.sh -o tls.sh
#   bash tls.sh
#
# Checks the DNS record points at this server, asks Let's Encrypt for the
# certificate (skipped when one exists), then runs harden.sh so the https
# server block, gate and CORS are written. Safe to run again.
set -u
HOST=seastate-data.thrustm.com
MYIP=$(curl -s -m 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4)
[ -n "$MYIP" ] || MYIP=157.180.46.224
if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
command -v dig >/dev/null 2>&1 || apt-get install -y -q dnsutils >/dev/null 2>&1
DNSIP=$(dig +short A $HOST @1.1.1.1 | tail -1)
if [ "$DNSIP" != "$MYIP" ]; then
  echo "NOT YET: $HOST points at '${DNSIP:-nothing}', this server is $MYIP."
  echo "The DNS record has not reached the internet yet. Wait 15 minutes and run: bash tls.sh"
  exit 1
fi
echo "DNS OK: $HOST points at this server ($MYIP)."
if [ -f /etc/letsencrypt/live/$HOST/fullchain.pem ]; then
  echo "Certificate already there."
else
  command -v certbot >/dev/null 2>&1 || apt-get install -y -q certbot python3-certbot-nginx >/dev/null 2>&1
  pkill -f tls_watch.sh 2>/dev/null
  if ! certbot --nginx -d $HOST --non-interactive --agree-tos \
       --register-unsafely-without-email --redirect; then
    echo "FAILED: Let's Encrypt did not issue the certificate. Send Claude a screenshot of the lines above."
    exit 1
  fi
  echo "Certificate issued."
fi
[ -f harden.sh ] || curl -fsSL -L https://raw.githubusercontent.com/bnhly/seastate-temp/kit/harden.sh -o harden.sh
bash harden.sh
code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 https://$HOST/status.txt)
cors=$(curl -s -m 10 -D - -o /dev/null -H "Origin: https://seastate.thrustm.com" https://$HOST/data/manifest.json | grep -i "access-control-allow-origin" | tr -d '\r')
if [ "$code" = 200 ]; then
  echo "HTTPS OK: https://$HOST/status.txt answers. ${cors:-no CORS header seen}"
  echo "Tell Claude: tls done."
else
  echo "HTTPS NOT ANSWERING (code $code). Send Claude a screenshot."
fi
