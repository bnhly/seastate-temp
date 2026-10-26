#!/usr/bin/env python3
"""Maths check for the Sea State Explorer (26 Oct 26).

Ben: "Do a maths check across the full data set. I am worried about giving
incorrect results to our clients."

verify_dataset.py proves the deployed tiles are exactly what the emitter
derives from the checkpoint. This checks the step after that: the numbers a
client actually reads, which the browser works out from the tiles (months
combined, a limit between two stored heights, the all-year wind, weather
windows). Three layers:

A. CONSISTENCY, every cell of every tile. The fields of one cell must agree
   with each other: exceedance falls as the height rises; the stored mean
   sits inside the bounds the exceedance curve allows; the 1-in-100 and
   1-in-1000 sea states sit where the exceedance crosses 1% and 0.1%; the
   all-year 1-in-100 agrees with the all-year exceedance; the typical peak
   period sits inside the period histogram's middle; the period histogram
   and the direction rose add up; wind top 10% is not below the wind mean;
   the hours in calm spells fit in the calm hours; weather-window periods
   never exceed what the month can hold; the daily cycle averages to the
   monthly mean; sample counts are possible.

B. THE BROWSER'S FORMULAS. `formula_*` below are copies of data.js /
   app.js (combineMonths, interpExceedance, the sample-weighted mean,
   windSummary, extremesSummary, windowPeriodsPerMonth). dev/check_maths_js.js
   runs the SHIPPED data.js on the same cells and this script compares the
   two (--js-out), so layer C measures what the browser really shows.

C. TRUTH (needs the checkpoint): for --sample cells, what the browser shows
   against the exact value from the full record: all-year, season and
   single-month exceedance at limits on and between the stored heights, the
   all-year mean, the all-year 1-in-100 and the all-year wind top 10% (the
   browser averages the monthly figures; the truth pools every sample).
   Reported as error sizes, so "how wrong can a client's number be" has an
   answer in percentage points, metres and m/s.

Usage:
  python3 check_maths.py --data webdata/data                       # A
  python3 check_maths.py --data webdata/data --workdir wav_work \\
      --builder waverys --era5-workdir wav_work --sample 3000      # A + C
Exit code 0 = no FAIL, 1 = a FAIL. Writes --report (markdown) and prints a
short summary that fits a console screen.
"""

import argparse
import json
import math
import os
import random
import sys

MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]   # data.js
WIN_BIN_MEAN_H = [3, 7.5, 16.5, 34.5, 58.5, 94.5, 180]              # data.js
SEASONS = {"all year": list(range(12)), "Jun to Aug": [5, 6, 7], "Dec to Feb": [11, 0, 1],
           "January": [0], "July": [6]}
LIMITS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0, 5.0]


# ---------------------------------------------------------------- decoding

