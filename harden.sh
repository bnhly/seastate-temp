#!/bin/bash
# harden.sh - Sea State data host: request gate, per-IP rate limit, proper
# CORS and a robots.txt in front of /data/.
#
# WHO RUNS IT: Ben, as root, on the permanent data host
# (seastate-data.thrustm.com, 157.180.46.224), from the Hetzner web console:
#
#   curl -fsSL -L raw.githubusercontent.com/bnhly/seastate-temp/kit/harden.sh -o harden.sh
#   bash harden.sh
#   cat /root/seastate/webdata/status.txt
#
# Takes a few seconds. Safe to run again at any time: it rebuilds the two
# nginx files from scratch on every run, so a second run changes nothing and
# says so. Run it again once the Let's Encrypt certificate exists (tls_watch.sh
# issues it when the DNS record points here) so the https server block gets
# written in the same shape. refresh.sh runs this script at its end when the
# two sit in the same folder.
#
# WHAT IT WRITES
#   /etc/nginx/conf.d/seastate-gate.conf  the http-level pieces: the rate
#                                         limit zone and the three map blocks
#                                         that decide origin / referer
#   /etc/nginx/sites-available/seastate   the server blocks: port 80 always,
#                                         port 443 when the certificate exists
#   /root/seastate/webdata/robots.txt     User-agent: * / Disallow: /
#   /root/seastate/nginx_backup/<time>/   the previous nginx files, kept
#                                         whenever something changed
# Everything the cloud-init server block did is kept: root, index, try_files,
# status.txt uncached, gzip, the 24 h cache header, and the https redirect
# that certbot added for the domain name.
#
# WHAT A CLIENT SEES AFTERWARDS
#   /data/ answers only to requests whose Origin or Referer header is on the
#   allowlist below; anything else gets 403. The four manifests and
#   /status.txt stay open to everyone. Every /data/ request counts against a
#   per-IP rate of 30 requests/s with a burst of 80 (a map click fetches a
#   few tiles), excess gets 429 at once. Allowed origins get their own origin
#   echoed back in Access-Control-Allow-Origin (never "*"), with Vary: Origin
#   so caches keep the answers apart, GET and HEAD only.
#
# WHY THE GATE IS A DETERRENT, NOT A WALL
#   Origin and Referer are written by the client. A one-line curl with a
#   forged Referer walks straight through, and a browser extension can strip
#   the headers. The gate is there for the cheap cases: hotlinking the tiles
#   from another site, a recursive wget of the data folder, scrapers that
#   never bother with headers. That is most of the unwanted traffic. The
#   rate limit is the part that actually protects the machine (one address
#   cannot pull the whole set in a hurry or saturate the link), and the
#   tiles are rebuildable from open data anyway: the moat is the tool, not
#   the JSON. If real abuse shows up, the next step is a Cloudflare rule, not
#   more nginx. Note the limit keys on the connecting address: behind
#   Cloudflare it would need the real_ip module before it means anything.

set -u

HOST=seastate-data.thrustm.com
BASE=/root/seastate
WEB=$BASE/webdata
SITE_CONF=/etc/nginx/sites-available/seastate
GATE_CONF=/etc/nginx/conf.d/seastate-gate.conf
CERT_DIR=/etc/letsencrypt/live/$HOST
FALLBACK_IP=157.180.46.224

status() { echo "$(date -u)  $1" > "$WEB/status.txt"; }

# ---- guards -------------------------------------------------------------
if [ "$(id -u)" != 0 ]; then
  echo "run this as root"; exit 1
fi
if [ ! -d "$WEB/data" ]; then
  echo "WRONG SERVER: no $WEB/data here. Open the console of the DATA HOST"
  echo "(the permanent server, $FALLBACK_IP) and run this there."
  exit 1
fi
if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx is not installed here - is this the data host?"; exit 1
fi

# The host's own address goes on the allowlist for the team preview served
# from this box (preview.sh). Ask the metadata service, fall back to the known
# address, and always keep the known one in case the two ever differ.
MYIP=$(curl -s -m 3 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null)
case "$MYIP" in
  *[!0-9.]*|"") MYIP=$FALLBACK_IP ;;
esac
IPS=$MYIP
[ "$MYIP" = "$FALLBACK_IP" ] || IPS="$MYIP $FALLBACK_IP"

