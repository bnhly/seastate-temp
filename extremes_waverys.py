#!/usr/bin/env python3
"""Sea State Explorer extremes from WAVERYS: return-period significant wave
heights and the zero-crossing period (6 Nov 26, Ben: "we should do A", then
"Can we add 100 year and similar info?").

The main build (build_dataset_waverys.py) keeps only how often each height
occurs, so each year's biggest storm is gone. This is a SECOND pass over the
same WAVERYS record that keeps, for every 0.2 deg cell and every month:

  - the largest Hs of the month, with the peak period (VTPK) and the
    zero-crossing period (VTM02, Tm02) of that same 3-hour sea state;
  - a histogram of Tz (0.5 s bins, 1 to 15 s) for the period chart;
  - the day of the month that maximum fell on, and the primary swell Hs in
    that same sea state (6 Nov 26, Ben: "do 1 and the free ones");
  - the primary swell (VHM0_SW1, its mean period VTM01_SW1 and direction
    VMDR_SW1) and the wind sea (VHM0_WW): a swell Hs histogram in three
    period classes, a swell direction rose and the mean swell and wind-sea
    heights, per calendar month.

From those the emitter works out, per cell (fit_cells below):

  - 10, 50 and 100-year Hs: annual maxima, Gumbel distribution fitted by
    the method of moments, DNV-RP-C205 (Sep 2019, amended Sep 2021) 3.6.2.4
    and 3.7.1.3. The year runs summer to summer (3.6.2.5): July to June in
    the northern hemisphere, January to December in the southern. At least
    20 complete years (3.6.2.5), else no value. Euler's constant is taken as
    0.5772: the RP's "mu = U + 0.557A" reads as a misprint of it.
  - a 90% range from the standard error of the moment-fitted Gumbel quantile
    (Kite 1977: SE = s / sqrt(n) * sqrt(1 + 1.1396 K + 1.1 K^2)). Statistical
    sampling error only; it says nothing about model error.
  - the peak and zero-crossing periods in the annual-maximum sea states:
    median, 10th and 90th percentile (3.7.1.3, "varied within a period band
    about the mean or median period").
  - the same Gumbel fit by season (December to February, March to May, June
    to August, September to November), from the maxima of those three months
    each year: the season's own 10, 50 and 100-year Hs for planning work in
    that season. Same 20-year minimum.
The 1-year Hs (3.7.1.2) and the second-method check (3-parameter Weibull on
all sea states, 3.6.2.1 / 3.6.1.8, compared as 3.6.2.4 asks) come from the
main checkpoint's Hs histogram and are worked out in build_dataset_waverys.

Usage (build server, 16 GB is enough, transfer-limited, days):
  python3 extremes_waverys.py --download --years 1980-2023 --workdir ~/x_work
  python3 extremes_waverys.py --pack --workdir ~/x_work      # -> x_work/extremes.zip
  python3 extremes_waverys.py --selftest                      # maths checks, no download
  python3 extremes_waverys.py --prepare --workdir wav_work/ex   # data host, before the emit
The emitter reads the unpacked x_work through --extremes-workdir.
"""

import argparse
import hashlib
import json
import math
import os
import sys
import zipfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_dataset_waverys as W   # noqa: E402  grid, window, dataset id

X_VARS = ["VHM0", "VTPK", "VTM02", "VHM0_SW1", "VTM01_SW1", "VMDR_SW1", "VHM0_WW"]
TZ_T0 = 1.0
TZ_BIN = 0.5
TZ_NB = 28                      # 1.0 .. 15.0 s, top bin open
EULER = 0.5772156649
RETURN_YEARS = [10, 50, 100]
MIN_YEARS = 20                  # DNV-RP-C205 3.6.2.5
TZH_FILE = "tz_hist.npz"
TZH_NPY = "tz_hist.npy"
SW_BIN = 0.25
SW_NB = 32                      # 0 .. 8 m, top bin open
SW_TCLS = [8.0, 12.0]           # swell Tm01 class edges: under 8 s, 8 to 12 s, 12 s and over
SW_NC = len(SW_TCLS) + 1
SW_SECT = 12                    # 30 deg sectors, direction the swell comes from
SW_ROSE_MIN = 0.25              # swell under this height has no direction worth counting
SAVE_EVERY = 3                  # months between saves of the histograms (each save is gigabytes)
SEASONS = [("DJF", [(-1, 12), (0, 1), (0, 2)]), ("MAM", [(0, 3), (0, 4), (0, 5)]),
           ("JJA", [(0, 6), (0, 7), (0, 8)]), ("SON", [(0, 9), (0, 10), (0, 11)])]
HIST_KEYS = ("tz_hist", "sw_hist", "sw_rose", "sw_sum", "ww_sum", "ww_n")
MONTH_DIR = "months"


# ---------------------------------------------------------------- accumulate

def new_tz(nlat=None, nlon=None):
    nlat = nlat or W.NLAT
    nlon = nlon or W.NLON
    return {"tz_hist": np.zeros((12, nlat, nlon, TZ_NB), dtype=np.uint16),
            "sw_hist": np.zeros((12, nlat, nlon, SW_NC, SW_NB), dtype=np.uint16),
            "sw_rose": np.zeros((12, nlat, nlon, SW_SECT), dtype=np.uint16),
            "sw_sum": np.zeros((12, nlat, nlon), dtype=np.float32),
            "ww_sum": np.zeros((12, nlat, nlon), dtype=np.float32),
            "ww_n": np.zeros((12, nlat, nlon), dtype=np.uint16),
            "done": []}


def load_tz(workdir):
    p = os.path.join(workdir, TZH_FILE)
    if not os.path.exists(p):
        return new_tz()
    z = np.load(p, allow_pickle=False)
    out = {k: z[k] for k in HIST_KEYS}
    out["done"] = [s for s in z["done"].tolist()]
    return out


def save_tz(workdir, acc):
    tmp = os.path.join(workdir, TZH_FILE + ".tmp")
    with open(tmp, "wb") as fh:
        np.savez_compressed(fh, done=np.array(acc["done"]), **{k: acc[k] for k in HIST_KEYS})
    os.replace(tmp, os.path.join(workdir, TZH_FILE))