def decode(tile, c, mf):
    """The cell as data.js's TileProvider.query hands it to the page."""
    T = len(mf["thresholds"])
    pm = mf.get("persist") or {"thresholds": [1.0, 1.5, 2.0, 2.5, 3.0], "edges_h": [6, 12, 24, 48, 72, 120]}
    PT, PB = len(pm["thresholds"]), len(pm["edges_h"]) + 1
    d = {"exc": [], "mean": [], "n": [], "tp": None, "ext": None, "wind": None, "windows": None,
         "th": None, "dh": None}
    for m in range(12):
        d["exc"].append([None if v < 0 else v / 10.0 for v in tile["exc"][c][m * T:(m + 1) * T]])
        v = tile["mean"][c][m]
        d["mean"].append(None if v < 0 else v / 10.0)
        d["n"].append(tile["n"][c][m])
    if tile.get("tp") and tile["tp"][c]:
        d["tp"] = [None if v < 0 else v / 10.0 for v in tile["tp"][c]]
    hx = tile.get("hx", [None] * (c + 1))[c] if tile.get("hx") else None
    if hx:
        hxa = tile["hxa"][c] if tile.get("hxa") else None
        d["ext"] = {"p99": [None if hx[2 * m] < 0 else hx[2 * m] / 10.0 for m in range(12)],
                    "p999": [None if hx[2 * m + 1] < 0 else hx[2 * m + 1] / 10.0 for m in range(12)],
                    "p99All": None if not hxa or hxa[0] < 0 else hxa[0] / 10.0,
                    "p999All": None if not hxa or hxa[1] < 0 else hxa[1] / 10.0}
    wm = tile["wm"][c] if tile.get("wm") else None
    w9 = tile["w9"][c] if tile.get("w9") else None
    if wm or w9:
        d["wind"] = {"mean": [wm[m] / 10.0 if wm and wm[m] >= 0 else None for m in range(12)],
                     "p90": [w9[m] / 10.0 if w9 and w9[m] >= 0 else None for m in range(12)]}
    pw = tile["pw"][c] if tile.get("pw") else None
    if pw:
        runs = []
        for m in range(12):
            if pw[m * PT * PB] < 0:
                runs.append(None)
                continue
            runs.append([[pw[m * PT * PB + t * PB + b] / 10.0 for b in range(PB)] for t in range(PT)])
        d["windows"] = {"thr": pm["thresholds"], "edges": pm["edges_h"], "runs": runs}
    th = tile["th"][c] if tile.get("th") else None
    meta = mf.get("tp_hist")
    if th and meta and len(th) == 12 * meta["nb"]:
        d["th"] = [None if th[m * meta["nb"]] < 0 else [x / 10.0 for x in th[m * meta["nb"]:(m + 1) * meta["nb"]]]
                   for m in range(12)]
    dh = tile["dh"][c] if tile.get("dh") else None
    if dh and len(dh) == 96:
        d["dh"] = [[None if dh[m * 8 + s] < 0 else dh[m * 8 + s] / 10.0 for s in range(8)] for m in range(12)]
    return d


# ---------------------------------------------- the browser's formulas (B)

def formula_combine(d, months, thresholds):
    """data.js combineMonths: month-length weighted, masked months left out."""
    used = [m for m in months if d["n"][m] > 0 and d["exc"][m][0] is not None]
    out = []
    for ti in range(len(thresholds)):
        num = den = 0.0
        for m in used:
            v = d["exc"][m][ti]
            if v is None:
                continue
            num += MONTH_DAYS[m] * v
            den += MONTH_DAYS[m]
        out.append(num / den if den > 0 else None)
    return out


def formula_interp(thresholds, p, h):
    """data.js interpExceedance: straight line between stored heights."""
    if p[0] is None:
        return None
    if h <= 0:
        return 100.0
    pts = [(0.0, 100.0)] + [(thresholds[i], p[i]) for i in range(len(thresholds)) if p[i] is not None]
    if h >= pts[-1][0]:
        return pts[-1][1]
    for i in range(1, len(pts)):
        if h <= pts[i][0]:
            a, b = pts[i - 1], pts[i]
            return a[1] + (h - a[0]) / (b[0] - a[0]) * (b[1] - a[1])
    return pts[-1][1]


def interp_alt(thresholds, p, h, how):
    """Candidates for reading between stored heights (not what the browser
    does today; scored in layer C to choose one). log: exceedance falls by a
    steady percentage between heights. weibull: straight in
    log(-log(fraction)) against log(height), exact for a Weibull curve."""
    if p[0] is None:
        return None
    pts = [(0.0, 100.0)] + [(thresholds[i], p[i]) for i in range(len(thresholds)) if p[i] is not None]
    if h >= pts[-1][0]:
        return pts[-1][1]
    for i in range(1, len(pts)):
        if h <= pts[i][0]:
            (h0, p0), (h1, p1) = pts[i - 1], pts[i]
            t = (h - h0) / (h1 - h0)
            lin = p0 + t * (p1 - p0)
            if how == "log" and p0 > 0 and p1 > 0:
                return math.exp(math.log(p0) + t * (math.log(p1) - math.log(p0)))
            if how == "weibull" and h0 > 0 and 0 < p1 < 100 and 0 < p0 < 100:
                y0, y1 = math.log(-math.log(p0 / 100.0)), math.log(-math.log(p1 / 100.0))
                y = y0 + (math.log(h) - math.log(h0)) / (math.log(h1) - math.log(h0)) * (y1 - y0)
                return 100.0 * math.exp(-math.exp(y))
            return lin
    return pts[-1][1]


