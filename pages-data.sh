#!/bin/bash
# pages-data.sh - packs the wave cells the location pages need into one zip
# you can download, so the pages can be rebuilt away from the data host after
# a data rebuild (27 Oct 26). Replaces the old harvest page.
#
#   rm -f pages-data.sh
#   wget -q raw.githubusercontent.com/bnhly/seastate-temp/kit/pages-data.sh
#   bash pages-data.sh
#
# Takes the location list from the kit's build_pages.py, keeps every cell
# within 3 degrees of each location from the tiles the page builder would
# search, and writes them as the bundle build_pages.py --bundle reads.
# Nothing on the site changes. "bash pages-data.sh clean" deletes the zip.

set -u
BASE=/root/seastate
WEB=$BASE/webdata
RAW=https://raw.githubusercontent.com/bnhly/seastate-temp/kit
if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
if [ ! -f "$WEB/data/manifest.json" ]; then echo "WRONG SERVER: no $WEB/data here."; exit 1; fi
if [ ! -s "$BASE/stats_token" ]; then echo "no stats token here; run stats.sh first"; exit 1; fi
TOKEN=$(cat "$BASE/stats_token")
OUT="$WEB/stats/$TOKEN-pages.zip"

if [ "${1:-}" = "clean" ]; then rm -f "$OUT"; echo "deleted"; exit 0; fi
if [ -f "$BASE/rebuild/pid" ] && kill -0 "$(cat "$BASE/rebuild/pid")" 2>/dev/null; then
  echo "the rebuild is still running; run this after it finishes"; exit 1
fi
WORK=$(mktemp -d)
curl -fsSL -o "$WORK/build_pages.py" "$RAW/build_pages.py" || { echo "FAILED to fetch build_pages.py"; exit 1; }
mkdir -p "$WEB/stats"

python3 - "$WORK" "$WEB/data" "$OUT" <<'PY'
import json, math, os, sys, zipfile
work, data, out = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, work)
import build_pages as BP
store = BP.TileStore(data)
keep = {}
for loc in BP.LOCATIONS:
    lat, lon = loc[1], loc[2]
    for tid in store.probe_ids(lat, lon):
        t = store.load_tile(tid)
        if not t:
            continue
        s = keep.setdefault(tid, set())
        for c in range(len(t["lat"])):
            dl = abs(((t["lon"][c] - lon + 180) % 360) - 180)
            if abs(t["lat"][c] - lat) <= 3 and dl <= 3 / max(0.2, math.cos(math.radians(lat))):
                s.add(c)
tiles = {}
for tid, cells in keep.items():
    if not cells:
        continue
    t = store.load_tile(tid)
    n = len(t["lat"])
    idx = sorted(cells)
    tt = {}
    for k, v in t.items():
        tt[k] = [v[i] for i in idx] if isinstance(v, list) and len(v) == n else v
    tiles[tid] = tt
mf = dict(store.mf)
mf.pop("tiles", None)
body = json.dumps({"manifest": mf, "tiles": tiles})
tmp = out + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    z.writestr("seastate_location_data.json", body)
    if os.path.exists(os.path.join(data, "assets.json")):
        z.write(os.path.join(data, "assets.json"), "assets.json")
os.chmod(tmp, 0o644)
os.replace(tmp, out)
print("%d locations, %d tiles, %d cells, %.1f MB" % (len(BP.LOCATIONS), len(tiles),
      sum(len(t["lat"]) for t in tiles.values()), os.path.getsize(out) / 1e6))
PY
ok=$?
rm -rf "$WORK"
[ $ok = 0 ] || { echo "FAILED (see above)"; exit 1; }
echo
echo "READY. Open this in your browser to download it, then attach it in the chat:"
echo
echo "    https://seastate-data.thrustm.com/stats/$TOKEN-pages.zip"
echo
echo "Afterwards: bash pages-data.sh clean"