HAVE_CERT=0
[ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ] && HAVE_CERT=1

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---- 1. /etc/nginx/conf.d/seastate-gate.conf (http level) ---------------
# limit_req_zone and map may only live at http level, which on Ubuntu means
# a file under conf.d. The server blocks below refer to the variables and
# the zone defined here.
{
cat <<'EOF'
# Sea State data host: request gate for /data/. Written by harden.sh; edit and
# re-run that script rather than this file.

# Per-IP rate limit for the tile folder. A map click fetches a few tiles;
# 30 requests a second with a burst of 80 leaves real use alone and stops
# one address pulling the whole set in a hurry. Excess answers 429.
limit_req_zone $binary_remote_addr zone=tm_data:10m rate=30r/s;

# Browser origins allowed to read /data/. The matched origin is echoed back
# as Access-Control-Allow-Origin; anything else gets no CORS header at all.
map $http_origin $tm_origin {
    default "";
    "~*^https://seastate\.thrustm\.com$"        $http_origin;
    "~*^https://www\.thrustm\.com$"             $http_origin;
    "~*^https://thrustm\.com$"                  $http_origin;
    "~*^https://[a-z0-9.-]+\.thrustm\.com$"     $http_origin;
    "~*^https://bnhly\.github\.io$"             $http_origin;
    "~*^https://[a-z0-9.-]+\.wixsite\.com$"     $http_origin;
    "~*^https://[a-z0-9.-]+\.wix\.com$"         $http_origin;
    "~*^https://seastate-data\.thrustm\.com$"   $http_origin;
EOF
for ip in $IPS; do
  esc=$(printf '%s' "$ip" | sed 's/\./\\./g')
  printf '    "~*^http://%s$"                  $http_origin;\n' "$esc"
done
cat <<'EOF'
}

# The same list as a Referer check. A page fetching from its own origin sends
# no Origin header at all, only a Referer, so the gate accepts either.
map $http_referer $tm_referer_ok {
    default 0;
    "~*^https://seastate\.thrustm\.com(/|$)"        1;
    "~*^https://www\.thrustm\.com(/|$)"             1;
    "~*^https://thrustm\.com(/|$)"                  1;
    "~*^https://[a-z0-9.-]+\.thrustm\.com(/|$)"     1;
    "~*^https://bnhly\.github\.io(/|$)"             1;
    "~*^https://[a-z0-9.-]+\.wixsite\.com(/|$)"     1;
    "~*^https://[a-z0-9.-]+\.wix\.com(/|$)"         1;
    "~*^https://seastate-data\.thrustm\.com(/|$)"   1;
EOF
for ip in $IPS; do
  esc=$(printf '%s' "$ip" | sed 's/\./\\./g')
  printf '    "~*^http://%s(/|$)"                  1;\n' "$esc"
done
cat <<'EOF'
}

# Deny when neither header vouches for the request. The site config exempts
# the four manifests and /status.txt from this.
map "$tm_origin|$tm_referer_ok" $tm_gate_deny {
    default 0;
    "|0"    1;
}
EOF
} > "$TMP/gate.conf"

# ---- 2. /etc/nginx/sites-available/seastate (server level) --------------
# One body, printed once for port 80 and again for port 443, so the two can
# never drift apart.
server_body() {
cat <<'EOF'
  root /root/seastate/webdata;
  gzip on;
  gzip_types application/json;
  gzip_comp_level 6;
  gzip_min_length 512;
  gzip_vary on;
  add_header Cache-Control "public, max-age=86400" always;

  # progress line for humans and health checks: never cached, always open
  location = /status.txt { add_header Cache-Control "no-store" always; }

  # the four manifests stay readable without a browser header, so a health
  # check or a curious engineer can still see what the service is; rate
  # limited and CORS-echoed like the rest of the data
  location ~ "^/data/(cur/|joint/|cyc/)?manifest\.json$" {
    if ($request_method = OPTIONS) { return 204; }
    limit_req zone=tm_data burst=80 nodelay;
    limit_req_status 429;
    add_header Access-Control-Allow-Origin $tm_origin always;
    add_header Access-Control-Allow-Methods "GET, HEAD" always;
    add_header Vary Origin always;
    add_header Cache-Control "public, max-age=86400" always;
    try_files $uri =404;
  }

  # everything else under /data/: gated, rate limited, CORS for the allowlist
  location /data/ {
    if ($tm_gate_deny) { return 403; }
    if ($request_method = OPTIONS) { return 204; }
    limit_req zone=tm_data burst=80 nodelay;
    limit_req_status 429;
    add_header Access-Control-Allow-Origin $tm_origin always;
    add_header Access-Control-Allow-Methods "GET, HEAD" always;
    add_header Vary Origin always;
    add_header Cache-Control "public, max-age=86400" always;
    try_files $uri =404;
  }

  # page files for the team preview (preview.sh), the coastline, robots.txt
  location / { index index.html; try_files $uri $uri/ =404; }
EOF
}