def tz_bins(tz):
    return np.clip(((tz - TZ_T0) / TZ_BIN).astype(np.int64), 0, TZ_NB - 1)


def month_extremes(swh, tp, tz, state=None, sw=None, day=None):
    """Running monthly maximum over time slices. swh/tp/tz are (T, rows, cols)
    float32, NaN dry. Returns state {mx, tpm, tzm, swm, dmx}: the largest Hs
    and the Tp / Tz / primary swell Hs of that same time step (the first one
    on a tie), and its day of the month (day: one value per time step)."""
    T = swh.shape[0]
    if state is None:
        shp = swh.shape[1:]
        state = {"mx": np.full(shp, np.nan, np.float32), "tpm": np.full(shp, np.nan, np.float32),
                 "tzm": np.full(shp, np.nan, np.float32), "swm": np.full(shp, np.nan, np.float32),
                 "dmx": np.zeros(shp, np.uint8)}
    for t in range(T):
        h = swh[t]
        better = np.isfinite(h) & ~(h <= state["mx"])     # NaN max counts as smaller
        state["mx"][better] = h[better]
        state["tpm"][better] = tp[t][better]
        state["tzm"][better] = tz[t][better]
        if sw is not None:
            state["swm"][better] = sw[t][better]
        if day is not None:
            state["dmx"][better] = day[t]
    return state


def add_tz_hist(tz_hist_m, tz, swh):
    """Tz histogram for one month (rows, cols, TZ_NB) from (T, rows, cols),
    counted only where Hs is a sea state (same mask as the main build)."""
    rows, cols = swh.shape[1:]
    flat = tz_hist_m.reshape(rows * cols, TZ_NB)
    idx = np.arange(rows * cols, dtype=np.int64)
    for t in range(swh.shape[0]):
        h = swh[t].reshape(-1)
        z = tz[t].reshape(-1)
        ok = np.isfinite(h) & np.isfinite(z)
        np.add.at(flat, (idx[ok], tz_bins(z[ok])), 1)


def sw_class(per):
    return np.searchsorted(np.array(SW_TCLS, np.float32), per, side="right")


