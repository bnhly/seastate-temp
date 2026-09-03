#!/bin/bash
# Team preview: serve the site itself from the data host over plain HTTP.
# The public site is untouched; this copies the page files next to the
# data so http://<host-ip>/ shows the complete new experience.
set -e
git clone -q --depth 1 https://github.com/bnhly/seastate-temp /root/s
cp /root/s/*.html /root/s/*.js /root/s/*.css /root/seastate/webdata/
cp -r /root/s/assets /root/seastate/webdata/ 2>/dev/null || true
rm -rf /root/s
IP=$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4)
echo "PREVIEW READY - open http://${IP:-<this server ip>}/"