{
cat <<'EOF'
# Sea State data host. Written by harden.sh; re-run that script to change
# anything here, a hand edit is overwritten on its next run.
server {
  listen 80 default_server;
  server_name seastate-data.thrustm.com;
EOF
if [ "$HAVE_CERT" = 1 ]; then
cat <<'EOF'
  # the domain name goes to https (what certbot --redirect set up); the bare
  # IP address stays on plain http for the team preview
  if ($host = seastate-data.thrustm.com) { return 301 https://$host$request_uri; }
EOF
fi
server_body
echo "}"
if [ "$HAVE_CERT" = 1 ]; then
cat <<EOF
server {
  listen 443 ssl http2 default_server;
  server_name $HOST;
  ssl_certificate $CERT_DIR/fullchain.pem;
  ssl_certificate_key $CERT_DIR/privkey.pem;
EOF
  if [ -f /etc/letsencrypt/options-ssl-nginx.conf ]; then
    echo "  include /etc/letsencrypt/options-ssl-nginx.conf;"
  else
    echo "  ssl_protocols TLSv1.2 TLSv1.3;"
    echo "  ssl_prefer_server_ciphers off;"
  fi
  if [ -f /etc/letsencrypt/ssl-dhparams.pem ]; then
    echo "  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
  fi
  server_body
  echo "}"
fi
} > "$TMP/site.conf"

# ---- 3. robots.txt --------------------------------------------------------
# This box is a data host plus a team preview; nothing here should be
# indexed. preview.sh does not copy the site's robots.txt, so this one stays.
printf 'User-agent: *\nDisallow: /\n' > "$TMP/robots.txt"

# ---- 4. what changes? -----------------------------------------------------
changed=""
cmp -s "$TMP/gate.conf" "$GATE_CONF" 2>/dev/null || changed="$changed gate"
cmp -s "$TMP/site.conf" "$SITE_CONF" 2>/dev/null || changed="$changed site"
cmp -s "$TMP/robots.txt" "$WEB/robots.txt" 2>/dev/null || changed="$changed robots"

echo "=== harden.sh $(date -u) ==="
if [ -z "$changed" ]; then
  echo "nothing to change: gate, site config and robots.txt already match"
else
  BACKUP=$BASE/nginx_backup/$(date -u +%Y%m%d-%H%M%S)
  mkdir -p "$BACKUP"
  for f in "$GATE_CONF" "$SITE_CONF"; do
    [ -f "$f" ] && cp -p "$f" "$BACKUP/"
  done
  echo "previous nginx files kept in $BACKUP"
  for name in gate site robots; do
    case "$name" in
      gate)   old=$GATE_CONF;       new=$TMP/gate.conf ;;
      site)   old=$SITE_CONF;       new=$TMP/site.conf ;;
      robots) old=$WEB/robots.txt;  new=$TMP/robots.txt ;;
    esac
    case " $changed " in
      *" $name "*)
        echo "--- $old"
        if [ -f "$old" ]; then
          diff -u "$old" "$new" | head -120
        else
          echo "(new file, $(wc -l < "$new") lines)"
        fi ;;
    esac
  done
fi

# ---- 5. install, test, reload (restore on a failed test) ------------------
install -m 644 "$TMP/gate.conf" "$GATE_CONF"
install -m 644 "$TMP/site.conf" "$SITE_CONF"
install -m 644 "$TMP/robots.txt" "$WEB/robots.txt"
ln -sf "$SITE_CONF" /etc/nginx/sites-enabled/seastate
rm -f /etc/nginx/sites-enabled/default
chmod 755 /root "$BASE" "$WEB"

if ! nginx -t > "$TMP/nginx_t.log" 2>&1; then
  cat "$TMP/nginx_t.log"
  if [ -n "$changed" ] && [ -d "${BACKUP:-/nonexistent}" ]; then
    for f in "$GATE_CONF" "$SITE_CONF"; do
      if [ -f "$BACKUP/$(basename "$f")" ]; then
        cp -p "$BACKUP/$(basename "$f")" "$f"
      else
        rm -f "$f"
      fi
    done
    nginx -t >/dev/null 2>&1 && echo "previous config restored, nginx untouched"
  fi
  status "FAILED: harden.sh - nginx rejected the new config, previous config kept; copy the nginx -t lines above to Claude"
  exit 1
fi
if ! systemctl reload nginx; then
  status "FAILED: harden.sh - nginx reload failed; run systemctl status nginx and tell Claude"
  exit 1
fi

