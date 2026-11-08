#!/bin/bash
# extremes-check.sh - print the new return values, swell and dates for a few
# known places from the live tiles, so they can be sanity-checked from a
# screenshot (8 Nov 26). Read only.
#
#   rm -f extremes-check.sh
#   wget -q raw.githubusercontent.com/bnhly/seastate-temp/kit/extremes-check.sh
#   bash extremes-check.sh
#
# "bash extremes-check.sh map" prints instead where the two 100-year methods
# (Gumbel on yearly maxima, Weibull on every sea state) differ by over 15%.

set -u
DATA=${TM_XC_DATA:-/root/seastate/webdata/data}
if [ ! -f "$DATA/manifest.json" ]; then echo "no tiles at $DATA"; exit 1; fi
python3 - "$DATA" "${1:-}" <<'PY'
import json, math, os, sys
data, mode = sys.argv[1], sys.argv[2]
mf = json.load(open(os.path.join(data, "manifest.json")))
rv = mf.get("rv")
if not rv:
    print("these tiles carry no return values"); sys.exit(0)
F, SF = rv["fields"], rv["srv_fields"]
sw = mf["swell"]
NTs, NF = len(sw["thresholds"]), len(sw["period_floors"])
MON = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()

def tile(lat, lon):
    la = int(math.floor((lat + 90) / 5.0)) * 5 - 90
    lo = int(math.floor((lon + 180) / 5.0)) * 5 - 180
    p = os.path.join(data, "x_%d_%d.json" % (la, lo))
    return json.load(open(p)) if os.path.exists(p) else None

def nearest(lat, lon):
    best = None
    for dla in (-5, 0, 5):
        for dlo in (-5, 0, 5):
            t = tile(lat + dla, lon + dlo)
            if not t:
                continue
            for c in range(len(t["lat"])):
                if not t["rv"][c] or t["rv"][c][F.index("hs100")] < 0:
                    continue
                d = (t["lat"][c] - lat) ** 2 + ((t["lon"][c] - lon) * math.cos(math.radians(lat))) ** 2
                if best is None or d < best[0]:
                    best = (d, t, c)
    return best

def f(v):
    return "-" if v < 0 else "%.1f" % (v / 10.0)

if mode == "map":
    bins = {}
    tot = {}
    for tid in mf["tiles"]:
        p = os.path.join(data, "x" + tid[1:] + ".json")
        if not os.path.exists(p):
            continue
        t = json.load(open(p))
        for c in range(len(t["lat"])):
            r = t["rv"][c]
            if not r or r[F.index("hs100")] < 0 or r[F.index("alt100")] < 0:
                continue
            k = (int(math.floor(t["lat"][c] / 20.0)) * 20, int(math.floor(t["lon"][c] / 40.0)) * 40)
            tot[k] = tot.get(k, 0) + 1
            g, w = r[F.index("hs100")], r[F.index("alt100")]
            if abs(w - g) > 0.15 * g:
                bins.setdefault(k, [0, 0])
                bins[k][0 if w > g else 1] += 1
    print("Where Weibull and Gumbel 100-year differ by over 15% (20 x 40 deg boxes, worst 18):")
    print("  box (lat, lon)     cells  differ  Weibull higher / lower")
    rows = sorted(bins.items(), key=lambda kv: -(kv[1][0] + kv[1][1]) / float(tot[kv[0]]))
    for k, (hi, lo) in rows[:18]:
        n = tot[k]
        print("  %4d, %5d   %8d  %5.1f%%   %d / %d" % (k[0], k[1], n, 100.0 * (hi + lo) / n, hi, lo))
    sys.exit(0)

PLACES = [("Thylacine, Bass Strait W", -39.0, 143.0), ("Kingfish, Gippsland", -38.6, 148.2),
          ("Gorgon, NW Shelf", -20.4, 114.8), ("Browse basin", -14.0, 122.0),
          ("Northern North Sea", 61.0, 1.5), ("Gulf of Mexico", 27.0, -90.0),
          ("Southern Ocean", -50.0, 140.0)]
print("data %s, maxima %s, %d years N / %d S" % (mf["data_id"], rv["span"], len(rv["years_n"]), len(rv["years_s"])))
print("Hs m: 1yr, 10 / 50 / 100yr (+-90%), n yrs, Tp Tz at peaks, Weibull100, swell at peaks")
for name, la, lo in PLACES:
    b = nearest(la, lo)
    if not b:
        print("%-25s no cell" % name); continue
    _, t, c = b
    r = dict(zip(F, t["rv"][c]))
    ram = [v for v in t["ram"][c] if v >= 0]
    yrs = rv["years_n"] if t["lat"][c] >= 0 else rv["years_s"]
    top = sorted(range(len(t["ram"][c])), key=lambda k: -t["ram"][c][k])[0]
    md = t["ramd"][c][top]
    yy = yrs[top] + (1 if t["lat"][c] >= 0 and md // 100 < 7 else 0)
    print("%-25s %.1f %.1f | %s, %s / %s / %s (+-%s) n%d | Tp %s Tz %s | W %s | sw %s" % (
        name, t["lat"][c], t["lon"][c], f(r["hs1"]), f(r["hs10"]), f(r["hs50"]), f(r["hs100"]),
        f(1.645 * r["se100"]), r["n"], f(r["tp50"]), f(r["tz50"]), f(r["alt100"]), f(r["sw50"])))
    s = t["srv"][c]
    seas = " ".join("%s %s" % (nm, f(s[k * len(SF) + SF.index("hs100")])) for k, nm in enumerate(rv["seasons"]))
    when = ("%d %s %d" % (md % 100, MON[md // 100 - 1], yy)) if md > 0 else "(date not kept)"
    print("%27s biggest %.1f m on %s; season 100yr: %s" % ("", max(ram) / 10.0, when, seas))
    sm, sx = t["sm"][c], t["sx"][c]
    out = []
    for m in (0, 6):
        b0 = (m * NF) * NTs
        b12 = (m * NF + 2) * NTs
        k1, k2 = sw["thresholds"].index(1.0), sw["thresholds"].index(2.0)
        out.append("%s swell %s wind sea %s, swell>1m %s%% (>12s %s%%), >2m %s%%" % (
            MON[m], f(sm[2 * m]), f(sm[2 * m + 1]), f(sx[b0 + k1]), f(sx[b12 + k1]), f(sx[b0 + k2])))
    print("%27s %s" % ("", " | ".join(out)))
PY