def formula_mean(d, months):
    """app.js: sample-weighted over the selected months."""
    s = n = 0.0
    for m in months:
        if d["mean"][m] is not None and d["n"][m] > 0:
            s += d["mean"][m] * d["n"][m]
            n += d["n"][m]
    return s / n if n else None


def formula_wind(d, months):
    """data.js windSummary: month-length weighted average of monthly figures."""
    if not d["wind"]:
        return None
    num = den = num9 = den9 = 0.0
    for m in months:
        if d["wind"]["mean"][m] is not None:
            num += MONTH_DAYS[m] * d["wind"]["mean"][m]
            den += MONTH_DAYS[m]
        if d["wind"]["p90"][m] is not None:
            num9 += MONTH_DAYS[m] * d["wind"]["p90"][m]
            den9 += MONTH_DAYS[m]
    if not den and not den9:
        return None
    return {"mean": num / den if den else None, "p90": num9 / den9 if den9 else None}


def formula_windows(d, thr_idx, edge_idx, thresholds):
    """data.js windowPeriodsPerMonth."""
    w = d["windows"]
    if not w:
        return None
    D, thr = w["edges"][edge_idx], w["thr"][thr_idx]
    lows = [0] + list(w["edges"])
    out = []
    for m in range(12):
        if not w["runs"][m] or not d["exc"][m] or not d["n"][m]:
            out.append(None)
            continue
        ex = formula_interp(thresholds, d["exc"][m], thr)
        if ex is None:
            out.append(None)
            continue
        bins = w["runs"][m][thr_idx]
        month_h = MONTH_DAYS[m] * 24
        calm_h = max(0.0, 100 - ex) / 100 * month_h
        short_h = long_n = lo = hi = 0.0
        for b in range(len(bins)):
            if b <= edge_idx:
                short_h += bins[b] * WIN_BIN_MEAN_H[b]
                continue
            long_n += bins[b]
            lo += bins[b] * lows[b]
            hi += bins[b] * (w["edges"][b] if b < len(w["edges"]) else 240)
        long_h = min(hi, max(lo, calm_h - short_h))
        loss_n = long_n - (bins[len(w["edges"])] if len(bins) > len(w["edges"]) else 0) * (calm_h / month_h)
        v = long_h / D - loss_n * (D - 3) / (2 * D)
        floor_v = 0.0
        for b in range(edge_idx + 1, len(bins)):
            floor_v += bins[b] * math.floor(lows[b] / D)
        v = max(floor_v, min(v, long_h / D, math.floor(month_h / D)))
        out.append(math.floor(max(0.0, v) * 10 + 0.5) / 10)   # JS Math.round, not Python round-half-even
    return out


def browser_values(d, mf):
    """Everything layer B compares and layer C judges, for one cell."""
    thr = mf["thresholds"]
    out = {}
    for name, months in SEASONS.items():
        comb = formula_combine(d, months, thr)
        out["exc|" + name] = [formula_interp(thr, comb, h) for h in LIMITS]
        out["alt|log|" + name] = [interp_alt(thr, comb, h, "log") for h in LIMITS]
        out["alt|weibull|" + name] = [interp_alt(thr, comb, h, "weibull") for h in LIMITS]
        out["mean|" + name] = formula_mean(d, months)
        w = formula_wind(d, months)
        out["wind|" + name] = [w["mean"], w["p90"]] if w else None
    if d["ext"]:
        out["p99All"] = d["ext"]["p99All"]
    if d["windows"]:
        pm = d["windows"]
        if 1.5 in pm["thr"] and 24 in pm["edges"]:
            out["win24@1.5"] = formula_windows(d, pm["thr"].index(1.5), pm["edges"].index(24), thr)
    return out


# ---------------------------------------------------------- consistency (A)