# ---- 6. self check against the live server -------------------------------
# A reload is asynchronous: the old workers keep answering on the shared
# sockets for a moment while the new ones start, so a probe fired straight
# after the reload can be served by the OLD config (Ben's first run, 4 Sep
# 26: the tile came back 200 with the gate written and tested). Wait until a
# header-less tile request is refused, up to 15 s, before judging anything.
code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$@"; }
[ -f "$WEB/status.txt" ] || status "harden.sh running..."
tile=$(ls "$WEB/data" 2>/dev/null | grep '^t_.*\.json$' | head -1)
if [ -n "$tile" ]; then
  waited=0
  until [ "$(code "http://127.0.0.1/data/$tile")" = 403 ] || [ $waited -ge 15 ]; do
    sleep 1; waited=$((waited + 1))
  done
  echo "new workers answering after ${waited}s"
fi
echo "self check on 127.0.0.1:"
echo "  /data/manifest.json without headers  -> $(code http://127.0.0.1/data/manifest.json)   (want 200)"
echo "  /status.txt without headers          -> $(code http://127.0.0.1/status.txt)   (want 200)"
echo "  /robots.txt                          -> $(code http://127.0.0.1/robots.txt)   (want 200)"
if [ -n "$tile" ]; then
  echo "  /data/$tile without headers  -> $(code "http://127.0.0.1/data/$tile")   (want 403)"
  echo "  same with Origin evil.com            -> $(code -H 'Origin: https://evil.example' "http://127.0.0.1/data/$tile")   (want 403)"
  echo "  same with Origin seastate.thrustm.com -> $(code -H 'Origin: https://seastate.thrustm.com' "http://127.0.0.1/data/$tile")   (want 200)"
  echo "  same with Referer https://www.thrustm.com/x -> $(code -H 'Referer: https://www.thrustm.com/x' "http://127.0.0.1/data/$tile")   (want 200)"
  acao=$(curl -s -m 5 -D - -o /dev/null -H 'Origin: https://seastate.thrustm.com' "http://127.0.0.1/data/$tile" | grep -i '^access-control-allow-origin' | tr -d '\r')
  echo "  CORS header on the allowed request   -> ${acao:-MISSING}"
  # 160 requests fired 20 at a time: sequential curls run at roughly the
  # allowed rate and never trip the limit, which proves nothing
  codes=$(seq 1 160 | xargs -P 20 -I{} curl -s -o /dev/null -m 5 -w '%{http_code}\n' -H 'Origin: https://seastate.thrustm.com' "http://127.0.0.1/data/$tile")
  n200=$(echo "$codes" | grep -c '^200$' || true)
  n429=$(echo "$codes" | grep -c '^429$' || true)
  echo "  rate limit smoke: 160 requests, 20 in parallel -> $n200 x 200, $n429 x 429 (some 429s expected once the burst of 80 is used up)"
  gate_no=$(code "http://127.0.0.1/data/$tile")
  gate_ok=$(code -H 'Origin: https://seastate.thrustm.com' "http://127.0.0.1/data/$tile")
  if [ "$gate_no" = 403 ] && [ "$gate_ok" = 200 ] && [ "$n429" -gt 0 ]; then
    echo "  VERDICT: GATE ACTIVE, RATE LIMIT ACTIVE"
  elif [ "$gate_no" = 403 ] && [ "$gate_ok" = 200 ]; then
    echo "  VERDICT: GATE ACTIVE, rate limit not triggered by this probe (tell Claude the two counts above)"
  else
    echo "  VERDICT: GATE NOT ACTIVE (no headers -> $gate_no, allowed origin -> $gate_ok). Run harden.sh once more; if it says the same, tell Claude."
  fi
else
  echo "  (no t_*.json tile in $WEB/data yet, gate check skipped)"
fi

# ---- 7. summary -----------------------------------------------------------
TLS_NOTE=no
[ "$HAVE_CERT" = 1 ] && TLS_NOTE=yes
echo "HARDEN DONE"
echo "  gate:    $GATE_CONF"
echo "  site:    $SITE_CONF  (https server block: $TLS_NOTE)"
echo "  robots:  $WEB/robots.txt"
echo "  allowed: https://seastate.thrustm.com, https://www.thrustm.com, https://thrustm.com, https://*.thrustm.com,"
echo "           https://bnhly.github.io, https://*.wixsite.com, https://*.wix.com, https://seastate-data.thrustm.com,"
echo "           http://$(echo "$IPS" | sed 's/ /, http:\/\//g')"
echo "  open:    /data/manifest.json, /data/cur/manifest.json, /data/joint/manifest.json, /data/cyc/manifest.json, /status.txt"
if [ "$HAVE_CERT" = 0 ]; then
  echo "  note:    no certificate at $CERT_DIR yet - run harden.sh again once https works"
fi
status "DONE harden $(date -u): /data/ gate + rate limit + CORS live, robots.txt written, https block: $TLS_NOTE. Serving."
