#!/bin/bash
# video-data.sh - packs the live data a Bass Strait video needs into one zip
# you can download, so it can be recorded away from the data host with the
# real numbers (27 Oct 26, the LinkedIn video).
#
#   rm -f video-data.sh
#   wget -q raw.githubusercontent.com/bnhly/seastate-temp/kit/video-data.sh
#   bash video-data.sh
#
# Puts every manifest, the world map shading, the oil and gas assets and the
# cyclone tracks in, plus each tile of every layer around Bass Strait (tile
# corners 50S to 30S, 130E to 150E). Nothing else changes on the server.
# It prints a link to download the zip from.
# "bash video-data.sh clean" deletes the zip afterwards.

set -u
BASE=/root/seastate
WEB=$BASE/webdata
if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
if [ ! -f "$WEB/data/manifest.json" ]; then echo "WRONG SERVER: no $WEB/data here."; exit 1; fi
if [ ! -s "$BASE/stats_token" ]; then echo "no stats token here; run stats.sh first"; exit 1; fi
TOKEN=$(cat "$BASE/stats_token")
# a new name each run: browsers keep files from this server for a day,
# so a second download from the same address can be the old zip
OUT="$WEB/stats/$TOKEN-video-$(date -u +%H%M%S).zip"

if [ "${1:-}" = "clean" ]; then rm -f "$WEB/stats/$TOKEN-video"*.zip; echo "deleted"; exit 0; fi
rm -f "$WEB/stats/$TOKEN-video"*.zip
if [ -f "$BASE/rebuild/pid" ] && kill -0 "$(cat "$BASE/rebuild/pid")" 2>/dev/null; then
  echo "the rebuild is still running; run this after it finishes (bash rebuild.sh shows it)"; exit 1
fi
mkdir -p "$WEB/stats"

python3 - "$WEB/data" "$OUT" <<'PY'
import os, re, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
TILE = re.compile(r"^[a-z]+_(-?\d+)_(-?\d+)\.json$")
keep = []
for root, dirs, files in os.walk(src):
    for f in files:
        p = os.path.join(root, f)
        rel = os.path.relpath(p, src)
        m = TILE.match(f)
        if m:
            la, lo = int(m.group(1)), int(m.group(2))
            if not (-50 <= la <= -30 and 130 <= lo <= 150):
                continue
        elif not f.endswith(".json"):
            continue
        keep.append((p, rel))
tmp = out + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for p, rel in sorted(keep, key=lambda x: x[1]):
        z.write(p, "data/" + rel)
os.chmod(tmp, 0o644)
os.replace(tmp, out)
print("%d files, %.1f MB" % (len(keep), os.path.getsize(out) / 1e6))
PY
[ $? = 0 ] || { echo "FAILED (see above)"; exit 1; }
echo
echo "READY. Open this in your browser to download it, then attach it in the chat:"
echo
echo "    https://seastate-data.thrustm.com/stats/$(basename "$OUT")"
echo
echo "Afterwards: bash video-data.sh clean"