class Tally(object):
    def __init__(self):
        self.checks = {}

    def add(self, name, ok, example=""):
        t = self.checks.setdefault(name, {"n": 0, "bad": 0, "ex": []})
        t["n"] += 1
        if not ok:
            t["bad"] += 1
            if len(t["ex"]) < 5 and example:
                t["ex"].append(example)


def consistency(tile, tid, c, mf, d, tally, max_n):
    thr = mf["thresholds"]
    T = len(thr)
    where = "%s cell %d (%.2f, %.2f)" % (tid, c, tile["lat"][c], tile["lon"][c])
    hs_bin = 0.25
    for m in range(12):
        row = tile["exc"][c][m * T:(m + 1) * T]
        if row[0] < 0:
            continue
        vals = [v for v in row if v >= 0]
        tally.add("exceedance falls as height rises", all(vals[k] >= vals[k + 1] for k in range(len(vals) - 1)),
                  "%s month %d %s" % (where, m + 1, vals))
        tally.add("exceedance between 0 and 100%", all(0 <= v <= 1000 for v in vals), where)
        n = tile["n"][c][m]
        tally.add("sample count possible", 0 < n <= max_n[m], "%s month %d n=%d max=%d" % (where, m + 1, n, max_n[m]))
        mean = tile["mean"][c][m]
        if mean >= 0:
            # E[H] = integral of the exceedance curve; with it known only at
            # the stored heights, the mean lies between the lower and upper
            # step sums (tail above the top height bounded by the top value
            # carried to 15 m, where the histogram clamps)
            S = [1.0] + [v / 1000.0 for v in row]
            H = [0.0] + list(thr)
            lo = sum((H[k] - H[k - 1]) * S[k] for k in range(1, len(H)))
            hi = sum((H[k] - H[k - 1]) * S[k - 1] for k in range(1, len(H))) + S[-1] * (15.0 - H[-1])
            tol = 0.05 + 0.0005 * H[-1]
            tally.add("mean inside the bounds of its exceedance curve", lo - tol <= mean / 10.0 <= hi + tol,
                      "%s month %d mean %.1f bounds %.2f to %.2f" % (where, m + 1, mean / 10.0, lo, hi))
        hx = tile.get("hx")
        if hx and hx[c] and hx[c][2 * m] >= 0:
            p99, p999 = hx[c][2 * m] / 10.0, hx[c][2 * m + 1] / 10.0
            ok99 = ok999 = True
            for k, t in enumerate(thr):
                v = row[k]
                if v < 0:
                    continue
                if t >= p99 - 1e-9 and v > 10:
                    ok99 = False
                if t <= p99 - hs_bin + 1e-9 and v < 10:
                    ok99 = False
                if t >= p999 - 1e-9 and v > 1:
                    ok999 = False
                if t <= p999 - hs_bin + 1e-9 and v < 1:
                    ok999 = False
            tally.add("1-in-100 sea state where exceedance crosses 1%", ok99,
                      "%s month %d p99 %.1f exc %s" % (where, m + 1, p99, row))
            tally.add("1-in-1000 sea state where exceedance crosses 0.1%", ok999,
                      "%s month %d p999 %.1f" % (where, m + 1, p999))
            tally.add("1-in-1000 not below 1-in-100", p999 >= p99, where)
        if d["tp"] and d["tp"][m] is not None and d["th"] and d["th"][m]:
            th = d["th"][m]
            tally.add("period histogram adds to 100%", 98.5 <= sum(th) <= 101.5,
                      "%s month %d sum %.1f" % (where, m + 1, sum(th)))
            meta = mf["tp_hist"]
            # the middle band from the stored (rounded) percentages: a month
            # split almost exactly in half (wind sea and swell) can cross 50%
            # one band either side, so accept the bands between 49.4 and 50.6
            cum, b_lo, b_hi = 0.0, None, None
            for b, x in enumerate(th):
                cum += x
                if b_lo is None and cum >= 49.4:
                    b_lo = b
                if b_hi is None and cum >= 50.6:
                    b_hi = b
            if b_hi is None:
                b_hi = len(th) - 1
            if b_lo is not None:
                lo_s = meta["t0"] + b_lo * meta["step"]
                hi_s = meta["t0"] + (b_hi + 1) * meta["step"]
                tally.add("typical period inside the histogram's middle band", lo_s - 0.51 <= d["tp"][m] <= hi_s + 0.51,
                          "%s month %d tp %.1f band %g-%g" % (where, m + 1, d["tp"][m], lo_s, hi_s))
        if tile.get("wr") and tile["wr"][c] and tile["wr"][c][m * 12] >= 0:
            s = sum(tile["wr"][c][m * 12:(m + 1) * 12])
            tally.add("wave direction rose adds to 100%", 92 <= s <= 108, "%s month %d sum %d" % (where, m + 1, s))
        if d["wind"] and d["wind"]["mean"][m] is not None and d["wind"]["p90"][m] is not None:
            tally.add("wind top 10% not below wind mean", d["wind"]["p90"][m] >= d["wind"]["mean"][m],
                      "%s month %d mean %.1f p90 %.1f" % (where, m + 1, d["wind"]["mean"][m], d["wind"]["p90"][m]))
        if d["windows"] and d["windows"]["runs"][m]:
            w = d["windows"]
            lows = [0] + list(w["edges"])
            month_h = MONTH_DAYS[m] * 24
            for ti, t in enumerate(w["thr"]):
                ex = formula_interp(thr, d["exc"][m], t)
                if ex is None:
                    continue
                calm_h = (100 - ex) / 100 * month_h
                spell_h = sum(w["runs"][m][ti][b] * lows[b] for b in range(len(w["runs"][m][ti])))
                # a spell is counted in the month it starts and can run on,
                # and the exceedance between stored heights is a straight
                # line: allow one top-bin spell (240 h) and 5% of the month
                tally.add("hours in calm spells fit in the calm hours", spell_h <= calm_h + 240 + 0.05 * month_h,
                          "%s month %d at %.1f m: spells %.0f h, calm %.0f h" % (where, m + 1, t, spell_h, calm_h))
        if d["dh"] and d["dh"][m] and mean >= 0 and all(v is not None for v in d["dh"][m]):
            dm = sum(d["dh"][m]) / 8.0
            tally.add("daily cycle averages to the monthly mean", abs(dm - mean / 10.0) <= 0.15,
                      "%s month %d cycle %.2f mean %.1f" % (where, m + 1, dm, mean / 10.0))
    if d["windows"]:
        pm = d["windows"]
        for ti in range(len(pm["thr"])):
            for ei, D in enumerate(pm["edges"]):
                if D < 12:
                    continue
                v = formula_windows(d, ti, ei, thr)
                ok = all(x is None or 0 <= x <= math.floor(MONTH_DAYS[m] * 24 / D) for m, x in enumerate(v))
                tally.add("weather-window periods fit in the month", ok, "%s %.1f m %d h %s" % (where, pm["thr"][ti], D, v))
    if d["ext"] and d["ext"]["p99All"] is not None:
        # sea ice: a month with fewer samples than a full month (waves only
        # while the sea is open) weighs differently by month length (the
        # browser's combination) and by sample (the stored all-year figure),
        # and the stored figure also pools months too short to show; those
        # cells are judged on their own line, a known difference, not a fault
        full = all(d["n"][m] >= 0.97 * max_n[m] * (MONTH_DAYS[m] / (29 if m == 1 else MONTH_DAYS[m]))
                   for m in range(12))
        comb = formula_combine(d, list(range(12)), thr)
        p = d["ext"]["p99All"]
        ok = True
        for k, t in enumerate(thr):
            if comb[k] is None:
                continue
            # month-length weighting against the pooled samples: allow 0.15 pp
            if t >= p - 1e-9 and comb[k] > 1.0 + 0.15:
                ok = False
            if t <= p - hs_bin + 1e-9 and comb[k] < 1.0 - 0.15:
                ok = False
        tally.add("all-year 1-in-100 agrees with all-year exceedance" if full else
                  "INFO sea-ice cells: all-year 1-in-100 against all-year exceedance", ok,
                  "%s p99All %.1f all-year exc %s" % (where, p, [None if x is None else round(x, 2) for x in comb]))


