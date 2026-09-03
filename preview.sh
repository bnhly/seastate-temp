#!/bin/bash
# Team preview: serve the site itself from the data host over plain HTTP.
# The public site is untouched; this copies the page files next to the
# data so http://<host-ip>/ shows the complete new experience.
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
cp -r /root/s/assets /root/seastate/webdata/ 2>/dev/null || true
rm -rf /root/s
# the host's nginx was set up to serve data files at exact paths, so "/"
# alone 404s; teach it that the bare address means index.html
NG=/etc/nginx/sites-available/seastate
if ! grep -q "index index.html" "$NG"; then
  sed -i 's|try_files $uri =404;|index index.html;\n      try_files $uri $uri/ =404;|' "$NG"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
fi
echo "PREVIEW READY - open http://${IP:-<this server ip>}/"
