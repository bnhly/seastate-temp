#!/bin/bash
# Team preview: serve the site itself from the data host over plain HTTP.
# The public site is untouched; this copies the page files next to the
# data so http://<host-ip>/ shows the complete new experience. Re-running
# it also refreshes the page files and the asset layer to the latest
# deploy, so fixes reach the preview with the same two console lines.
IP=$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4)
if [ ! -d /root/seastate/webdata/data ]; then
  echo "WRONG SERVER: this box (${IP:-unknown ip}) is not the data host -"
  echo "no /root/seastate/webdata/data here. Open the console of the DATA"
  echo "HOST (the permanent server, 157.180.46.224) and run this there."
  exit 1
fi
set -e
rm -rf /root/s
git clone -q --depth 1 https://github.com/bnhly/seastate-temp /root/s
cp /root/s/*.html /root/s/*.js /root/s/*.css /root/seastate/webdata/
cp /root/s/og-image.png /root/seastate/webdata/ 2>/dev/null || true
# vendor/ holds pdf-lib (the PDF button read "Could not load the PDF
# library" on the preview until this copied it, 4 Sep 26); locations/ is
# the citable location pages. robots.txt is NOT copied: the host keeps its
# own Disallow-all one.
for d in assets vendor locations; do
  if [ -d /root/s/$d ]; then
    rm -rf /root/seastate/webdata/$d
    cp -r /root/s/$d /root/seastate/webdata/
  fi
done
cp /root/s/data/assets.json /root/seastate/webdata/data/assets.json
rm -rf /root/s
# the host's nginx was set up to serve data files at exact paths, so "/"
# alone 404s; teach it that the bare address means index.html
NG=/etc/nginx/sites-available/seastate
if ! grep -q "index index.html" "$NG"; then
  sed -i 's|try_files $uri =404;|index index.html;\n      try_files $uri $uri/ =404;|' "$NG"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
fi
# ---- keep the preview current by itself (5 Sep 26) ---------------------
# Every site deploy used to need these two console lines again before the
# preview showed it. This installs a sync job that looks at the site repo's
# main branch every 10 minutes and copies the page files when it has moved,
# so the preview follows the site with no console work. It never touches
# the data tiles, status.txt or nginx.
cat > /root/seastate/preview_sync.sh <<'SYNC'
#!/bin/bash
# preview_sync.sh - copy the site's page files to the preview when main moves.
# Installed by preview.sh; runs from cron every 10 minutes. Log: preview_sync.log
REPO=https://github.com/bnhly/seastate-temp
WEB=/root/seastate/webdata
MARK=/root/seastate/preview_synced.sha
LOG=/root/seastate/preview_sync.log
head=$(git ls-remote -q "$REPO" refs/heads/main 2>/dev/null | cut -f1)
[ -n "$head" ] || exit 0
[ -f "$MARK" ] && [ "$(cat "$MARK")" = "$head" ] && exit 0
tmp=$(mktemp -d /root/seastate/psync.XXXXXX)
if git clone -q --depth 1 "$REPO" "$tmp/s" 2>>"$LOG"; then
  cp "$tmp"/s/*.html "$tmp"/s/*.js "$tmp"/s/*.css "$WEB/" 2>>"$LOG"
  cp "$tmp/s/og-image.png" "$WEB/" 2>/dev/null || true
  for d in assets vendor locations; do
    if [ -d "$tmp/s/$d" ]; then rm -rf "$WEB/$d"; cp -r "$tmp/s/$d" "$WEB/"; fi
  done
  [ -f "$tmp/s/data/assets.json" ] && cp "$tmp/s/data/assets.json" "$WEB/data/assets.json"
  echo "$head" > "$MARK"
  echo "$(date -u)  synced page files to $(echo "$head" | cut -c1-10)" >> "$LOG"
fi
rm -rf "$tmp"
SYNC
chmod +x /root/seastate/preview_sync.sh
( crontab -l 2>/dev/null | grep -v preview_sync.sh; echo "*/10 * * * * /root/seastate/preview_sync.sh" ) | crontab -
git ls-remote -q https://github.com/bnhly/seastate-temp refs/heads/main 2>/dev/null | cut -f1 > /root/seastate/preview_synced.sha || true
echo "PREVIEW READY - open http://${IP:-<this server ip>}/"
echo "The preview now follows the site by itself: a sync job checks for a new deploy every 10 minutes (log: /root/seastate/preview_sync.log)."