# ------------------------------------------------------------- truth (C)

def truth_layer(args, mf, rep, summary):
    import numpy as np
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if args.builder == "waverys":
        import build_dataset_waverys as B
    else:
        import build_dataset_era5 as B
    ck = os.path.join(args.workdir, B.CHECKPOINT if hasattr(B, "CHECKPOINT") else "seastate_accum.npz")
    rep.append("")
    rep.append("## C. What the browser shows against the full record (%d cells)" % args.sample)
    rep.append("Checkpoint `%s`. Truth per cell: exceedance from the 0.25 m histogram (exact at "
               "every limit used here, all on bin edges), month-length weighted for several months "
               "(the time the sea spends above the limit); the mean from the sum of every sample; "
               "the 1-in-100 and wind top 10%% from the pooled histograms with the emitter's own "
               "bin-edge rule, so only the browser's way of combining is being judged." % ck)
    rng = random.Random(20261026)
    cells = []
    tids = list(mf["tiles"])
    rng.shuffle(tids)
    per_tile = max(1, args.sample // max(1, min(len(tids), args.sample)))
    for tid in tids:
        if len(cells) >= args.sample:
            break
        with open(os.path.join(args.data, tid + ".json")) as fh:
            tile = json.load(fh)
        idx = list(range(len(tile["lat"])))
        rng.shuffle(idx)
        for c in idx[:per_tile]:
            d = decode(tile, c, mf)
            if sum(1 for m in range(12) if d["exc"][m][0] is not None) < 12:
                continue      # ice months: the browser leaves them out, keep the check simple
            i = int(round((tile["lat"][c] - B.LAT0) / B.RES))
            j = int(round((tile["lon"][c] - B.LON0) / B.RES))
            cells.append({"tid": tid, "c": c, "lat": tile["lat"][c], "lon": tile["lon"][c],
                          "i": i, "j": j, "d": d, "b": browser_values(d, mf)})
            if len(cells) >= args.sample:
                break
    if not cells:
        rep.append("No cells sampled.")
        return
    I = np.array([x["i"] for x in cells])
    J = np.array([x["j"] for x in cells])
    z = np.load(ck, allow_pickle=False)
    nsamp = z["nsamp"][:, I, J].astype(np.float64)        # [12, K]
    hsum = z["hsum"][:, I, J].astype(np.float64)
    hist = z["hs_hist"][:, I, J, :].astype(np.float64)    # [12, K, NB]
    del z
    hs_bin, nb = B.HS_BIN, hist.shape[-1]
    wind = None
    wpath = os.path.join(args.era5_workdir, "seastate_accum.npz") if args.era5_workdir else None
    if wpath and os.path.exists(wpath):
        zw = np.load(wpath, allow_pickle=False)
        nlat, nlon = zw["wind_hist"].shape[1], zw["wind_hist"].shape[2]
        EI = np.clip(np.round((np.array([x["lat"] for x in cells]) + 90.0) / 0.5).astype(int), 0, nlat - 1)
        EJ = np.clip(np.round(((np.array([x["lon"] for x in cells]) + 180.0) % 360.0) / 0.5).astype(int), 0, nlon - 1)
        wind = {"hist": zw["wind_hist"][:, EI, EJ, :].astype(np.float64),
                "sum": zw["wind_sum"][:, EI, EJ].astype(np.float64),
                "n": zw["wind_n"][:, EI, EJ].astype(np.float64)}
        del zw
    elif args.builder == "era5":
        z = np.load(ck, allow_pickle=False)
        wind = {"hist": z["wind_hist"][:, I, J, :].astype(np.float64),
                "sum": z["wind_sum"][:, I, J].astype(np.float64),
                "n": z["wind_n"][:, I, J].astype(np.float64)}
        del z

    def pct_at_least(hrow, h):
        tot = hrow.sum()
        k = int(round(h / hs_bin))
        return 100.0 * hrow[k:].sum() / tot if tot > 0 else None

    def upper_edge(hrow, q, width):
        tot = hrow.sum()
        need = max(1, int(math.ceil(q * tot)))
        run = 0.0
        for b in range(len(hrow)):
            run += hrow[b]
            if run >= need:
                return (b + 1) * width
        return len(hrow) * width

    errs = {}

    def note(key, e):
        if e is not None:
            errs.setdefault(key, []).append(e)

    for k, x in enumerate(cells):
        for name, months in SEASONS.items():
            tw = [MONTH_DAYS[m] for m in months]
            for li, h in enumerate(LIMITS):
                tv = sum(tw[q] * pct_at_least(hist[m, k], h) for q, m in enumerate(months)) / sum(tw)
                bv = x["b"]["exc|" + name][li]
                on = any(abs(h - t) < 1e-9 for t in mf["thresholds"])
                note("exc %s %s" % (name, "on a stored height" if on else "between stored heights"),
                     None if bv is None else bv - tv)
                if not on:
                    for how in ("log", "weibull"):
                        av = x["b"]["alt|%s|%s" % (how, name)][li]
                        note("alt exc %s between, if read on a %s scale" % (name, how),
                             None if av is None else av - tv)
            tm = hsum[months, k].sum() / nsamp[months, k].sum()
            bm = x["b"]["mean|" + name]
            note("mean %s" % name, None if bm is None else bm - tm)
            if wind is not None and x["b"]["wind|" + name]:
                wh = wind["hist"][months, k, :].sum(axis=0)
                if wh.sum() > 0:
                    t90 = upper_edge(wh, 0.9, 1.0)
                    tmean = wind["sum"][months, k].sum() / max(1.0, wind["n"][months, k].sum())
                    bmn, b90 = x["b"]["wind|" + name]
                    note("wind mean %s" % name, None if bmn is None else bmn - tmean)
                    note("wind top 10%% %s" % name, None if b90 is None else b90 - t90)
        if x["b"].get("p99All") is not None:
            note("1-in-100 all year", x["b"]["p99All"] - upper_edge(hist[:, k, :].sum(axis=0), 0.99, hs_bin))

    units = {"exc": "percentage points", "alt": "percentage points", "mean": "m", "wind": "m/s", "1-in-100": "m"}
    rep.append("")
    rep.append("| Figure | Cells | Typical error | 95%% of cells within | Worst | Unit |".replace("%%", "%"))
    rep.append("|---|---|---|---|---|---|")
    order = sorted(errs.keys(), key=lambda s: (s.split()[0], s))
    for key in order:
        e = sorted(abs(v) for v in errs[key])
        bias = sum(errs[key]) / len(errs[key])
        mae = sum(e) / len(e)
        p95 = e[min(len(e) - 1, int(0.95 * len(e)))]
        unit = units.get(key.split()[0], "")
        rep.append("| %s | %d | %.2f (bias %+.2f) | %.2f | %.2f | %s |" % (key, len(e), mae, bias, p95, e[-1], unit))
        summary.append((key, mae, p95, e[-1], bias, unit))


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="deployed tiles directory (has manifest.json)")
    ap.add_argument("--workdir", help="checkpoint directory: turns on layer C")
    ap.add_argument("--builder", choices=["era5", "waverys"], default="waverys")
    ap.add_argument("--era5-workdir", help="ERA5 checkpoint (the wind graft) for the wind truth")
    ap.add_argument("--sample", type=int, default=3000)
    ap.add_argument("--report", default="maths_check.md")
    ap.add_argument("--js-out", help="dev/check_maths_js.js output to compare with the Python copy (layer B)")
    ap.add_argument("--dump-browser", help="write the Python copy's browser values for a few cells (layer B)")
    ap.add_argument("--max-tiles", type=int, default=0, help="test runs only")
    args = ap.parse_args()

    with open(os.path.join(args.data, "manifest.json")) as fh:
        mf = json.load(fh)
    years = 1.0
    per = str(mf.get("period", ""))
    try:
        a, b = per.split(",")[0].strip().split("-")
        years = int(b) - int(a) + 1
    except Exception:
        years = 50
    max_n = [int(math.ceil(years * (29 if m == 1 else MONTH_DAYS[m]) * 8)) for m in range(12)]

    rep = ["# Sea State Explorer maths check", "",
           "Data: `%s`, %s, %s, grid %s deg, %d tiles." % (args.data, mf.get("source_label") or mf.get("source"),
                                                          mf.get("period"), mf["grid"]["res"], len(mf["tiles"]))]
    tally = Tally()
    cells = 0
    dump = {}
    tids = mf["tiles"][:args.max_tiles] if args.max_tiles else mf["tiles"]
    for tid in tids:
        with open(os.path.join(args.data, tid + ".json")) as fh:
            tile = json.load(fh)
        for c in range(len(tile["lat"])):
            d = decode(tile, c, mf)
            consistency(tile, tid, c, mf, d, tally, max_n)
            cells += 1
            if args.dump_browser and (cells % 37 == 0):
                dump["%s|%d" % (tid, c)] = browser_values(d, mf)
    rep.append("")
    rep.append("## A. Consistency, every cell (%d cells)" % cells)
    rep.append("")
    rep.append("| Check | Tested | Failed | Example |")
    rep.append("|---|---|---|---|")
    fails = 0
    for name, t in tally.checks.items():
        rep.append("| %s | %d | %d | %s |" % (name, t["n"], t["bad"], (t["ex"][0] if t["ex"] else "")))
        if not name.startswith("INFO"):
            fails += t["bad"]
    if args.dump_browser:
        with open(args.dump_browser, "w") as fh:
            json.dump(dump, fh)

    layer_b = None
    if args.js_out:
        with open(args.js_out) as fh:
            js = json.load(fh)
        diffs, n = [], 0
        for key, jv in js.items():
            tid, c = key.split("|")
            with open(os.path.join(args.data, tid + ".json")) as fh:
                tile = json.load(fh)
            pv = browser_values(decode(tile, int(c), mf), mf)
            for k2, jx in jv.items():
                if k2.startswith("alt|"):
                    continue
                px = pv.get(k2)
                fj = jx if isinstance(jx, list) else [jx]
                fp = px if isinstance(px, list) else [px]
                for a, b in zip(fj, fp):
                    n += 1
                    if (a is None) != (b is None) or (a is not None and abs(a - b) > 1e-6):
                        diffs.append("%s %s js %s python %s" % (key, k2, a, b))
        layer_b = (n, diffs)
        rep.append("")
        rep.append("## B. The Python copy against the shipped data.js")
        rep.append("%d values compared, %d differ.%s" % (n, len(diffs), (" First: " + diffs[0]) if diffs else ""))

    summary = []
    if args.workdir:
        truth_layer(args, mf, rep, summary)

    with open(args.report, "w") as fh:
        fh.write("\n".join(rep) + "\n")

    print("MATHS CHECK  %d cells, %d tiles  (%s)" % (cells, len(tids), mf.get("source")))
    print("A consistency: %d checks, %d failed%s" % (sum(t["n"] for t in tally.checks.values()), fails,
                                                    "" if not fails else "  <- see report"))
    for name, t in tally.checks.items():
        if t["bad"] and name.startswith("INFO"):
            print("   %s: %d of %d differ (known, see report)" % (name, t["bad"], t["n"]))
        elif t["bad"]:
            print("   FAIL %s: %d of %d" % (name, t["bad"], t["n"]))
    if layer_b:
        print("B browser formulas: %d values, %d differ" % (layer_b[0], len(layer_b[1])))
    if summary:
        print("C against the full record (typical / 95% of cells within / worst):")
        for key, mae, p95, worst, bias, unit in summary:
            if key.startswith(("exc", "alt")) and not any(w in key for w in ("all year", "Jun", "July")):
                continue
            if key.startswith(("mean", "wind")) and "all year" not in key and "July" not in key:
                continue
            print("   %-52s %5.2f / %5.2f / %5.2f %s" % (key, mae, p95, worst, unit))
    print("report: " + os.path.abspath(args.report))
    sys.exit(1 if fails or (layer_b and layer_b[1]) else 0)


if __name__ == "__main__":
    main()
