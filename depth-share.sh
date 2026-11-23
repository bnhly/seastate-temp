#!/bin/bash
# depth-share.sh - what share of the world ocean lies between the surface and
# a given depth (23 Nov 26, Ben: "how much % of the ocean is between 0 and 50m
# depth and also how much between 0 and 600m"). Read only: nothing on the site
# changes.
#
#   rm -f depth-share.sh
#   wget -q raw.githubusercontent.com/bnhly/seastate-temp/kit/depth-share.sh
#   bash depth-share.sh
#
# Source: ETOPO 2022 60 arc-second SURFACE elevation (NOAA NCEI). Surface, not
# bed: the bed grid puts Antarctica's rock under the ice sheet below sea level.
# Ocean = cells below 0 m joined to the world ocean (or to the Black Sea), so
# the Caspian, the Dead Sea, Lake Baikal and the Great Lakes floors are left
# out. Water under floating ice shelves is not counted (the surface there is
# ice above sea level). Each cell weighted by its true area on the WGS84
# authalic sphere (radius 6371.0072 km).

set -u
BASE=${TM_DS_BASE:-/root/seastate}
WORK=$BASE/depth_share
mkdir -p "$WORK"
PY=$BASE/venv/bin/python
[ -x "$PY" ] || PY=python3

NC=${TM_DS_NC:-}
[ -n "$NC" ] || NC=$(find "$BASE" -maxdepth 4 -name 'etopo_60s*.nc' -size +100M 2>/dev/null | head -1)
if [ -z "$NC" ]; then
  NC=$WORK/etopo_60s_surface.nc
  echo "downloading ETOPO 2022 60s surface (about 450 MB)..."
  curl -fsS -o "$NC.part" "https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc" \
    && mv "$NC.part" "$NC" || { echo "download failed"; exit 1; }
fi
echo "using $NC"
$PY -c "import scipy" 2>/dev/null || $PY -m pip -q install scipy || { echo "could not install scipy"; exit 1; }

$PY - "$NC" <<'PY'
import sys, math
import numpy as np
import netCDF4
from scipy import ndimage

ds = netCDF4.Dataset(sys.argv[1])
vn = [k for k, v in ds.variables.items() if v.ndim == 2][0]
z = ds.variables[vn]
lat = np.asarray(ds.variables["lat"][:], dtype=np.float64)
nlat, nlon = z.shape
title = getattr(ds, "title", "") or ""
print("grid %d x %d, variable %s %s" % (nlat, nlon, vn, title[:60]))
if "bed" in sys.argv[1].lower() or "bed" in title.lower():
    print("WARNING: this looks like the BED grid; the answer counts rock under Antarctic ice. Tell Claude.")

# connectivity at 2 arc-minutes: a coarse cell is water if ANY of its four
# 1-minute cells is below 0, so narrow straits stay open
K = 2
wet2 = np.zeros((nlat // K, nlon // K), dtype=bool)
SL = 1200
for r0 in range(0, nlat, SL):
    r1 = min(nlat, r0 + SL)
    b = np.asarray(z[r0:r1, :], dtype=np.float32) < 0
    wet2[r0 // K:r1 // K] = b.reshape((r1 - r0) // K, K, nlon // K, K).any(axis=(1, 3))
st = np.ones((3, 3), dtype=bool)
lab, n = ndimage.label(wet2, structure=st)
# join across the dateline
left, right = lab[:, 0], lab[:, -1]
pairs = set((a, b) for a, b in zip(left, right) if a and b and a != b)
par = list(range(n + 1))
def find(a):
    while par[a] != a:
        par[a] = par[par[a]]
        a = par[a]
    return a
for a, b in pairs:
    ra, rb = find(a), find(b)
    if ra != rb:
        par[rb] = ra
root = np.array([find(i) for i in range(n + 1)])
lab = root[lab]

def cell_of(la, lo):
    i = int((la - lat[0]) / (lat[1] - lat[0])) // K
    j = int((lo + 180.0) * nlon / 360.0) // K
    return lab[min(max(i, 0), lab.shape[0] - 1), min(max(j, 0), lab.shape[1] - 1)]

keep = set()
for name, la, lo in [("Pacific", 0.0, -150.0), ("Atlantic", 0.0, -30.0), ("Indian", -20.0, 80.0),
                     ("Southern", -60.0, 0.0), ("Arctic", 85.0, 0.0), ("Mediterranean", 35.0, 18.0),
                     ("Black Sea", 43.0, 34.0), ("Red Sea", 20.0, 38.5), ("Baltic", 58.0, 20.0),
                     ("Persian Gulf", 27.0, 51.0), ("Hudson Bay", 60.0, -85.0)]:
    c = cell_of(la, lo)
    print("  %-14s component %s" % (name, c if c else "NOT WATER"))
    if c:
        keep.add(c)
for name, la, lo in [("Caspian", 42.0, 51.0), ("Baikal", 53.5, 108.0), ("Lake Superior", 47.7, -87.5)]:
    c = cell_of(la, lo)
    print("  %-14s component %s (left out%s)" % (name, c, ", BUT JOINED TO THE OCEAN" if c in keep else ""))
ocean2 = np.isin(lab, list(keep))

R = 6371.0072  # km, authalic
dlat = abs(lat[1] - lat[0])
dlon = 360.0 / nlon
EDGES = [0, 10, 20, 30, 50, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 12000]
area = np.zeros(len(EDGES) - 1)
total = 0.0
for r0 in range(0, nlat, SL):
    r1 = min(nlat, r0 + SL)
    d = -np.asarray(z[r0:r1, :], dtype=np.float32)
    m = (d > 0) & np.repeat(np.repeat(ocean2[r0 // K:r1 // K], K, axis=0), K, axis=1)
    la = lat[r0:r1]
    a_row = (R * R) * math.radians(dlon) * np.abs(
        np.sin(np.radians(np.clip(la + dlat / 2, -90, 90))) - np.sin(np.radians(np.clip(la - dlat / 2, -90, 90))))
    w = np.broadcast_to(a_row[:, None], d.shape)[m]
    dd = d[m]
    total += w.sum()
    idx = np.searchsorted(EDGES, dd, side="left") - 1
    idx = np.clip(idx, 0, len(EDGES) - 2)
    area += np.bincount(idx, weights=w, minlength=len(EDGES) - 1)

print()
print("World ocean area: %.1f million km2 (published ETOPO1 figure 361.9)" % (total / 1e6))
print("depth band       million km2   share   share from surface")
cum = 0.0
for i in range(len(EDGES) - 1):
    cum += area[i]
    print("%5d - %5d m   %9.2f   %5.2f%%   0 - %d m: %5.2f%%" % (
        EDGES[i], EDGES[i + 1], area[i] / 1e6, 100 * area[i] / total, EDGES[i + 1], 100 * cum / total))
PY