def add_swell(acc_m, swh, sw, swt, swd, ww):
    """Swell and wind-sea statistics for one calendar month (acc_m holds that
    month's slices of the accumulator) from (T, rows, cols) arrays, counted
    where Hs is a sea state. A sea state with no swell partition counts as
    swell 0 in the shortest class (it is all wind sea)."""
    rows, cols = swh.shape[1:]
    n = rows * cols
    idx = np.arange(n, dtype=np.int64)
    hist = acc_m["sw_hist"].reshape(n, SW_NC * SW_NB)
    rose = acc_m["sw_rose"].reshape(n, SW_SECT)
    ssum = acc_m["sw_sum"].reshape(n)
    wsum = acc_m["ww_sum"].reshape(n)
    wn = acc_m["ww_n"].reshape(n)
    for t in range(swh.shape[0]):
        ok = np.isfinite(swh[t].reshape(-1))
        h = np.nan_to_num(sw[t].reshape(-1), nan=0.0)
        per = np.nan_to_num(swt[t].reshape(-1), nan=0.0)
        b = np.clip((h / SW_BIN).astype(np.int64), 0, SW_NB - 1)
        cls = sw_class(per)
        np.add.at(hist, (idx[ok], cls[ok] * SW_NB + b[ok]), 1)
        ssum[ok] += h[ok]
        d = swd[t].reshape(-1)
        okd = ok & np.isfinite(d) & (h >= SW_ROSE_MIN)
        sect = (((d[okd] + 15.0) % 360.0) // 30.0).astype(np.int64) % SW_SECT
        np.add.at(rose, (idx[okd], sect), 1)
        w = ww[t].reshape(-1)
        okw = ok & np.isfinite(w)
        wsum[okw] += w[okw]
        wn[okw] += 1


def cm_fetch_month(args, year, month):
    import copernicusmarine
    t0 = "%04d-%02d-01T00:00:00" % (year, month)
    t1 = "%04d-01-01T00:00:00" % (year + 1) if month == 12 else "%04d-%02d-01T00:00:00" % (year, month + 1)
    t1 = str(np.datetime64(t1) - np.timedelta64(1, "h"))
    fname = "x_%04d_%02d.nc" % (year, month)
    kwargs = dict(dataset_id=args.dataset, variables=X_VARS, start_datetime=t0, end_datetime=t1,
                  output_directory=args.workdir, output_filename=fname, overwrite=True)
    try:
        copernicusmarine.subset(**kwargs)
    except TypeError:
        kwargs.pop("overwrite", None)
        try:
            copernicusmarine.subset(force_download=True, **kwargs)
        except TypeError:
            copernicusmarine.subset(**kwargs)
    return os.path.join(args.workdir, fname)


def accumulate_file(tzacc, m, path):
    """One month's netCDF: maxima + Tz histogram, windowed onto our grid with
    the main build's own grid_window (so both passes share one grid)."""
    import xarray as xr
    ds = xr.open_dataset(path)
    w = W.grid_window(ds["latitude"].values, ds["longitude"].values)
    full = (w["r1"] - w["r0"] == W.NLAT and w["c1"] - w["c0"] == W.NLON)
    lat_sl = slice(w["i0"] + w["r0"], w["i0"] + w["r1"])
    lon_sl = slice(w["j0"] + w["c0"], w["j0"] + w["c1"])
    T = ds.sizes["time"]

    def windowed(name, t0, t1):
        sub = ds[name].isel(time=slice(t0, t1), latitude=lat_sl, longitude=lon_sl).values.astype(np.float32)
        if full:
            return sub
        out = np.full((sub.shape[0], W.NLAT, W.NLON), np.nan, dtype=np.float32)
        out[:, w["r0"]:w["r1"], w["c0"]:w["c1"]] = sub
        return out

    times = ds["time"].values.astype("datetime64[s]")
    days = ((times - times.astype("datetime64[M]")) // np.timedelta64(1, "D")).astype(np.int64) + 1
    acc_m = {k: tzacc[k][m] for k in ("sw_hist", "sw_rose", "sw_sum", "ww_sum", "ww_n")}
    state = None
    for t0 in range(0, T, 8):
        t1 = min(T, t0 + 8)
        swh, tp, tz = windowed("VHM0", t0, t1), windowed("VTPK", t0, t1), windowed("VTM02", t0, t1)
        sw, swt = windowed("VHM0_SW1", t0, t1), windowed("VTM01_SW1", t0, t1)
        swd, ww = windowed("VMDR_SW1", t0, t1), windowed("VHM0_WW", t0, t1)
        state = month_extremes(swh, tp, tz, state, sw=sw, day=days[t0:t1])
        add_tz_hist(tzacc["tz_hist"][m], tz, swh)
        add_swell(acc_m, swh, sw, swt, swd, ww)
    ds.close()
    return state, T


def save_month(workdir, key, state):
    d = os.path.join(workdir, MONTH_DIR)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, key + ".npz.tmp")
    with open(tmp, "wb") as fh:
        np.savez_compressed(fh, mx=state["mx"].astype(np.float16), tpm=state["tpm"].astype(np.float16),
                            tzm=state["tzm"].astype(np.float16), swm=state["swm"].astype(np.float16),
                            dmx=state["dmx"])
    os.replace(tmp, os.path.join(d, key + ".npz"))


def check_variables(dataset):
    """Stop before days of downloading if the dataset does not carry every
    variable we ask for (names checked against the Copernicus catalogue).
    A catalogue that cannot be read is not a stop: the first month then
    fails loudly instead."""
    try:
        import copernicusmarine
        r = copernicusmarine.describe(dataset_id=dataset)
        names = set()
        for p in r.products:
            for d in p.datasets:
                for v in d.versions:
                    for pt in v.parts:
                        for sv in pt.services:
                            names.update(x.short_name for x in sv.variables)
    except Exception as e:      # noqa: BLE001
        print("variable check skipped (catalogue not read: %s)" % e, flush=True)
        return
    missing = [v for v in X_VARS if v not in names]
    if names and missing:
        print("STOP: the dataset %s has no %s. It has: %s" % (dataset, ", ".join(missing), ", ".join(sorted(names))),
              flush=True)
        raise SystemExit(3)
    print("variables found in the catalogue: %s" % ", ".join(X_VARS), flush=True)


def run_download(args):
    check_variables(args.dataset)
    y0, y1 = [int(x) for x in args.years.split("-")]
    os.makedirs(args.workdir, exist_ok=True)
    tzacc = load_tz(args.workdir)
    total = (y1 - y0 + 1) * 12
    pending = []
    for year in range(y0, y1 + 1):
        for month in range(1, 13):
            key = "%04d-%02d" % (year, month)
            if key in tzacc["done"]:
                continue
            print("[%s] fetching from CMEMS..." % key, flush=True)
            path = cm_fetch_month(args, year, month)
            sha = hashlib.sha256()
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    sha.update(chunk)
            fbytes = os.path.getsize(path)
            print("[%s] accumulating..." % key, flush=True)
            state, T = accumulate_file(tzacc, month - 1, path)
            save_month(args.workdir, key, state)
            tzacc["done"].append(key)
            pending.append(json.dumps({"month": key, "sha256": sha.hexdigest(), "bytes": fbytes,
                                       "steps": int(T),
                                       "cells_with_max": int(np.isfinite(state["mx"]).sum()),
                                       "global_max_hs": round(float(np.nanmax(state["mx"])), 2)}))
            os.remove(path)
            # the histograms are saved every few months (each save writes
            # gigabytes); a stop in between redoes those months on restart,
            # and the ledger only ever names months the saved file holds
            last = (year == y1 and month == 12)
            if len(pending) >= SAVE_EVERY or last:
                save_tz(args.workdir, tzacc)
                with open(os.path.join(args.workdir, "audit.jsonl"), "a") as fh:
                    fh.write("".join(x + "\n" for x in pending))
                pending = []
            print("[%s] done (%d / %d months)" % (key, len(tzacc["done"]), total), flush=True)
    if pending:
        save_tz(args.workdir, tzacc)
        with open(os.path.join(args.workdir, "audit.jsonl"), "a") as fh:
            fh.write("".join(x + "\n" for x in pending))
    print("Extremes download complete: %d months." % len(tzacc["done"]))


def run_pack(args):
    """One zip for the data host: tz_hist.npz, every month file, the ledger."""
    out = os.path.join(args.workdir, "extremes.zip")
    tmp = out + ".tmp"
    names = [TZH_FILE, "audit.jsonl"] + [os.path.join(MONTH_DIR, f) for f in
                                         sorted(os.listdir(os.path.join(args.workdir, MONTH_DIR)))
                                         if f.endswith(".npz")]
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:   # members are compressed already
        for n in names:
            z.write(os.path.join(args.workdir, n), n)
    os.replace(tmp, out)
    print("packed %d files, %.2f GB -> %s" % (len(names), os.path.getsize(out) / 1e9, out))


# ---------------------------------------------------------------- fit

def month_keys(workdir):
    d = os.path.join(workdir, MONTH_DIR)
    return sorted(f[:-4] for f in os.listdir(d) if f.endswith(".npz"))


def load_months(workdir, r0=0, r1=None):
    """mx, tpm, tzm as float32 [NM, rows, NLON] for grid rows r0..r1, plus the
    month keys. Read band by band so a 16 GB machine copes."""
    keys = month_keys(workdir)
    mx = tpm = tzm = None
    for k, key in enumerate(keys):
        z = np.load(os.path.join(workdir, MONTH_DIR, key + ".npz"))
        a, b, c = z["mx"][r0:r1], z["tpm"][r0:r1], z["tzm"][r0:r1]
        if mx is None:
            shp = (len(keys),) + a.shape
            mx, tpm, tzm = (np.full(shp, np.nan, np.float32) for _ in range(3))
        mx[k], tpm[k], tzm[k] = a, b, c
    return keys, mx, tpm, tzm


def year_layout(keys, north):
    """Year labels and, per year, the 12 indices into keys (or None when a
    month is missing from the span). North: July to June, labelled by the
    July's year; south: January to December (DNV-RP-C205 3.6.2.5, summer to
    summer)."""
    pos = {k: i for i, k in enumerate(keys)}
    years = sorted({int(k[:4]) for k in keys})
    out = []
    for y in years:
        if north:
            ms = ["%04d-%02d" % (y, m) for m in range(7, 13)] + ["%04d-%02d" % (y + 1, m) for m in range(1, 7)]
        else:
            ms = ["%04d-%02d" % (y, m) for m in range(1, 13)]
        if all(m in pos for m in ms):
            out.append((y, [pos[m] for m in ms]))
    return out


def annual_maxima(mx, tpm, tzm, layout, extra=None, keys=None):
    """[NY, rows, cols] annual max Hs with the Tp / Tz of that sea state; NaN
    for a year with any month missing at that cell (sea ice: an incomplete
    year's maximum would be biased low, so it is left out, not used).
    With extra {name: [NM, rows, cols]} also returns, in a dict, each extra
    field at the same sea state; with keys too, "date" = month * 100 + day
    (-1 for none) from extra["dmx"]. layout entries may be any length (a
    season is three months)."""
    NY = len(layout)
    shp = mx.shape[1:]
    am, at, az = (np.full((NY,) + shp, np.nan, np.float32) for _ in range(3))
    ex = {}
    if extra:
        for nm in extra:
            ex[nm] = np.full((NY,) + shp, np.nan, np.float32)
        if keys is not None:
            ex["date"] = np.full((NY,) + shp, -1, np.int32)
    for k, (y, idx) in enumerate(layout):
        blk = mx[idx]                                  # [12, rows, cols]
        full = np.isfinite(blk).all(axis=0)
        pick = np.nanargmax(np.where(np.isfinite(blk), blk, -1.0), axis=0)
        sel = np.take_along_axis(blk, pick[None], 0)[0]
        am[k] = np.where(full, sel, np.nan)
        at[k] = np.where(full, np.take_along_axis(tpm[idx], pick[None], 0)[0], np.nan)
        az[k] = np.where(full, np.take_along_axis(tzm[idx], pick[None], 0)[0], np.nan)
        for nm, arr in (extra or {}).items():
            v = np.take_along_axis(arr[idx], pick[None], 0)[0].astype(np.float32)
            ex[nm][k] = np.where(full, v, np.nan)
        if extra and keys is not None and "dmx" in extra:
            mon = np.array([int(keys[i][5:7]) for i in idx], np.int32)[pick]
            dd = ex["dmx"][k]
            ex["date"][k] = np.where(full & (dd > 0), mon * 100 + np.nan_to_num(dd).astype(np.int32), -1)
    if extra:
        return am, at, az, ex
    return am, at, az


def season_layout(keys, months):
    """Per season: (year, [indices]) for the years with every month present.
    months = [(year offset, month), ...]; December is the previous year's."""
    pos = {k: i for i, k in enumerate(keys)}
    out = []
    for y in sorted({int(k[:4]) for k in keys}):
        ms = ["%04d-%02d" % (y + off, m) for off, m in months]
        if all(m in pos for m in ms):
            out.append((y, [pos[m] for m in ms]))
    return out


def gumbel_mom(am):
    """Moment fit per cell over axis 0 (NaN = missing year). Returns n, mean,
    s (sample, n - 1), A, U."""
    import warnings
    n = np.isfinite(am).sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(np.where(n[None] > 0, am, np.nan), axis=0)
        s = np.nanstd(np.where(n[None] > 1, am, np.nan), axis=0, ddof=1)
    A = s * math.sqrt(6.0) / math.pi        # sigma = 1.283 A
    U = mean - EULER * A                    # mu = U + 0.5772 A
    return n, mean, s, A, U


def gumbel_quantile(U, A, T):
    return U - A * math.log(-math.log(1.0 - 1.0 / T))


def gumbel_se(s, n, T):
    """Kite (1977) standard error of the moment-fitted Gumbel T-year value."""
    K = -(math.sqrt(6.0) / math.pi) * (EULER + math.log(-math.log(1.0 - 1.0 / T)))
    with np.errstate(invalid="ignore", divide="ignore"):
        return s / np.sqrt(n) * math.sqrt(1.0 + 1.1396 * K + 1.1 * K * K)


def fit_cells(am, at, az):
    """Per-cell return values from annual maxima [NY, rows, cols]. Returns a
    dict of float arrays [rows, cols] (NaN = not enough years)."""
    n, mean, s, A, U = gumbel_mom(am)
    ok = n >= MIN_YEARS
    out = {"n": n.astype(np.int32)}
    for T in RETURN_YEARS:
        out["hs%d" % T] = np.where(ok, gumbel_quantile(U, A, T), np.nan)
        out["se%d" % T] = np.where(ok, gumbel_se(s, n, T), np.nan)
    with np.errstate(invalid="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            for nm, arr in (("tp", at), ("tz", az)):
                q = np.nanpercentile(arr, [10, 50, 90], axis=0)
                for k9, p in enumerate((10, 50, 90)):
                    out["%s%d" % (nm, p)] = np.where(ok, q[k9], np.nan)
    return out


# ---------------------------------------------------------------- for the emitter

STACK = ("mx", "tpm", "tzm", "swm", "dmx")
STACK_DT = {"dmx": np.uint8}


def prepare(workdir):
    """The month files as three uncompressed [NM, NLAT, NLON] float16 arrays
    (about 1.6 GB each) read by memory map, so each emit band reads only its
    rows. Rebuilt when the month list changes."""
    keys = month_keys(workdir)
    stamp = os.path.join(workdir, "stack_keys.json")
    if os.path.exists(stamp) and \
            all(os.path.exists(os.path.join(workdir, k + ".npy")) for k in STACK + HIST_KEYS):
        with open(stamp) as fh:
            if json.load(fh) == keys:
                return keys
    mm = {}
    for k in STACK:
        mm[k] = np.lib.format.open_memmap(os.path.join(workdir, k + ".npy.tmp"), mode="w+",
                                          dtype=STACK_DT.get(k, np.float16),
                                          shape=(len(keys), W.NLAT, W.NLON))
    for i, key in enumerate(keys):
        z = np.load(os.path.join(workdir, MONTH_DIR, key + ".npz"))
        for k in STACK:
            mm[k][i] = z[k]
    for k in STACK:
        mm[k].flush()
        del mm[k]
        os.replace(os.path.join(workdir, k + ".npy.tmp"), os.path.join(workdir, k + ".npy"))
    # the histograms too, uncompressed, so the emit maps them instead of
    # holding several more gigabytes next to its own accumulator
    z = np.load(os.path.join(workdir, TZH_FILE), allow_pickle=False)
    for k in HIST_KEYS:
        np.save(os.path.join(workdir, k + ".tmp.npy"), z[k])
        os.replace(os.path.join(workdir, k + ".tmp.npy"), os.path.join(workdir, k + ".npy"))
    del z
    with open(stamp, "w") as fh:
        json.dump(keys, fh)
    return keys


class Extremes(object):
    """What the emitter needs, band by band."""

    def __init__(self, workdir):
        self.workdir = workdir
        self.keys = prepare(workdir)
        self.stack = {k: np.load(os.path.join(workdir, k + ".npy"), mmap_mode="r") for k in STACK}
        self.layout = {True: year_layout(self.keys, True), False: year_layout(self.keys, False)}
        self.h = {k: np.load(os.path.join(workdir, k + ".npy"), mmap_mode="r") for k in HIST_KEYS}
        self.tz_hist = self.h["tz_hist"]
        self.seasons = [(nm, season_layout(self.keys, ms)) for nm, ms in SEASONS]
        self.years = {h: [y for y, _ in self.layout[h]] for h in (True, False)}

    def band(self, r0, r1, north):
        """Annual maxima [NY, rows, cols], their fit, the date of each
        (month * 100 + day, -1 none) and the seasonal fits."""
        mx = np.asarray(self.stack["mx"][:, r0:r1, :], dtype=np.float32)
        tpm = np.asarray(self.stack["tpm"][:, r0:r1, :], dtype=np.float32)
        tzm = np.asarray(self.stack["tzm"][:, r0:r1, :], dtype=np.float32)
        extra = {"swm": np.asarray(self.stack["swm"][:, r0:r1, :], dtype=np.float32),
                 "dmx": np.asarray(self.stack["dmx"][:, r0:r1, :], dtype=np.float32)}
        am, at, az, ex = annual_maxima(mx, tpm, tzm, self.layout[north], extra, self.keys)
        fit = fit_cells(am, at, az)
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            fit["sw50"] = np.where(np.isfinite(fit["hs100"]), np.nanmedian(ex["swm"], axis=0), np.nan)
        seas = []
        for nm, lay in self.seasons:
            sm, st, sz = annual_maxima(mx, tpm, tzm, lay)
            seas.append((nm, fit_cells(sm, st, sz)))
        del mx, tpm, tzm, extra
        return am, fit, ex["date"], seas

    def swell_band(self, r0, r1, valid_b):
        """Per month: swell exceedance permille [12, rows, cols, SW_NC, SW_NB]
        where index c is "period at least SW_TCLS[c - 1]" (c = 0: any period)
        and bin b is "swell Hs at least (b + 1) * SW_BIN"; mean swell and wind
        sea Hs x10; the swell rose in percent."""
        h = self.h["sw_hist"][:, r0:r1].astype(np.int32)          # [12, rows, cols, C, B]
        tot = h.sum(axis=(-1, -2), dtype=np.int64)
        # period floor: classes c and above; height: bins above b
        fl = np.cumsum(h[..., ::-1, :], axis=-2, dtype=np.int32)[..., ::-1, :]
        ex = np.cumsum(fl[..., ::-1], axis=-1, dtype=np.int32)[..., ::-1]
        ex = np.concatenate([ex[..., 1:], np.zeros(ex.shape[:-1] + (1,), np.int32)], axis=-1)
        ok = valid_b & (tot > 0)
        pml = np.floor(1000.0 * ex / np.maximum(tot, 1)[..., None, None] + 0.5).astype(np.int16)
        pml[~ok] = -1
        with np.errstate(divide="ignore", invalid="ignore"):
            msw = np.floor(10.0 * self.h["sw_sum"][:, r0:r1] / tot + 0.5)
            wn = self.h["ww_n"][:, r0:r1].astype(np.float64)
            mww = np.floor(10.0 * self.h["ww_sum"][:, r0:r1] / wn + 0.5)
        msw = np.where(ok, msw, -1).astype(np.int32)
        mww = np.where(ok & (wn > 0), mww, -1).astype(np.int32)
        rs = self.h["sw_rose"][:, r0:r1].astype(np.int32)
        rt = rs.sum(axis=-1, dtype=np.int64)
        rose = np.floor(100.0 * rs / np.maximum(rt, 1)[..., None] + 0.5).astype(np.int16)
        rose[~(ok & (rt > 0))] = -1
        return pml, msw, mww, rose

    def tz_band(self, r0, r1, valid_b):
        """Typical Tz (median, x10, bin centre) and the permille per bin, per
        month, the shape of the main build's tp / th fields."""
        h = self.tz_hist[:, r0:r1, :].astype(np.int32)
        tot = h.sum(axis=-1, dtype=np.int64)
        cum = np.cumsum(h, axis=-1, dtype=np.int32)
        med = np.argmax(cum * 2 >= tot[..., None], axis=-1)
        ok = valid_b & (tot > 0)
        tz_ds = np.floor((TZ_T0 + (med + 0.5) * TZ_BIN) * 10 + 0.5).astype(np.int32)
        tz_ds[~ok] = -1
        pml = np.round(1000.0 * h / np.maximum(tot[..., None], 1)).astype(np.int16)
        pml[~ok] = -1
        return tz_ds, pml


SEA_STATES_PER_YEAR = 2922      # 3-hour sea states, DNV-RP-C205 3.7.1.1


def hs_from_histogram(hs_all, tot_all, hs_bin):
    """From the pooled all-year Hs histogram [rows, cols, NB] (bins of hs_bin
    from 0): the 1-year Hs as the height exceeded by 1 in 2922 sea states
    (DNV-RP-C205 3.7.1.2, interpolated inside the bin), and the 100-year Hs
    from a 3-parameter Weibull fitted to all sea states by least squares on
    the upper half of the distribution (3.6.2.1, 3.6.1.8), the second method
    the RP asks for in 3.6.2.4. NaN where the record is too thin."""
    nb = hs_all.shape[-1]
    edges = hs_bin * np.arange(1, nb + 1)                       # upper bin edges
    tot = tot_all.astype(np.float64)
    cum = np.cumsum(hs_all, axis=-1, dtype=np.int64).astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        Q = (tot[..., None] - cum) / tot[..., None]              # P(Hs > edge)
    # 1-year: first edge where Q <= q1, linear between that edge and the one before
    q1 = 1.0 / SEA_STATES_PER_YEAR
    below = Q <= q1
    b = np.argmax(below, axis=-1)
    has = below.any(axis=-1) & (tot >= 20 * SEA_STATES_PER_YEAR * 0.5)
    Qb = np.take_along_axis(Q, b[..., None], -1)[..., 0]
    Qa = np.where(b > 0, np.take_along_axis(Q, np.maximum(b - 1, 0)[..., None], -1)[..., 0], 1.0)
    ha = np.where(b > 0, edges[np.maximum(b - 1, 0)], 0.0)
    hb = edges[b]
    with np.errstate(divide="ignore", invalid="ignore"):
        frac = (Qa - q1) / (Qa - Qb)
    hs1 = np.where(has, ha + np.clip(frac, 0, 1) * (hb - ha), np.nan)

    # Weibull: ln(-ln Q) = beta ln(h - g) - beta ln(alpha), over edges with
    # Q <= 0.5 and at least 5 sea states above, for a grid of locations g
    cnt_above = tot[..., None] - cum
    use = (Q <= 0.5) & (cnt_above >= 5)
    with np.errstate(divide="ignore", invalid="ignore"):
        Y = np.log(-np.log(np.where(use, Q, 0.5)))
    best_sse = np.full(Q.shape[:-1], np.inf)
    alt = np.full(Q.shape[:-1], np.nan)
    qT = 1.0 / (SEA_STATES_PER_YEAR * 100.0)
    lowest = np.where(use, edges, np.inf).min(axis=-1)
    for g in np.arange(0.0, 3.01, 0.125):
        ok_g = use & (edges > g + 1e-9)
        X = np.log(np.maximum(edges - g, 1e-9))[None, None, :] * np.ones_like(Y)
        w = ok_g.astype(np.float64)
        n = w.sum(axis=-1)
        sx, sy = (w * X).sum(-1), (w * Y).sum(-1)
        sxx, sxy = (w * X * X).sum(-1), (w * X * Y).sum(-1)
        with np.errstate(divide="ignore", invalid="ignore"):
            beta = (n * sxy - sx * sy) / (n * sxx - sx * sx)
            c = (sy - beta * sx) / n
            sse = (w * (Y - (beta[..., None] * X + c[..., None])) ** 2).sum(-1)
            alpha = np.exp(-c / beta)
            h100 = g + alpha * (-math.log(qT)) ** (1.0 / beta)
        good = (n >= 4) & (beta > 0.3) & np.isfinite(h100) & (g < lowest) & (sse < best_sse)
        best_sse = np.where(good, sse, best_sse)
        alt = np.where(good, h100, alt)
    alt = np.where(tot >= 20 * SEA_STATES_PER_YEAR * 0.5, alt, np.nan)
    return hs1, alt


# ---------------------------------------------------------------- self test

def selftest():
    rng = np.random.default_rng(42)
    # 1. the moment fit and its quantile against independent arithmetic
    x = np.array([5.1, 6.3, 5.8, 7.2, 6.0, 5.5, 6.9, 6.1, 5.4, 8.0], np.float64)
    n, mean, s, A, U = gumbel_mom(x[:, None, None])
    A0 = x.std(ddof=1) * math.sqrt(6) / math.pi
    U0 = x.mean() - EULER * A0
    assert abs(float(A[0, 0]) - A0) < 1e-6 and abs(float(U[0, 0]) - U0) < 1e-6
    x100 = U0 - A0 * math.log(-math.log(0.99))
    assert abs(gumbel_quantile(U0, A0, 100) - x100) < 1e-12
    # the RP's relation sigma = 1.283 A
    assert abs(math.pi / math.sqrt(6) - 1.283) < 5e-4
    # frequency-factor form gives the same value: x_T = mean + K s
    K = -(math.sqrt(6) / math.pi) * (EULER + math.log(-math.log(0.99)))
    assert abs((x.mean() + K * x.std(ddof=1)) - x100) < 1e-9
    # textbook value: K for T = 100 under the moment fit is 3.137 (Chow)
    assert abs(K - 3.137) < 2e-3, K
    print("  moment fit, quantile and frequency factor: ok (K100 = %.4f)" % K)

    # 2. Monte Carlo: 44 annual maxima from a known Gumbel, 20 000 cells.
    # The estimate should be nearly unbiased and the 90% range should hold
    # the true value close to 90% of the time.
    U_true, A_true, ncell, NY = 4.0, 0.8, 20000, 44
    g = U_true - A_true * np.log(-np.log(rng.random((NY, 1, ncell))))
    fit = fit_cells(g.astype(np.float32), np.full_like(g, 12.0, np.float32), np.full_like(g, 9.0, np.float32))
    for T in RETURN_YEARS:
        true = U_true - A_true * math.log(-math.log(1 - 1.0 / T))
        est, se = fit["hs%d" % T][0], fit["se%d" % T][0]
        bias = float(np.mean(est) - true)
        cover = float(np.mean(np.abs(est - true) <= 1.645 * se))
        sd = float(np.std(est))
        print("  T=%3d: true %.3f, mean estimate %.3f (bias %+.3f), spread %.3f vs mean SE %.3f, "
              "90%% range holds it %.1f%%" % (T, true, float(np.mean(est)), bias, sd, float(np.mean(se)), 100 * cover))
        assert abs(bias) < 0.02 * true, bias
        assert 0.85 < cover < 0.95, cover
        assert abs(float(np.mean(se)) - sd) < 0.15 * sd
    assert (fit["tp50"] == 12.0).all() and (fit["tz50"] == 9.0).all()

    # 3. years: south = calendar years, north = July to June; a month of ice
    # drops that year at that cell; fewer than 20 years = no value
    keys = ["%04d-%02d" % (y, m) for y in range(1980, 2024) for m in range(1, 13)]
    lay_s, lay_n = year_layout(keys, False), year_layout(keys, True)
    assert len(lay_s) == 44 and len(lay_n) == 43 and lay_n[0][0] == 1980
    assert [keys[i] for i in lay_n[0][1]][0] == "1980-07" and [keys[i] for i in lay_n[0][1]][-1] == "1981-06"
    NM = len(keys)
    mx = np.full((NM, 1, 3), 2.0, np.float32)
    tp = np.full_like(mx, 10.0)
    tz = np.full_like(mx, 7.0)
    # cell 0: the 1990 storm sits in December -> south year 1990, north year 1990 (Jul 90 - Jun 91)
    i_dec90 = keys.index("1990-12")
    mx[i_dec90, 0, :] = 9.0
    tp[i_dec90, 0, :] = 15.0
    # cell 1: sea ice every August -> no complete year anywhere
    for y in range(1980, 2024):
        mx[keys.index("%04d-08" % y), 0, 1] = np.nan
    # cell 2: ice in August of 25 years only -> 19 complete years, below the minimum
    for y in range(1980, 2005):
        mx[keys.index("%04d-08" % y), 0, 2] = np.nan
    am, at, az = annual_maxima(mx, tp, tz, lay_s)
    yrs = [y for y, _ in lay_s]
    assert am[yrs.index(1990), 0, 0] == 9.0 and at[yrs.index(1990), 0, 0] == 15.0
    assert np.isnan(am[:, 0, 1]).all()
    assert int(np.isfinite(am[:, 0, 2]).sum()) == 19
    fit = fit_cells(am, at, az)
    assert int(fit["n"][0, 0]) == 44 and np.isfinite(fit["hs100"][0, 0])
    assert np.isnan(fit["hs100"][0, 1]) and np.isnan(fit["hs100"][0, 2])
    am_n, _, _ = annual_maxima(mx, tp, tz, lay_n)
    assert am_n[[y for y, _ in lay_n].index(1990), 0, 0] == 9.0
    print("  year layout (south calendar, north July-June), ice years left out, 20-year minimum: ok")

    # 4. running maximum keeps the Tp / Tz of the same time step; Tz bins
    swh = np.array([[[1.0, np.nan]], [[3.0, np.nan]], [[2.0, np.nan]]], np.float32)
    tpp = np.array([[[5.0, 1]], [[11.0, 1]], [[7.0, 1]]], np.float32)
    tzz = np.array([[[4.0, 1]], [[8.0, 1]], [[6.0, 1]]], np.float32)
    st = month_extremes(swh[:2], tpp[:2], tzz[:2])
    st = month_extremes(swh[2:], tpp[2:], tzz[2:], st)
    assert st["mx"][0, 0] == 3.0 and st["tpm"][0, 0] == 11.0 and st["tzm"][0, 0] == 8.0
    assert np.isnan(st["mx"][0, 1])
    hist = np.zeros((1, 2, TZ_NB), np.uint16)
    add_tz_hist(hist, tzz, swh)
    assert hist[0, 0].sum() == 3 and hist[0, 1].sum() == 0
    assert hist[0, 0, tz_bins(np.array([8.0]))[0]] == 1 and tz_bins(np.array([0.2, 99.0])).tolist() == [0, TZ_NB - 1]
    print("  running maximum with its periods, Tz histogram: ok")
    # 5. histogram methods on a known 3-parameter Weibull: 44 years of
    # 3-hour sea states drawn from g=0.4, alpha=1.6, beta=1.4
    g0, a0, b0 = 0.4, 1.6, 1.4
    nss = 44 * SEA_STATES_PER_YEAR
    hs = g0 + a0 * (-np.log(rng.random((nss, 6)))) ** (1 / b0)
    hist = np.stack([np.histogram(hs[:, c], bins=np.arange(0, 15.01, 0.25))[0] for c in range(6)])[None]
    hs1, alt = hs_from_histogram(hist, hist.sum(-1), 0.25)
    t1 = g0 + a0 * (math.log(SEA_STATES_PER_YEAR)) ** (1 / b0)
    t100 = g0 + a0 * (math.log(SEA_STATES_PER_YEAR * 100.0)) ** (1 / b0)
    print("  1-year Hs: true %.2f, estimates %s" % (t1, np.round(hs1[0], 2).tolist()))
    print("  100-year Hs (Weibull, all sea states): true %.2f, estimates %s" % (t100, np.round(alt[0], 2).tolist()))
    assert np.all(np.abs(hs1[0] - t1) < 0.06 * t1), hs1
    assert np.all(np.abs(alt[0] - t100) < 0.08 * t100), alt

    # 6. swell and wind sea: one cell, four sea states
    acc = new_tz(1, 2)
    acc_m = {k: acc[k][0] for k in ("sw_hist", "sw_rose", "sw_sum", "ww_sum", "ww_n")}
    swh = np.array([2.0, 2.0, 3.0, np.nan], np.float32).reshape(4, 1, 1) * np.ones((1, 1, 2), np.float32)
    swh[:, 0, 1] = np.nan                                      # cell 1 is land
    sw = np.array([1.1, np.nan, 2.6, 1.0], np.float32).reshape(4, 1, 1) * np.ones((1, 1, 2), np.float32)
    swt = np.array([7.0, np.nan, 13.0, 9.0], np.float32).reshape(4, 1, 1) * np.ones((1, 1, 2), np.float32)
    swd = np.array([350.0, np.nan, 100.0, 0.0], np.float32).reshape(4, 1, 1) * np.ones((1, 1, 2), np.float32)
    ww = np.array([1.5, 2.0, 1.0, 1.0], np.float32).reshape(4, 1, 1) * np.ones((1, 1, 2), np.float32)
    add_swell(acc_m, swh, sw, swt, swd, ww)
    h = acc["sw_hist"][0, 0, 0]
    assert h.sum() == 3 and acc["sw_hist"][0, 0, 1].sum() == 0
    assert h[0, 4] == 1 and h[0, 0] == 1 and h[2, 10] == 1, np.argwhere(h)   # 1.1 m 7 s; none; 2.6 m 13 s
    assert acc["sw_rose"][0, 0, 0, 0] == 1 and acc["sw_rose"][0, 0, 0, 3] == 1   # 350 deg -> N, 100 -> sector 3
    assert abs(float(acc["sw_sum"][0, 0, 0]) - 3.7) < 1e-5
    assert acc["ww_n"][0, 0, 0] == 3 and abs(float(acc["ww_sum"][0, 0, 0]) - 4.5) < 1e-5
    pml, msw, mww, rose = Extremes.swell_band(_Fake(acc), 0, 1, np.ones((12, 1, 2), bool))
    # any period: at or over 0.25 m two of three (1.1, 2.6); 12 s floor: one of three over 2.5 m
    assert pml[0, 0, 0, 0, 0] == 667 and pml[0, 0, 0, 0, 3] == 667 and pml[0, 0, 0, 0, 4] == 333
    assert pml[0, 0, 0, 1, 0] == 333 and pml[0, 0, 0, 2, 9] == 333 and pml[0, 0, 0, 2, 10] == 0
    assert msw[0, 0, 0] == 12 and mww[0, 0, 0] == 15 and pml[0, 0, 1, 0, 0] == -1
    assert rose[0, 0, 0, 0] == 50 and rose[0, 0, 0, 3] == 50
    print("  swell histogram by period class, exceedance with period floors, rose, means: ok")

    # 7. date and swell of the maximum, and seasons
    st = month_extremes(swh[:3], swh[:3], swh[:3], None, sw=sw[:3], day=np.array([4, 9, 21]))
    assert st["mx"][0, 0] == 3.0 and st["dmx"][0, 0] == 21 and abs(st["swm"][0, 0] - 2.6) < 1e-6
    keys = ["%04d-%02d" % (y, m) for y in range(2000, 2003) for m in range(1, 13)]
    mx = np.full((len(keys), 1, 1), 1.0, np.float32)
    dmx = np.full_like(mx, 3.0)
    mx[keys.index("2001-02")] = 5.0
    dmx[keys.index("2001-02")] = 17.0
    lay = year_layout(keys, False)
    am, at, az, ex = annual_maxima(mx, mx, mx, lay, {"dmx": dmx, "swm": mx}, keys)
    assert ex["date"][1, 0, 0] == 217 and ex["date"][0, 0, 0] == 103, ex["date"][:, 0, 0]
    djf = season_layout(keys, SEASONS[0][1])
    assert [y for y, _ in djf] == [2001, 2002] and [keys[i] for i in djf[0][1]] == ["2000-12", "2001-01", "2001-02"]
    sm, _, _ = annual_maxima(mx, mx, mx, djf)
    assert sm[0, 0, 0] == 5.0 and sm[1, 0, 0] == 1.0
    assert len(season_layout(keys, SEASONS[2][1])) == 3
    print("  date of the maximum, swell in it, seasonal years (December joins the next year): ok")
    try:
        import xarray  # noqa: F401
        selftest_file()
    except ImportError:
        print("  (netCDF read test skipped: no xarray here)")
    print("EXTREMES SELF TEST PASS")


class _Fake(object):
    def __init__(self, acc):
        self.h = acc


def selftest_file():
    """A month file on the real CMEMS grid (899 rows from -89.8, as served
    since 2024) through accumulate_file: maxima, day, swell, Tz."""
    import tempfile
    import xarray as xr
    lats = np.round(-89.8 + 0.2 * np.arange(899), 2)
    lons = np.round(-180.0 + 0.2 * np.arange(1800), 2)
    times = np.arange(np.datetime64("2001-03-01T00"), np.datetime64("2001-03-03T00"), np.timedelta64(3, "h"))
    T = len(times)
    base = np.full((T, len(lats), len(lons)), 1.0, np.float32)
    pi, pj = int(round((-40.0 + 89.8) / 0.2)), int(round((150.0 + 180.0) / 0.2))
    hs = base.copy()
    hs[:, pi, pj] = np.linspace(1.0, 2.5, T)
    hs[11, pi, pj] = 6.0                                     # day 2, 09:00
    data = {"VHM0": hs, "VTPK": base * 11.0, "VTM02": base * 7.2, "VHM0_SW1": base * 0.6,
            "VTM01_SW1": base * 12.5, "VMDR_SW1": base * 220.0, "VHM0_WW": base * 0.8}
    data["VHM0_SW1"][11, pi, pj] = 4.0
    d = tempfile.mkdtemp()
    path = os.path.join(d, "x.nc")
    xr.Dataset({k: (("time", "latitude", "longitude"), v) for k, v in data.items()},
               coords={"time": times, "latitude": lats, "longitude": lons}).to_netcdf(path)
    del data, hs, base
    acc = new_tz()
    st, T2 = accumulate_file(acc, 2, path)
    i, j = int(round((-40.0 - W.LAT0) / W.RES)), int(round((150.0 - W.LON0) / W.RES))
    assert T2 == T and st["mx"][i, j] == 6.0 and st["dmx"][i, j] == 2 and st["swm"][i, j] == 4.0
    assert st["tpm"][i, j] == 11.0 and abs(st["tzm"][i, j] - 7.2) < 1e-5
    assert acc["tz_hist"][2, i, j].sum() == T and acc["tz_hist"][2, i, j, tz_bins(np.array([7.2]))[0]] == T
    h = acc["sw_hist"][2, i, j]
    assert h[2].sum() == T and h[2, 2] == T - 1 and h[2, 16] == 1, np.argwhere(h)   # 12.5 s: class 2
    assert acc["sw_rose"][2, i, j, 7] == T and acc["ww_n"][2, i, j] == T
    shutil_rm(d)
    print("  month file on the CMEMS grid: maxima, day, swell, Tz: ok")


def shutil_rm(d):
    import shutil
    shutil.rmtree(d, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", default="./x_work")
    ap.add_argument("--years", default="1980-2023")
    ap.add_argument("--dataset", default=W.WAV_DATASET)
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--pack", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--prepare", action="store_true",
                    help="data host: unpack the month files and histograms into memory-mappable arrays")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    if args.download:
        run_download(args)
    if args.pack:
        run_pack(args)
    if args.prepare:
        keys = prepare(args.workdir)
        print("prepared %d months in %s" % (len(keys), args.workdir))
    if not (args.download or args.pack or args.prepare):
        ap.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
