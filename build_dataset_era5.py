#!/usr/bin/env python3
"""Build the Sea State Explorer dataset from ERA5 (rich single-pass version).

This is a NORMAL Python script for your own machine or a throwaway VM. It is
not a Frappe server script and never runs inside ERPNext.

The download loop is the expensive part (days of CDS queue time), so this
version extracts everything plausibly needed later in ONE pass. Per month-file
it fetches EIGHT variables on the 0.5 deg grid, 3 hourly:

    swh    significant height of combined wind waves and swell
    shww   significant height of wind waves
    shts   significant height of total swell
    mwp    mean wave period
    pp1d   peak wave period
    mwd    mean wave direction
    u10    10 m wind, u component
    v10    10 m wind, v component

and accumulates, per 0.5 deg cell per calendar month:

    nsamp        sample count (finite swh)
    hsum         sum of Hs                     -> mean Hs
    hs_hist      Hs histogram, 0.25 m bins to 15 m (top bin clamps)
                 -> exceedance at ANY threshold, percentiles, Weibull fits
    joint        Hs x Tp occurrence table (0.5 m x 1 s, peak period)
                 -> the classic metocean scatter table
    rose         wave direction rose, 12 sectors x 4 Hs bands
    wind_hist    wind speed histogram, 1 m/s bins to 40 (+ wind_sum, wind_n)
    mwp_sum, shts_sum, shww_sum   -> mean period, mean swell / wind-sea heights
    persist      calm-spell statistics: for Hs thresholds [1.0 1.5 2.0 2.5 3.0],
                 counts of below-threshold runs by duration bin
                 (<6, 6-12, 12-24, 24-48, 48-72, 72-120, >=120 h; runs are
                 capped and flushed at 240 h; a run is attributed to the month
                 it STARTED in) -> weather-window / workability statistics

The website today uses only exceedance + mean (derived here from hs_hist);
everything else lives in the checkpoint so future features (weather windows,
Hs-Tp scatter, roses, wind stats, swell split) need no new download.

Process months in chronological order (the default loop does): the calm-spell
tracker carries run state across month boundaries. Running a later span first
(e.g. 2010-2024, then 1979-2009) only costs one split run per cell at the seam
between spans, which is negligible.

Memory: the accumulator is ~2.5 GB in RAM (peaks ~5 GB while processing).
Use a 16 GB machine (e.g. Hetzner CX42). The checkpoint file on disk is
~2.5 GB (saved uncompressed after every month for cheap, safe resume).

Setup for a real run:
    1. Free account at https://cds.climate.copernicus.eu
    2. Accept the licence on the "ERA5 hourly data on single levels" page
    3. API token in ~/.cdsapirc per the CDS docs
    4. pip install cdsapi xarray netcdf4 numpy

Usage:
    # self test, no CDS account or network needed (numpy only, ~5 GB RAM):
    python3 build_dataset_era5.py --synthetic --out /tmp/seastate_selftest

    # real build (restartable; rerun the same command after any interruption):
    python3 build_dataset_era5.py --download --years 2010-2024 --workdir ~/era5_work
    python3 build_dataset_era5.py --emit --workdir ~/era5_work --out ../web/data
"""

import argparse
import json
import math
import os
import sys
import zipfile

import numpy as np

# ---------------------------------------------------------------- constants

THRESHOLDS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10]
RES = 0.5
LAT0, LON0 = -90.0, -180.0
NLAT, NLON = 361, 720
NCELL = NLAT * NLON
TILE_DEG = 10
HOURS = ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"]
STEP_H = 3
CHECKPOINT = "seastate_accum.npz"
CKPT_VERSION = 2

# histogram geometry (documented in the module docstring)
HS_BIN = 0.25
HS_NB = 60                    # 0 .. 15 m, top bin clamps
JH_NB = 14                    # joint Hs: 0.5 m bins, top clamps at >= 6.5 m
JT_NB = 14                    # joint Tp: 1 s bins covering 2..16 s, both ends clamp
ROSE_SECT = 12                # 30 deg sectors (direction waves come FROM)
ROSE_BANDS = 4                # Hs < 1.5 / < 2.5 / < 4 / >= 4 m
WIND_NB = 40                  # 1 m/s bins, top clamps
P_THR = [1.0, 1.5, 2.0, 2.5, 3.0]
P_NT = len(P_THR)
P_EDGES_H = [6, 12, 24, 48, 72, 120]   # run-duration bin edges, hours
P_NB = len(P_EDGES_H) + 1
P_CAP_STEPS = 80              # flush runs at 240 h so endless calms still count
DI_NB = 8                     # diurnal: 3 h local-solar-time slots

DI_SLOT_CACHE = {}


def diurnal_col_slots(utc_h):
    """Local-solar 3 h slot per longitude column at a given UTC hour."""
    if utc_h not in DI_SLOT_CACHE:
        lons = LON0 + RES * np.arange(NLON)
        DI_SLOT_CACHE[utc_h] = (np.floor((utc_h + lons / 15.0 + 1.5) / 3.0)
                                .astype(np.int64) % DI_NB)
    return DI_SLOT_CACHE[utc_h]

# ---------------------------------------------------------------- ENSO (ONI)
# Phase conditioning: every accumulated month is tagged El Nino / neutral /
# La Nina from NOAA CPC's Oceanic Nino Index (3-month running SST anomaly in
# the Nino 3.4 region, ERSSTv5). Simple threshold rule, applied per month:
# anomaly >= +0.5 C = El Nino, <= -0.5 C = La Nina, else neutral. The raw
# table is archived in the workdir and its hash recorded in the ledger, so
# the classification is reproducible even after NOAA revises the series.
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
ONI_FILE = "oni.ascii.txt"
ENSO_NP = 3                       # 0 El Nino, 1 neutral, 2 La Nina
ENSO_NAMES = ["elnino", "neutral", "lanina"]
# season s is CENTERED on month s+1 (DJF on Jan ... NDJ on Dec); the table's
# YR column is the year of that centre month
ONI_SEAS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ",
            "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]


def oni_parse(path):
    """-> {(year, month 1-12): phase 0/1/2} from NOAA's oni.ascii.txt."""
    table = {}
    with open(path) as fh:
        for line in fh:
            parts = line.split()
            if len(parts) != 4 or parts[0] not in ONI_SEAS:
                continue
            anom = float(parts[3])
            ph = 0 if anom >= 0.5 else (2 if anom <= -0.5 else 1)
            table[(int(parts[1]), ONI_SEAS.index(parts[0]) + 1)] = ph
    return table


def oni_fetch(workdir):
    """Download the ONI table once (kept in the workdir for reproducibility);
    -> (phase table, path). Retries because a NOAA hiccup at boot must not
    kill a multi-week build before it starts."""
    import time
    import urllib.request
    path = os.path.join(workdir, ONI_FILE)
    if not os.path.exists(path):
        last = None
        for attempt in range(5):
            try:
                with urllib.request.urlopen(ONI_URL, timeout=60) as r:
                    data = r.read()
                if len(data) < 10000:
                    raise RuntimeError("ONI file suspiciously small: %d bytes" % len(data))
                tmp = path + ".tmp"
                with open(tmp, "wb") as fh:
                    fh.write(data)
                os.replace(tmp, path)
                last = None
                break
            except Exception as e:
                last = e
                time.sleep(20 * (attempt + 1))
        if last is not None:
            raise SystemExit("could not fetch the ONI table from %s: %s "
                             "(rerun, or use --no-enso to build without phase splits)"
                             % (ONI_URL, last))
    table = oni_parse(path)
    if len(table) < 800:
        raise SystemExit("ONI table parsed to only %d months; format change? "
                         "(%s)" % (len(table), path))
    return table, path


def oni_check_span(table, y0, y1):
    for year in range(y0, y1 + 1):
        for month in range(1, 13):
            if (year, month) not in table:
                raise SystemExit("ONI table has no entry for %04d-%02d; cannot "
                                 "phase-tag the requested span (use --no-enso to "
                                 "build without phase splits)" % (year, month))


CDS_VARIABLES = [
    "significant_height_of_combined_wind_waves_and_swell",
    "significant_height_of_wind_waves",
    "significant_height_of_total_swell",
    "mean_wave_period",
    "peak_wave_period",
    "mean_wave_direction",
    "10m_u_component_of_wind",
    "10m_v_component_of_wind",
]

# --vars wind: just enough to complete the wind-family accumulators. swh
# rides along because the wind samples are masked by the wave field, the
# ENSO split is a split of Hs, and re-downloading it buys a free bit-exact
# cross-check of the whole pipeline against the span's existing checkpoint.
CDS_VARS_WIND = [
    "significant_height_of_combined_wind_waves_and_swell",
    "10m_u_component_of_wind",
    "10m_v_component_of_wind",
]

# short name -> phrase fallback for tolerant netCDF variable resolution
VAR_KEYS = [
    ("swh", "combined wind waves"),
    ("shww", "height of wind waves"),
    ("shts", "total swell"),
    ("mwp", "mean wave period"),
    ("pp1d", "peak wave period"),
    ("mwd", "mean wave direction"),
    ("u10", "10 metre u"),
    ("v10", "10 metre v"),
]

# ---------------------------------------------------------------- checkpoint

def new_accumulator():
    return {
        "version": np.int32(CKPT_VERSION),
        "nsamp": np.zeros((12, NLAT, NLON), dtype=np.uint32),
        "hsum": np.zeros((12, NLAT, NLON), dtype=np.float64),
        "hs_hist": np.zeros((12, NLAT, NLON, HS_NB), dtype=np.uint16),
        "joint": np.zeros((12, NLAT, NLON, JH_NB * JT_NB), dtype=np.uint16),
        "rose": np.zeros((12, NLAT, NLON, ROSE_SECT * ROSE_BANDS), dtype=np.uint16),
        "wind_hist": np.zeros((12, NLAT, NLON, WIND_NB), dtype=np.uint16),
        "wind_sum": np.zeros((12, NLAT, NLON), dtype=np.float64),
        "wind_n": np.zeros((12, NLAT, NLON), dtype=np.uint32),
        "mwp_sum": np.zeros((12, NLAT, NLON), dtype=np.float64),
        "shts_sum": np.zeros((12, NLAT, NLON), dtype=np.float64),
        "shww_sum": np.zeros((12, NLAT, NLON), dtype=np.float64),
        "persist": np.zeros((P_NT, 12, NLAT, NLON, P_NB), dtype=np.uint16),
        "run_len": np.zeros((P_NT, NLAT, NLON), dtype=np.uint16),
        "run_m": np.zeros((P_NT, NLAT, NLON), dtype=np.uint8),
        # diurnal cycle in LOCAL SOLAR time (8 x 3 h slots; UTC binning would
        # smear the sea-breeze signal): mean Hs / wind by month x slot
        "dh_sum": np.zeros((12, DI_NB, NLAT, NLON), dtype=np.float32),
        "dh_cnt": np.zeros((12, DI_NB, NLAT, NLON), dtype=np.uint32),
        "dw_sum": np.zeros((12, DI_NB, NLAT, NLON), dtype=np.float32),
        "dw_cnt": np.zeros((12, DI_NB, NLAT, NLON), dtype=np.uint32),
        # wind rose: direction the wind blows FROM, 12 x 30 deg sectors in
        # four strength bands (< 5.5 / 5.5-10.8 / 10.8-17.2 / >= 17.2 m/s)
        "wind_rose": np.zeros((12, NLAT, NLON, ROSE_SECT * ROSE_BANDS), dtype=np.uint16),
        # ENSO phase split of the core wave stats (El Nino / neutral / La Nina
        # by ONI): enough for phase-conditioned exceedance + mean. uint16 hist
        # is safe: one (cell, month, phase) can hold at most 8x31 samples per
        # year and the merge overflow guard catches pathological spans.
        "en_nsamp": np.zeros((ENSO_NP, 12, NLAT, NLON), dtype=np.uint32),
        "en_hsum": np.zeros((ENSO_NP, 12, NLAT, NLON), dtype=np.float64),
        "en_hist": np.zeros((ENSO_NP, 12, NLAT, NLON, HS_NB), dtype=np.uint16),
        "done": [],
    }


ARRAY_KEYS = ["nsamp", "hsum", "hs_hist", "joint", "rose", "wind_hist", "wind_sum",
              "wind_n", "mwp_sum", "shts_sum", "shww_sum", "persist", "run_len", "run_m"]
# added 20 Aug 26 (diurnal + wind rose) and 23 Aug 26 (ENSO): absent from
# checkpoints built before then, zero-filled on load so those spans keep
# working (the emitter skips all-zero cells)
DIURNAL_KEYS = ["dh_sum", "dh_cnt", "dw_sum", "dw_cnt", "wind_rose"]
ENSO_KEYS = ["en_nsamp", "en_hsum", "en_hist"]
OPTIONAL_KEYS = DIURNAL_KEYS + ENSO_KEYS


def load_accumulator(workdir):
    path = os.path.join(workdir, CHECKPOINT)
    if not os.path.exists(path):
        return new_accumulator()
    z = np.load(path, allow_pickle=False)
    if int(z["version"]) != CKPT_VERSION:
        raise SystemExit("checkpoint at %s is version %s, this script writes v%d; "
                         "move it aside and start fresh" % (path, int(z["version"]), CKPT_VERSION))
    acc = new_accumulator()
    acc["done"] = [s for s in z["done"].tolist()]
    for k in ARRAY_KEYS:
        acc[k] = z[k]
    for k in OPTIONAL_KEYS:
        if k in getattr(z, "files", []):
            acc[k] = z[k]
    # en_hist is stored one phase per member so downstream consumers (the
    # WAVERYS graft) can stream it without ever holding all three phases
    if "en_hist0" in getattr(z, "files", []):
        acc["en_hist"] = np.stack([z["en_hist0"], z["en_hist1"], z["en_hist2"]])
    return acc


def save_accumulator(workdir, acc):
    os.makedirs(workdir, exist_ok=True)
    path = os.path.join(workdir, CHECKPOINT)
    tmp = path + ".tmp"
    payload = {k: acc[k] for k in ARRAY_KEYS + OPTIONAL_KEYS}
    del payload["en_hist"]
    for p in range(ENSO_NP):
        payload["en_hist%d" % p] = acc["en_hist"][p]
    payload["version"] = acc["version"]
    payload["done"] = np.array(acc["done"])
    with open(tmp, "wb") as fh:
        np.savez(fh, **payload)
    os.replace(tmp, path)


# ---------------------------------------------------------------- accumulate

def normalise_grid(values, lats, lons):
    """Reorder (time, lat, lon) to latitude ascending from -90 and longitude
    starting at -180 in 0.5 deg steps."""
    lats = np.asarray(lats, dtype=float)
    lons = np.asarray(lons, dtype=float)
    if lats[0] > lats[-1]:
        values = values[:, ::-1, :]
        lats = lats[::-1]
    if abs(lats[0] - LAT0) > 1e-6 or len(lats) != NLAT:
        raise RuntimeError("unexpected latitude grid: %s..%s n=%d" % (lats[0], lats[-1], len(lats)))
    lon_wrapped = ((lons + 180.0) % 360.0) - 180.0
    start = int(np.argmin(np.abs(lon_wrapped - LON0)))
    if abs(lon_wrapped[start] - LON0) > 1e-6 or len(lons) != NLON:
        raise RuntimeError("unexpected longitude grid: n=%d" % len(lons))
    return np.roll(values, -start, axis=2)


def accumulate_month(acc, month_idx, v, phase=None):
    """v: dict short-name -> float32 (ntime, NLAT, NLON) normalised arrays.
    swh is required; other variables are skipped (with a warning) if absent.
    phase: ENSO phase 0/1/2 of this calendar month (whole months belong to
    one phase), or None to skip the phase-split accumulators."""
    m = month_idx
    swh = v["swh"]
    nt = swh.shape[0]
    finite = np.isfinite(swh)

    fin_cnt = finite.sum(axis=0).astype(np.uint32)
    h_sum = np.where(finite, swh, 0.0).sum(axis=0)
    acc["nsamp"][m] += fin_cnt
    if acc["nsamp"][m].max() > 60000:
        raise RuntimeError("uint16 histogram counters close to overflow; reduce years")
    acc["hsum"][m] += h_sum
    en_hist = None
    if phase is not None:
        acc["en_nsamp"][phase, m] += fin_cnt
        acc["en_hsum"][phase, m] += h_sum
        en_hist = acc["en_hist"][phase, m].reshape(NCELL, HS_NB)

    for name in ("mwp", "shts", "shww"):
        if name in v:
            a = v[name]
            ok = finite & np.isfinite(a)
            acc[name + "_sum"][m] += np.where(ok, a, 0.0).sum(axis=0)

    wind = None
    wdir = None
    if "u10" in v and "v10" in v:
        wind = np.hypot(v["u10"], v["v10"])
        # direction the wind blows FROM (meteorological): bearing of (-u, -v)
        wdir = np.degrees(np.arctan2(-v["u10"], -v["v10"])) % 360.0

    tp = v.get("pp1d")
    mwd = v.get("mwd")

    cell_idx = np.arange(NCELL)
    hs_hist = acc["hs_hist"][m].reshape(NCELL, HS_NB)
    joint = acc["joint"][m].reshape(NCELL, JH_NB * JT_NB)
    rose = acc["rose"][m].reshape(NCELL, ROSE_SECT * ROSE_BANDS)
    wind_hist = acc["wind_hist"][m].reshape(NCELL, WIND_NB)
    wind_rose = acc["wind_rose"][m].reshape(NCELL, ROSE_SECT * ROSE_BANDS)

    p_edges_steps = np.array([e // STEP_H for e in P_EDGES_H])

    for t in range(nt):
        h = swh[t].reshape(NCELL)
        ok = finite[t].reshape(NCELL)
        oki = cell_idx[ok]
        hv = h[oki]

        hb = np.minimum((hv / HS_BIN).astype(np.int64), HS_NB - 1)
        np.add.at(hs_hist, (oki, hb), 1)
        if en_hist is not None:
            np.add.at(en_hist, (oki, hb), 1)

        if tp is not None:
            tpv = tp[t].reshape(NCELL)[oki]
            tok = np.isfinite(tpv)
            jh = np.minimum((hv[tok] / 0.5).astype(np.int64), JH_NB - 1)
            jt = np.clip(tpv[tok].astype(np.int64) - 2, 0, JT_NB - 1)
            np.add.at(joint, (oki[tok], jh * JT_NB + jt), 1)

        if mwd is not None:
            dv = mwd[t].reshape(NCELL)[oki]
            dok = np.isfinite(dv)
            sect = ((dv[dok] % 360.0) / 30.0).astype(np.int64) % ROSE_SECT
            band = np.digitize(hv[dok], [1.5, 2.5, 4.0])
            np.add.at(rose, (oki[dok], sect * ROSE_BANDS + band), 1)

        if wind is not None:
            wv = wind[t].reshape(NCELL)[oki]
            wok = np.isfinite(wv)
            wb = np.minimum(wv[wok].astype(np.int64), WIND_NB - 1)
            np.add.at(wind_hist, (oki[wok], wb), 1)
            acc["wind_n"][m].reshape(NCELL)[oki[wok]] += 1
            acc["wind_sum"][m].reshape(NCELL)[oki[wok]] += wv[wok]
            wdv = wdir[t].reshape(NCELL)[oki][wok]
            wsect = ((wdv % 360.0) / 30.0).astype(np.int64) % ROSE_SECT
            wband = np.digitize(wv[wok], [5.5, 10.8, 17.2])
            np.add.at(wind_rose, (oki[wok], wsect * ROSE_BANDS + wband), 1)

        # diurnal accumulation: bin this UTC step into each longitude
        # column's local-solar slot
        slots = diurnal_col_slots(3 * (t % 8))
        fin2 = finite[t]
        swh_t = np.where(fin2, swh[t], 0.0).astype(np.float32)
        wok2 = np.isfinite(wind[t]) if wind is not None else None
        w_t = np.where(wok2, wind[t], 0.0).astype(np.float32) if wind is not None else None
        for s2 in range(DI_NB):
            cols = slots == s2
            if not cols.any():
                continue
            acc["dh_sum"][m, s2][:, cols] += swh_t[:, cols]
            acc["dh_cnt"][m, s2][:, cols] += fin2[:, cols]
            if wind is not None:
                acc["dw_sum"][m, s2][:, cols] += w_t[:, cols]
                acc["dw_cnt"][m, s2][:, cols] += wok2[:, cols]

        # calm-spell tracker (below-threshold runs), state carried across months
        for ti in range(P_NT):
            thr = P_THR[ti]
            run_len = acc["run_len"][ti].reshape(NCELL)
            run_m = acc["run_m"][ti].reshape(NCELL)
            persist = acc["persist"][ti].reshape(12, NCELL, P_NB)
            below = ok & (h < thr)

            ended = (~below) & (run_len > 0)
            if ended.any():
                ei = cell_idx[ended]
                hours = run_len[ei].astype(np.int64) * STEP_H
                bins = np.searchsorted(np.array(P_EDGES_H), hours, side="right")
                np.add.at(persist, (run_m[ei].astype(np.int64), ei, bins), 1)
                run_len[ei] = 0

            starts = below & (run_len == 0)
            run_m[starts] = m
            run_len[below] += 1

            capped = run_len >= P_CAP_STEPS
            if capped.any():
                ci = cell_idx[capped]
                np.add.at(persist, (run_m[ci].astype(np.int64), ci, np.full(len(ci), P_NB - 1)), 1)
                run_len[ci] = 0


# ---------------------------------------------------------------- download

def open_month_datasets(path, workdir):
    """The new CDS serves either one netCDF or (for mixed wave + atmosphere
    requests) a zip of several. Return a list of open xarray datasets."""
    import xarray as xr
    with open(path, "rb") as fh:
        magic = fh.read(2)
    if magic == b"PK":
        exdir = os.path.join(workdir, "unzip_tmp")
        if os.path.isdir(exdir):
            for f in os.listdir(exdir):
                os.remove(os.path.join(exdir, f))
        os.makedirs(exdir, exist_ok=True)
        with zipfile.ZipFile(path) as zf:
            members = [n for n in zf.namelist() if n.endswith(".nc")]
            zf.extractall(exdir, members)
        return [xr.open_dataset(os.path.join(exdir, n)) for n in members]
    return [xr.open_dataset(path)]


def resolve_variables(datasets):
    """Map our short names to (dataset, var) pairs, by exact name first, then
    by long_name phrase."""
    out = {}
    for short, phrase in VAR_KEYS:
        for ds in datasets:
            if short in ds.data_vars:
                out[short] = ds[short]
                break
        if short in out:
            continue
        for ds in datasets:
            for name in ds.data_vars:
                ln = str(ds[name].attrs.get("long_name", "")).lower()
                if phrase in ln:
                    out[short] = ds[name]
                    break
            if short in out:
                break
    return out


def extract_month(path, workdir):
    datasets = open_month_datasets(path, workdir)
    found = resolve_variables(datasets)
    if "swh" not in found:
        raise RuntimeError("swh not found in %s (vars: %s)" %
                           (path, [list(d.data_vars) for d in datasets]))
    arrays = {}
    for short, da in found.items():
        lat_name = "latitude" if "latitude" in da.dims else "lat"
        lon_name = "longitude" if "longitude" in da.dims else "lon"
        time_name = [d for d in da.dims if d not in (lat_name, lon_name)][0]
        values = da.transpose(time_name, lat_name, lon_name).values.astype(np.float32)
        arrays[short] = normalise_grid(values, da[lat_name].values, da[lon_name].values)
    for ds in datasets:
        ds.close()
    missing = [s for s, p in VAR_KEYS if s not in arrays]
    if missing:
        print("  WARNING: variables missing this month, stats skipped: %s" % missing, flush=True)
    return arrays


def run_download(args):
    import cdsapi  # requires ~/.cdsapirc

    span = args.years.split("-")
    y0, y1 = int(span[0]), int(span[1])
    os.makedirs(args.workdir, exist_ok=True)
    # a checkpoint accumulated from a variable subset must never be extended
    # with a different subset (half the fields would silently cover half the
    # months); the marker rides the workdir for the whole build
    marker = os.path.join(args.workdir, "vars.txt")
    prior = open(marker).read().strip() if os.path.exists(marker) else None
    if prior is not None and prior != args.vars:
        raise SystemExit("workdir %s was accumulated with --vars %s; this run says "
                         "--vars %s. Use a fresh workdir." % (args.workdir, prior, args.vars))
    if prior is None:
        with open(marker, "w") as fh:
            fh.write(args.vars)
    req_vars = CDS_VARIABLES if args.vars == "all" else CDS_VARS_WIND
    acc = load_accumulator(args.workdir)

    oni = None
    if not args.no_enso:
        import hashlib as hl
        fetched = oni_fetch(args.workdir)
        oni = fetched[0]
        oni_check_span(oni, y0, y1)
        with open(fetched[1], "rb") as fh:
            oni_sha = hl.sha256(fh.read()).hexdigest()
        with open(os.path.join(args.workdir, "audit.jsonl"), "a") as fh:
            fh.write(json.dumps({"oni_sha256": oni_sha, "oni_months": len(oni)}) + "\n")
        print("ONI table: %d months, phase-tagging %d-%d" % (len(oni), y0, y1), flush=True)

    client = cdsapi.Client()

    total = (y1 - y0 + 1) * 12
    for year in range(y0, y1 + 1):
        for month in range(1, 13):
            key = "%04d-%02d" % (year, month)
            if key in acc["done"]:
                continue
            nc_path = os.path.join(args.workdir, "era5_%s.dat" % key)
            if not os.path.exists(nc_path):
                print("[%s] requesting from CDS (%d variables; queue time varies)..."
                      % (key, len(req_vars)), flush=True)
                client.retrieve(
                    "reanalysis-era5-single-levels",
                    {
                        "product_type": ["reanalysis"],
                        "variable": req_vars,
                        "year": [str(year)],
                        "month": ["%02d" % month],
                        "day": ["%02d" % d for d in range(1, 32)],
                        "time": HOURS,
                        "data_format": "netcdf",
                        "download_format": "unarchived",
                        "grid": [RES, RES],
                    },
                    nc_path,
                )
            print("[%s] accumulating..." % key, flush=True)
            import hashlib
            sha = hashlib.sha256()
            with open(nc_path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    sha.update(chunk)
            fbytes = os.path.getsize(nc_path)
            ns_before = int(acc["nsamp"].sum())
            hs_before = float(acc["hsum"].sum())
            arrays = extract_month(nc_path, args.workdir)
            ph = oni[(year, month)] if oni is not None else None
            accumulate_month(acc, month - 1, arrays, phase=ph)
            del arrays
            acc["done"].append(key)
            save_accumulator(args.workdir, acc)
            # input ledger: one line per source file, for input-vs-output audit
            ns_added = int(acc["nsamp"].sum()) - ns_before
            hs_added = float(acc["hsum"].sum()) - hs_before
            rec = {
                "month": key, "sha256": sha.hexdigest(), "bytes": fbytes,
                "samples_added": ns_added,
                "global_mean_hs": round(hs_added / max(ns_added, 1), 4),
            }
            if ph is not None:
                rec["enso"] = ENSO_NAMES[ph]
            with open(os.path.join(args.workdir, "audit.jsonl"), "a") as fh:
                fh.write(json.dumps(rec) + "\n")
            if not args.keep_nc:
                os.remove(nc_path)
            print("[%s] done (%d / %d months in checkpoint)" % (key, len(acc["done"]), total), flush=True)
    print("Download + accumulation complete: %d months." % len(acc["done"]))


# ---------------------------------------------------------------- emit

def exceedance_counts(hs_hist_cell):
    """counts of samples >= each THRESHOLDS entry, from the 0.25 m histogram
    (all thresholds are multiples of the bin width, so this is exact)."""
    cum = np.cumsum(hs_hist_cell[..., ::-1], axis=-1)[..., ::-1]
    out = []
    for t in THRESHOLDS:
        idx = int(round(t / HS_BIN))
        out.append(cum[..., idx] if idx < HS_NB else np.zeros(hs_hist_cell.shape[:-1], dtype=np.int64))
    return np.stack(out, axis=-1)


def run_emit(args, acc=None):
    marker = os.path.join(args.workdir, "vars.txt")
    if acc is None and os.path.exists(marker):
        mv = open(marker).read().strip()
        if mv != "all":
            raise SystemExit("this checkpoint was accumulated with --vars %s: it holds "
                             "the wind-family fields only and must never become tiles. "
                             "Its place is the WAVERYS graft (weld_wind_graft.py)." % mv)
    if acc is None:
        acc = load_accumulator(args.workdir)
    if not acc["done"]:
        raise SystemExit("Nothing accumulated yet: run --download (or --synthetic) first.")
    os.makedirs(args.out, exist_ok=True)

    years = sorted({int(k.split("-")[0]) for k in acc["done"]})
    period = "%d-%d" % (years[0], years[-1])
    nsamp, hsum = acc["nsamp"], acc["hsum"]

    ocean = nsamp.sum(axis=0) > 0
    lat_idx, lon_idx = np.where(ocean)
    print("ocean cells: %d" % len(lat_idx))

    max_ns = np.maximum(nsamp.reshape(12, -1).max(axis=1), 1)
    valid_m = nsamp >= (0.3 * max_ns)[:, None, None]

    counts = exceedance_counts(acc["hs_hist"].astype(np.int64))
    with np.errstate(divide="ignore", invalid="ignore"):
        exc_pm = np.round(1000.0 * counts / nsamp[:, :, :, None]).astype(np.int32)
        mean_dm = np.round(10.0 * hsum / nsamp).astype(np.int32)
    exc_pm[~valid_m, :] = -1
    mean_dm[~valid_m] = -1

    # ENSO phase split: exceedance + mean per phase, same thresholds. A
    # (phase, month) is valid on a cell when the cell is valid overall and
    # that phase saw samples there; sample counts ship in the tile so the
    # reader can state how many seasons stand behind each number.
    have_enso = bool(acc["en_nsamp"].any())
    if have_enso:
        # one (phase, month) slice at a time: whole-array temporaries (cumsum
        # promotes integer input to int64 regardless of the cast) OOM-killed
        # the self test twice; a slice keeps each transient near 300 MB
        en_ns = acc["en_nsamp"]
        en_exc = np.full((ENSO_NP, 12, NLAT, NLON, len(THRESHOLDS)), -1, dtype=np.int16)
        en_mean = np.full((ENSO_NP, 12, NLAT, NLON), -1, dtype=np.int16)
        for p9 in range(ENSO_NP):
            for m9 in range(12):
                counts_pm = exceedance_counts(acc["en_hist"][p9, m9].astype(np.int64))
                ns_pm = en_ns[p9, m9]
                ok_pm = valid_m[m9] & (ns_pm > 0)
                with np.errstate(divide="ignore", invalid="ignore"):
                    e_pm = np.round(1000.0 * counts_pm / np.maximum(ns_pm[..., None], 1)).astype(np.int16)
                    m_pm = np.round(10.0 * acc["en_hsum"][p9, m9] / np.maximum(ns_pm, 1)).astype(np.int16)
                en_exc[p9, m9][ok_pm] = e_pm[ok_pm]
                en_mean[p9, m9][ok_pm] = m_pm[ok_pm]

    # prevailing conditions per cell per month, from the joint Hs-Tp table and
    # the direction rose: typical (median-bin) peak period in deciseconds, the
    # modal 30 deg direction sector (waves come FROM; sector s covers
    # [s*30, s*30+30) deg) and the percent of samples in that sector.
    # Month at a time keeps the int64 temporaries below ~30 MB.
    tp_ds = np.full((12, NLAT, NLON), -1, dtype=np.int32)
    dir_sect = np.full((12, NLAT, NLON), -1, dtype=np.int32)
    dir_pct = np.full((12, NLAT, NLON), -1, dtype=np.int32)
    rose_pct = np.full((12, NLAT, NLON, ROSE_SECT), -1, dtype=np.int16)
    wv_sect = np.full((12, NLAT, NLON), -1, dtype=np.int32)
    wv_pct = np.full((12, NLAT, NLON), -1, dtype=np.int32)
    wv_rose = np.full((12, NLAT, NLON, ROSE_SECT), -1, dtype=np.int16)
    have_wrose = bool(acc["wind_rose"].any())
    # peak-period distribution: permille of samples per 1 s bin (2..16 s,
    # ends clamp), from the same joint table the median comes from
    tp_pml = np.full((12, NLAT, NLON, JT_NB), -1, dtype=np.int16)
    for m in range(12):
        tpm = acc["joint"][m].reshape(NLAT, NLON, JH_NB, JT_NB).sum(axis=2, dtype=np.int64)
        tot = tpm.sum(axis=-1)
        cum = np.cumsum(tpm, axis=-1)
        med = np.argmax(cum * 2 >= tot[:, :, None], axis=-1)
        okm = valid_m[m] & (tot > 0)
        tp_ds[m][okm] = np.round((med + 2.5) * 10).astype(np.int32)[okm]
        pml = np.round(1000.0 * tpm / np.maximum(tot[:, :, None], 1)).astype(np.int16)
        tp_pml[m][okm] = pml[okm]

        rs = acc["rose"][m].reshape(NLAT, NLON, ROSE_SECT, ROSE_BANDS).sum(axis=-1, dtype=np.int64)
        rtot = rs.sum(axis=-1)
        sect = np.argmax(rs, axis=-1)
        peak = np.take_along_axis(rs, sect[:, :, None], axis=-1)[:, :, 0]
        okr = valid_m[m] & (rtot > 0)
        dir_sect[m][okr] = sect.astype(np.int32)[okr]
        dir_pct[m][okr] = np.round(100.0 * peak / np.maximum(rtot, 1)).astype(np.int32)[okr]
        pct12 = np.round(100.0 * rs / np.maximum(rtot[:, :, None], 1)).astype(np.int16)
        rose_pct[m][okr] = pct12[okr]

        if have_wrose:
            wrs = acc["wind_rose"][m].reshape(NLAT, NLON, ROSE_SECT, ROSE_BANDS) \
                .sum(axis=-1, dtype=np.int64)
            wrtot = wrs.sum(axis=-1)
            wsect2 = np.argmax(wrs, axis=-1)
            wpeak = np.take_along_axis(wrs, wsect2[:, :, None], axis=-1)[:, :, 0]
            okw = valid_m[m] & (wrtot > 0)
            wv_sect[m][okw] = wsect2.astype(np.int32)[okw]
            wv_pct[m][okw] = np.round(100.0 * wpeak / np.maximum(wrtot, 1)).astype(np.int32)[okw]
            wpct12 = np.round(100.0 * wrs / np.maximum(wrtot[:, :, None], 1)).astype(np.int16)
            wv_rose[m][okw] = wpct12[okw]

    # extremes from the Hs histogram: per-month P99 / P99.9 (dm, upper bin
    # edge) plus the all-months pair from the summed histogram
    def hist_pctl(hist, tot, q):
        cum = np.cumsum(hist, axis=-1)
        need = np.ceil(q * tot).astype(np.int64)
        b = np.argmax(cum >= np.maximum(need, 1)[..., None], axis=-1)
        return np.floor((b + 1) * HS_BIN * 10.0 + 0.5).astype(np.int32)

    hs64 = acc["hs_hist"].astype(np.int64)
    tot_m = hs64.sum(axis=-1)
    p99_m = hist_pctl(hs64, tot_m, 0.99)
    p999_m = hist_pctl(hs64, tot_m, 0.999)
    p99_m[~valid_m] = -1
    p999_m[~valid_m] = -1
    hs_all = hs64.sum(axis=0)
    tot_all = hs_all.sum(axis=-1)
    p99_a = hist_pctl(hs_all, tot_all, 0.99)
    p999_a = hist_pctl(hs_all, tot_all, 0.999)
    p99_a[tot_all == 0] = -1
    p999_a[tot_all == 0] = -1

    # wind: monthly mean and P90 speed (x10 m/s) from the wind histogram
    wn = acc["wind_n"].astype(np.int64)
    with np.errstate(divide="ignore", invalid="ignore"):
        wmean = np.round(10.0 * acc["wind_sum"] / np.maximum(wn, 1)).astype(np.int32)
    w64 = acc["wind_hist"].astype(np.int64)
    wtot = w64.sum(axis=-1)
    wcum = np.cumsum(w64, axis=-1)
    wneed = np.ceil(0.9 * wtot).astype(np.int64)
    wb = np.argmax(wcum >= np.maximum(wneed, 1)[..., None], axis=-1)
    w90 = ((wb + 1) * 10).astype(np.int32)
    wind_ok = valid_m & (wtot > 0)
    wmean[~wind_ok] = -1
    w90[~wind_ok] = -1

    # diurnal cycle: mean Hs / wind by month x local-solar slot (dm and
    # dm/s x10); all-zero counts (spans built before the diurnal fields, or
    # missing wind) emit -1 and the app hides the panel
    with np.errstate(divide="ignore", invalid="ignore"):
        dh_dm = np.round(10.0 * acc["dh_sum"] / np.maximum(acc["dh_cnt"], 1)).astype(np.int32)
        dw_ds = np.round(10.0 * acc["dw_sum"] / np.maximum(acc["dw_cnt"], 1)).astype(np.int32)
    dh_dm[acc["dh_cnt"] == 0] = -1
    dw_ds[acc["dw_cnt"] == 0] = -1
    dh_dm = np.transpose(dh_dm, (0, 2, 3, 1))   # -> [12, NLAT, NLON, DI_NB]
    dw_ds = np.transpose(dw_ds, (0, 2, 3, 1))
    dh_dm[~valid_m] = -1
    dw_ds[~valid_m] = -1
    have_diurnal = bool((acc["dh_cnt"] > 0).any())

    # weather windows: calm-run counts per YEAR (x10) by threshold and
    # duration bin, month-major [12][P_NT][P_NB]
    n_years = max(1.0, len(acc["done"]) / 12.0)
    pw10 = np.round(10.0 * acc["persist"].astype(np.float64) / n_years).astype(np.int32)
    pw10 = np.transpose(pw10, (1, 2, 3, 0, 4))     # -> [12, NLAT, NLON, P_NT, P_NB]
    pw10[~valid_m, :, :] = -1

    # tiles are written and freed one 10 deg latitude band at a time: a tile
    # row is exactly one band, and holding every cell's Python lists at once
    # (about 1,700 small ints per cell now) is what OOM-killed the self test
    tiles = {}
    written = []

    def flush_tiles():
        for tid2 in tiles:
            with open(os.path.join(args.out, tid2 + ".json"), "w") as fh:
                json.dump(tiles[tid2], fh, separators=(",", ":"))
            written.append(tid2)
        tiles.clear()

    cur_band = None
    for k in range(len(lat_idx)):
        i, j = int(lat_idx[k]), int(lon_idx[k])
        lat = LAT0 + i * RES
        lon = LON0 + j * RES
        ti = min(17, int((lat + 90) // TILE_DEG))
        tj = int((lon + 180) // TILE_DEG)
        tid = "t_%d_%d" % (-90 + ti * TILE_DEG, -180 + tj * TILE_DEG)
        if cur_band is None:
            cur_band = ti
        elif ti != cur_band:
            flush_tiles()
            cur_band = ti
        t = tiles.setdefault(tid, {"format": 1, "lat": [], "lon": [], "n": [], "mean": [],
                                   "exc": [], "tp": [], "th": [], "wd": [], "wp": [], "wr": [],
                                   "hx": [], "hxa": [], "wm": [], "w9": [], "pw": [],
                                   "dh": [], "dw": [], "vd": [], "vp": [], "vr": [],
                                   "pn": [], "pm": [], "pe": []})
        t["lat"].append(round(lat, 2))
        t["lon"].append(round(lon, 2))
        t["n"].append([int(nsamp[m, i, j]) for m in range(12)])
        t["mean"].append([int(mean_dm[m, i, j]) for m in range(12)])
        t["tp"].append([int(tp_ds[m, i, j]) for m in range(12)])
        t["th"].append([int(tp_pml[m, i, j, b]) for m in range(12) for b in range(JT_NB)])
        t["wd"].append([int(dir_sect[m, i, j]) for m in range(12)])
        t["wp"].append([int(dir_pct[m, i, j]) for m in range(12)])
        t["wr"].append([int(rose_pct[m, i, j, s]) for m in range(12) for s in range(ROSE_SECT)])
        t["hx"].append([int(x) for m in range(12) for x in (p99_m[m, i, j], p999_m[m, i, j])])
        t["hxa"].append([int(p99_a[i, j]), int(p999_a[i, j])])
        t["wm"].append([int(wmean[m, i, j]) for m in range(12)])
        t["w9"].append([int(w90[m, i, j]) for m in range(12)])
        t["pw"].append([int(pw10[m, i, j, x, b])
                        for m in range(12) for x in range(P_NT) for b in range(P_NB)])
        if have_diurnal:
            t["dh"].append([int(dh_dm[m, i, j, s]) for m in range(12) for s in range(DI_NB)])
            t["dw"].append([int(dw_ds[m, i, j, s]) for m in range(12) for s in range(DI_NB)])
        else:
            t["dh"].append([])
            t["dw"].append([])
        if have_wrose:
            t["vd"].append([int(wv_sect[m, i, j]) for m in range(12)])
            t["vp"].append([int(wv_pct[m, i, j]) for m in range(12)])
            t["vr"].append([int(wv_rose[m, i, j, s]) for m in range(12) for s in range(ROSE_SECT)])
        else:
            t["vd"].append([])
            t["vp"].append([])
            t["vr"].append([])
        if have_enso:
            # month-major, phase inner (el nino / neutral / la nina); pe adds
            # the threshold axis innermost, mirroring exc's layout
            t["pn"].append([int(en_ns[p, m, i, j]) for m in range(12) for p in range(ENSO_NP)])
            t["pm"].append([int(en_mean[p, m, i, j]) for m in range(12) for p in range(ENSO_NP)])
            t["pe"].append([int(en_exc[p, m, i, j, x])
                            for m in range(12) for p in range(ENSO_NP)
                            for x in range(len(THRESHOLDS))])
        else:
            t["pn"].append([])
            t["pm"].append([])
            t["pe"].append([])
        flat = []
        for m in range(12):
            for x in range(len(THRESHOLDS)):
                flat.append(int(exc_pm[m, i, j, x]) if valid_m[m, i, j] else -1)
        t["exc"].append(flat)

    flush_tiles()

    # coarse mean raster for map shading (2 deg cells, nsamp weighted)
    g_res, g_nlat, g_nlon = 2, 90, 180
    cells_per = int(g_res / RES)
    mean_grid = []
    for m in range(12):
        w = np.where(valid_m[m], nsamp[m], 0).astype(np.float64)
        h = np.where(valid_m[m], hsum[m], 0.0)
        w2 = w[:NLAT - 1, :].reshape(g_nlat, cells_per, g_nlon, cells_per)
        h2 = h[:NLAT - 1, :].reshape(g_nlat, cells_per, g_nlon, cells_per)
        wsum = w2.sum(axis=(1, 3))
        hsum2 = h2.sum(axis=(1, 3))
        with np.errstate(divide="ignore", invalid="ignore"):
            mg = np.where(wsum > 0, np.round(10.0 * hsum2 / wsum), -1).astype(int)
        mean_grid.append([int(x) for x in mg.flatten()])
    with open(os.path.join(args.out, "meanhs.json"), "w") as fh:
        # block (r, c) sums grid rows 4r..4r+3 and columns 4c..4c+3, whose cell
        # centres run -90..-88.5 / -180..-178.5, so the block centre is a
        # quarter cell south-west of the round number
        json.dump({"res": g_res, "lat0": -89.25, "lon0": -179.25, "nlat": g_nlat, "nlon": g_nlon,
                   "mean": mean_grid}, fh, separators=(",", ":"))

    manifest = {
        "format": 1,
        "source": "ERA5",
        "source_label": "ERA5 reanalysis (ECMWF / Copernicus C3S)",
        "period": period + ", 3 hourly",
        "attribution": "Contains modified Copernicus Climate Change Service information [" + period + "]. "
            "ERA5 hourly data on single levels (significant height of combined wind waves and swell). "
            "Neither the European Commission nor ECMWF is responsible for any use of this information.",
        "grid": {"res": RES, "lat0": LAT0, "lon0": LON0},
        "thresholds": THRESHOLDS,
        "persist": {"thresholds": P_THR, "edges_h": P_EDGES_H},
        "tp_hist": {"t0": 2, "step": 1, "nb": JT_NB},
        "wind": True,
        "enso": ({"phases": ENSO_NAMES,
                  "index": "ONI (NOAA CPC, ERSSTv5), +/-0.5 C monthly threshold"}
                 if have_enso else False),
        "tile_deg": TILE_DEG,
        "max_snap_km": 350,
        "tiles": sorted(written),
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    sizes = sum(os.path.getsize(os.path.join(args.out, f)) for f in os.listdir(args.out))
    print("emitted %d tiles + manifest + meanhs to %s (%.1f MB)" % (len(written), args.out, sizes / 1e6))


# ---------------------------------------------------------------- checkpoint merge

def flush_open_runs(acc):
    """Count each still-open calm run as completed at its current length.
    Used on the EARLIER span when merging two disjoint spans: the physical
    run continues into the later span (which restarted its counter), so the
    one run at the seam is counted as two shorter ones - the documented
    split-run seam cost, one run per cell per threshold at most."""
    flushed = 0
    for ti in range(P_NT):
        run_len = acc["run_len"][ti].reshape(-1)
        run_m = acc["run_m"][ti].reshape(-1)
        persist = acc["persist"][ti].reshape(12, run_len.shape[0], P_NB)
        open_i = np.nonzero(run_len > 0)[0]
        if len(open_i) == 0:
            continue
        hours = run_len[open_i].astype(np.int64) * STEP_H
        bins = np.searchsorted(np.array(P_EDGES_H), hours, side="right")
        np.add.at(persist, (run_m[open_i].astype(np.int64), open_i, bins), 1)
        run_len[open_i] = 0
        flushed += len(open_i)
    return flushed


def run_merge(args):
    """Merge two disjoint-span checkpoints (e.g. a 1980-2009 build and a
    2010-2024 build) into --workdir, ready for --emit. Accumulators are
    additive; the earlier span's open calm runs are flushed first; the
    merged run state comes from the later span.

    Streams ONE key at a time straight between the npz files instead of
    loading both checkpoints whole: two 4.4 GB v2 checkpoints plus the
    int64 temporaries peaked near 15 GB, which is the whole RAM of the
    16 GB build boxes (and of the box that merged the 1980-2009 backfill,
    2 Sep 26). Peak now follows the largest single key (joint, ~3 GB).
    The output is deflated, so it is also ~half the size on disk."""
    parts = [p.strip() for p in args.merge.split(",") if p.strip()]
    if len(parts) != 2:
        raise SystemExit("--merge wants exactly two workdirs, comma separated")
    handles = []
    for p in parts:
        path = os.path.join(p, CHECKPOINT)
        if not os.path.exists(path):
            raise SystemExit("no checkpoint in %s" % p)
        z = np.load(path, allow_pickle=False)
        if int(z["version"]) != CKPT_VERSION:
            raise SystemExit("checkpoint at %s is version %s, this script writes v%d; "
                             "move it aside and start fresh"
                             % (path, int(z["version"]), CKPT_VERSION))
        handles.append(z)
    # a --vars subset checkpoint (wind family only) must not be welded to a
    # full one: the merged workdir would carry no marker and run_emit would
    # happily emit tiles whose wave fields cover half the span. Both parts
    # must agree, and a subset marker rides through to the merged workdir.
    markers = []
    for p in parts:
        mp = os.path.join(p, "vars.txt")
        markers.append(open(mp).read().strip() if os.path.exists(mp) else "all")
    if markers[0] != markers[1]:
        raise SystemExit("cannot merge a --vars %s checkpoint (%s) with a --vars %s "
                         "checkpoint (%s): weld a wind subset with weld_wind_graft.py "
                         "instead" % (markers[0], parts[0], markers[1], parts[1]))
    da = [s for s in handles[0]["done"].tolist()]
    db = [s for s in handles[1]["done"].tolist()]
    overlap = set(da) & set(db)
    if overlap:
        raise SystemExit("spans overlap (%d shared months, e.g. %s): merging would "
                         "double count" % (len(overlap), sorted(overlap)[0]))
    if not da or not db:
        raise SystemExit("one checkpoint has no completed months")
    # order so a = earlier span
    if max(da) > max(db):
        handles.reverse()
        swap = da
        da = db
        db = swap
    za, zb = handles[0], handles[1]
    print("merging %d months (to %s) + %d months (to %s)"
          % (len(da), max(da), len(db), max(db)))

    # seam flush works on small copies of the earlier span's run state
    mini = {"run_len": za["run_len"].copy(), "run_m": za["run_m"].copy(),
            "persist": za["persist"].copy()}
    flushed = flush_open_runs(mini)
    if flushed:
        print("flushed %d open calm run(s) at the span seam" % flushed)

    # storage member names: en_hist lives split as en_hist0..2 in the file,
    # so merge those members directly and never hold the stacked copy
    keys = [k for k in ARRAY_KEYS + OPTIONAL_KEYS
            if k not in ("run_len", "run_m", "en_hist")]
    keys += ["en_hist%d" % ph for ph in range(ENSO_NP)]

    os.makedirs(args.workdir, exist_ok=True)
    path = os.path.join(args.workdir, CHECKPOINT)
    tmp = path + ".tmp"
    zf = zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED)

    def put(name, arr):
        # np.asarray, NOT ascontiguousarray: the latter carries ndmin=1 and
        # silently promotes the 0-d "version" scalar to shape (1,), which
        # breaks every int(z["version"]) consumer downstream
        with zf.open(name + ".npy", "w", force_zip64=True) as fh:
            np.lib.format.write_array(fh, np.asarray(arr), allow_pickle=False)

    for k in keys:
        a = za[k] if k in za.files else None
        b = zb[k] if k in zb.files else None
        if k == "persist":
            a = mini["persist"]
        if a is None and b is None:
            # optional key absent from both spans: leave it out, exactly as
            # the two inputs had it (load_accumulator zero-fills on read)
            continue
        if a is None:
            a = np.zeros_like(b)
        if b is None:
            b = np.zeros_like(a)
        if a.dtype != b.dtype or a.shape != b.shape:
            zf.close()
            os.remove(tmp)
            raise SystemExit("%s differs between spans: %s%s vs %s%s"
                             % (k, a.dtype, a.shape, b.dtype, b.shape))
        out_dtype = a.dtype
        # uint16 counters can never overflow uint32 (2 x 65535); uint32
        # counters get int64 headroom; floats sum in float64
        if out_dtype.kind == "f":
            wide_dtype = np.float64
        elif out_dtype == np.uint16:
            wide_dtype = np.uint32
        else:
            wide_dtype = np.int64
        wide = a.astype(wide_dtype) + b.astype(wide_dtype)
        del a, b
        if out_dtype.kind in "ui":
            lim = np.iinfo(out_dtype).max
            mx = int(wide.max()) if wide.size else 0
            if mx > lim:
                zf.close()
                os.remove(tmp)
                raise SystemExit("%s overflows %s on merge (max %d)"
                                 % (k, out_dtype, mx))
        merged = wide.astype(out_dtype)
        del wide
        put(k, merged)
        del merged

    put("run_len", zb["run_len"])
    put("run_m", zb["run_m"])
    put("version", np.int32(CKPT_VERSION))
    put("done", np.array(sorted(set(da) | set(db))))
    zf.close()
    os.replace(tmp, path)
    if markers[0] != "all":
        with open(os.path.join(args.workdir, "vars.txt"), "w") as fh:
            fh.write(markers[0])
    print("merged checkpoint: %d months -> %s" % (len(da) + len(db), args.workdir))


# ---------------------------------------------------------------- synthetic self test

def run_synthetic(args):
    """Exercise accumulate + emit + reader round trip without CDS or xarray,
    on the real grid, including deterministic checks of every accumulator."""
    print("synthetic self test: 2 years x 12 months on the real grid (needs ~5 GB RAM)...")
    acc = new_accumulator()
    rng = np.random.default_rng(7)
    lats = LAT0 + RES * np.arange(NLAT)
    base = 1.5 + 2.5 * np.exp(-((np.abs(lats) - 50.0) / 18.0) ** 2)
    land = np.zeros((NLAT, NLON), dtype=bool)
    land[(np.abs(lats) < 30)[:, None] & (np.abs(LON0 + RES * np.arange(NLON)) < 20)[None, :]] = True

    # deterministic probe cell: 10.0 N, 130.0 W (well inside synthetic ocean)
    pi = int(round((10.0 - LAT0) / RES))
    pj = int(round((-130.0 - LON0) / RES))
    pattern = np.array(([0.5] * 5 + [2.0] * 3) * 4, dtype=np.float32)  # nt=32

    nt = 32
    for year in (2001, 2002):
        for month in range(1, 13):
            seas = 1.0 + 0.35 * math.cos(2 * math.pi * (month - 1) / 12.0)
            mean = (base * seas)[None, :, None]
            swh = rng.weibull(2.0, size=(nt, NLAT, NLON)).astype(np.float32) * mean.astype(np.float32) / 0.886
            swh[:, land] = np.nan
            swh[:, pi, pj] = pattern
            v = {
                "swh": swh,
                "shww": swh * np.float32(0.6),
                "shts": swh * np.float32(0.7),
                "mwp": np.full_like(swh, 7.0),
                "pp1d": np.full_like(swh, 8.0),
                "mwd": np.full_like(swh, 90.0),
                "u10": np.full_like(swh, 3.0),
                "v10": np.full_like(swh, 4.0),
            }
            for name in ("shww", "shts", "mwp", "pp1d", "mwd", "u10", "v10"):
                v[name][:, land] = np.nan
            if args.vars == "wind":
                # the subset the wind backfill downloads; accumulate_month
                # must cope with everything else absent
                v = {"swh": v["swh"], "u10": v["u10"], "v10": v["v10"]}
            # synthetic ENSO phase: calendar month m always lands in phase
            # m % 3, so both years agree and the split is deterministic
            accumulate_month(acc, month - 1, v, phase=(month - 1) % 3)
            acc["done"].append("%04d-%02d" % (year, month))

    # ---- accumulator invariants
    assert (acc["hs_hist"].sum(axis=-1) == acc["nsamp"]).all(), "hs_hist rows != nsamp"
    if args.vars == "wind":
        assert acc["joint"].sum() == 0 and acc["rose"].sum() == 0, "subset leaked vars"
        assert acc["mwp_sum"].sum() == 0 and acc["shts_sum"].sum() == 0
    else:
        assert (acc["joint"].sum(axis=-1) == acc["nsamp"]).all(), "joint rows != nsamp"
        assert (acc["rose"].sum(axis=-1) == acc["nsamp"]).all(), "rose rows != nsamp"
    assert (acc["wind_hist"].sum(axis=-1) == acc["nsamp"]).all(), "wind rows != nsamp"
    assert (acc["wind_n"] == acc["nsamp"]).all()
    # ENSO split: phases partition the samples exactly, and month m sits
    # wholly in phase m % 3
    assert (acc["en_nsamp"].sum(axis=0) == acc["nsamp"]).all(), "enso phases != nsamp"
    assert (acc["en_hist"].sum(axis=-1) == acc["en_nsamp"]).all(), "en_hist rows != en_nsamp"
    assert np.allclose(acc["en_hsum"].sum(axis=0), acc["hsum"]), "en_hsum != hsum"
    for m3 in range(12):
        for p3 in range(ENSO_NP):
            s = int(acc["en_nsamp"][p3, m3].sum())
            if p3 == m3 % 3:
                assert s == int(acc["nsamp"][m3].sum()), (m3, p3, s)
            else:
                assert s == 0, (m3, p3, s)

    # probe cell: nsamp 64/month; P(Hs >= 2.0) = 12 of 32 per file = 24/month
    assert acc["nsamp"][0, pi, pj] == 64
    counts = exceedance_counts(acc["hs_hist"][:, pi, pj, :].astype(np.int64))
    ti2 = THRESHOLDS.index(2.0)
    assert counts[0, ti2] == 24, "probe exceedance wrong: %s" % counts[0, ti2]
    # joint: Tp=8 s -> bin 6; wind speed hypot(3,4)=5 -> bin 5; mwd=90 -> sector 3
    if args.vars == "all":
        jrow = acc["joint"][0, pi, pj].reshape(JH_NB, JT_NB)
        assert jrow[:, 6].sum() == 64 and jrow.sum() == 64
        rrow = acc["rose"][0, pi, pj].reshape(ROSE_SECT, ROSE_BANDS)
        assert rrow[3, :].sum() == 64
    assert acc["wind_hist"][0, pi, pj, 5] == 64
    # wind FROM (3,4): bearing of (-3,-4) = 216.9 deg -> sector 7, band 0
    wrow = acc["wind_rose"][0, pi, pj].reshape(ROSE_SECT, ROSE_BANDS)
    assert wrow[7, 0] == 64 and wrow.sum() == 64, wrow.sum()
    # diurnal wind: every slot at the probe averages exactly 5 m/s
    dws = acc["dw_sum"][0, :, pi, pj]
    dwc = acc["dw_cnt"][0, :, pi, pj]
    assert dwc.sum() == 64 and np.allclose(dws[dwc > 0] / dwc[dwc > 0], 5.0)
    # calm spells at 1.0 m: 4 runs of 15 h per file -> bin 2 (12-24 h), 8 per month
    assert (acc["persist"][0, :, pi, pj, 2] == 8).all(), acc["persist"][0, :, pi, pj]
    assert acc["persist"][0, :, pi, pj].sum() == 96
    # at 3.0 m the probe never exceeds: capped 240 h runs only, 768 steps -> 9 caps
    p3 = acc["persist"][P_THR.index(3.0), :, pi, pj]
    assert p3[:, P_NB - 1].sum() == 9 and p3.sum() == 9, p3.sum()

    if args.vars == "wind":
        print("SYNTHETIC WIND-SUBSET PASS (no emit: subset checkpoints never become tiles)")
        return

    run_emit(args, acc)

    # ---- reader round trip
    with open(os.path.join(args.out, "manifest.json")) as fh:
        mf = json.load(fh)
    assert mf["format"] == 1 and mf["thresholds"] == THRESHOLDS
    with open(os.path.join(args.out, "t_50_-30.json")) as fh:
        tile = json.load(fh)
    k = tile["lat"].index(55.0)
    exc = tile["exc"][k]
    NT = len(THRESHOLDS)
    for m in range(12):
        row = exc[m * NT:(m + 1) * NT]
        assert all(row[i] >= row[i + 1] for i in range(NT - 1)), "exceedance not monotone"
        assert 0 <= row[0] <= 1000
    with open(os.path.join(args.out, "meanhs.json")) as fh:
        g = json.load(fh)
    row = round((55.0 - g["lat0"]) / g["res"])
    col = round((-25.0 - g["lon0"]) / g["res"])
    assert g["mean"][0][row * g["nlon"] + col] > 0
    # prevailing conditions on the probe cell: Tp=8 s everywhere -> median bin 6
    # -> 8.5 s (85 ds); mwd=90 deg -> sector 3 at 100%
    with open(os.path.join(args.out, "t_10_-130.json")) as fh:
        pt = json.load(fh)
    pk = None
    for idx2 in range(len(pt["lat"])):
        if pt["lat"][idx2] == 10.0 and pt["lon"][idx2] == -130.0:
            pk = idx2
            break
    assert pk is not None, "probe cell missing from its tile"
    assert all(x == 85 for x in pt["tp"][pk]), pt["tp"][pk]
    # period distribution on the probe: Tp = 8 s always -> bin 6 carries 1000
    th5 = pt["th"][pk]
    assert len(th5) == 12 * JT_NB, len(th5)
    for m2 in range(12):
        row5 = th5[m2 * JT_NB:(m2 + 1) * JT_NB]
        assert row5[6] == 1000 and sum(v for v in row5 if v > 0) == 1000, row5
    assert mf["tp_hist"] == {"t0": 2, "step": 1, "nb": JT_NB}, mf.get("tp_hist")
    assert all(x == 3 for x in pt["wd"][pk]), pt["wd"][pk]
    assert all(x == 100 for x in pt["wp"][pk]), pt["wp"][pk]
    assert len(tile["tp"][k]) == 12 and all(20 <= x <= 160 for x in tile["tp"][k])
    # rose slice on the probe: sector 3 carries 100%, the rest 0, every month
    wr = pt["wr"][pk]
    assert len(wr) == 144, len(wr)
    for m2 in range(12):
        row2 = wr[m2 * 12:(m2 + 1) * 12]
        assert row2[3] == 100 and sum(row2) == 100, row2
    # diurnal on the probe: pattern value depends only on t%8 (utc slots
    # 0..12 h carry 0.5 m, 15..21 h carry 2.0 m); at 130 W the local-solar
    # slot mapping puts the rough hours in slots 2..4
    dh = pt["dh"][pk]
    assert len(dh) == 96, len(dh)
    expect_row = [5, 5, 20, 20, 20, 5, 5, 5]
    for m2 in range(12):
        assert dh[m2 * 8:(m2 + 1) * 8] == expect_row, dh[m2 * 8:(m2 + 1) * 8]
    assert all(v == 50 for v in pt["dw"][pk]), pt["dw"][pk][:8]
    # extremes on the probe: P99 and P99.9 both land in the 2.0 m bin (bin 8),
    # upper edge 2.25 m -> 23 dm, every month and annually
    hx = pt["hx"][pk]
    assert len(hx) == 24 and all(x == 23 for x in hx), hx
    assert pt["hxa"][pk] == [23, 23], pt["hxa"][pk]
    # wind on the probe: hypot(3,4)=5 m/s constant -> mean 50, P90 = bin 5
    # upper edge = 60
    assert all(x == 50 for x in pt["wm"][pk]), pt["wm"][pk]
    assert all(x == 60 for x in pt["w9"][pk]), pt["w9"][pk]
    # wind rose: u=3, v=4 everywhere -> wind FROM bearing atan2(-3, -4) =
    # 216.9 deg -> sector 7, 100% of samples
    assert all(x == 7 for x in pt["vd"][pk]), pt["vd"][pk]
    assert all(x == 100 for x in pt["vp"][pk]), pt["vp"][pk]
    vr = pt["vr"][pk]
    assert len(vr) == 144, len(vr)
    for m2 in range(12):
        row4 = vr[m2 * 12:(m2 + 1) * 12]
        assert row4[7] == 100 and sum(row4) == 100, row4
    # ENSO on the probe: month m sits wholly in phase m % 3 with 64 samples,
    # exceedance at 2.0 m = 24/64 = 375 permille, mean 1.0625 m -> 11 dm;
    # the other two phases read -1 / 0
    NT2 = len(THRESHOLDS)
    pn2, pm2, pe2 = pt["pn"][pk], pt["pm"][pk], pt["pe"][pk]
    assert len(pn2) == 36 and len(pm2) == 36 and len(pe2) == 36 * NT2
    for m2 in range(12):
        for p2 in range(3):
            k2 = m2 * 3 + p2
            erow = pe2[k2 * NT2:(k2 + 1) * NT2]
            if p2 == m2 % 3:
                assert pn2[k2] == 64 and pm2[k2] == 11, (m2, p2, pn2[k2], pm2[k2])
                assert erow[ti2] == 375 and erow[0] == 1000, (m2, p2, erow)
                assert all(erow[x3] >= erow[x3 + 1] for x3 in range(NT2 - 1)), erow
            else:
                assert pn2[k2] == 0 and pm2[k2] == -1, (m2, p2, pn2[k2], pm2[k2])
                assert all(x3 == -1 for x3 in erow), (m2, p2, erow)
    # weather windows on the probe: 8 calm 15 h runs per month over 2 years
    # -> 4 runs/yr x10 = 40 in the 12-24 h bin, for the 1.0 / 1.5 / 2.0 m
    # thresholds; the 2.5 / 3.0 m thresholds see only capped 240 h runs
    pwf = pt["pw"][pk]
    assert len(pwf) == 12 * P_NT * P_NB, len(pwf)
    for m2 in range(12):
        for x2 in range(3):
            row3 = pwf[m2 * P_NT * P_NB + x2 * P_NB:m2 * P_NT * P_NB + x2 * P_NB + P_NB]
            assert row3[2] == 40 and sum(row3) == 40, (m2, x2, row3)

    # ---- ONI parser on a fabricated table + span check
    os.makedirs(args.workdir, exist_ok=True)
    oni_path = os.path.join(args.workdir, "oni_selftest.txt")
    with open(oni_path, "w") as fh:
        fh.write(" SEAS  YR  TOTAL  ANOM\n"
                 " DJF 2000  26.00  0.70\n"
                 " JFM 2000  25.80 -0.60\n"
                 " FMA 2000  25.60  0.20\n"
                 " NDJ 2000  26.10 -0.50\n")
    ot = oni_parse(oni_path)
    assert ot[(2000, 1)] == 0 and ot[(2000, 2)] == 2, ot
    assert ot[(2000, 3)] == 1 and ot[(2000, 12)] == 2, ot
    try:
        oni_check_span(ot, 2000, 2000)
        raise AssertionError("oni_check_span accepted an incomplete year")
    except SystemExit:
        pass

    # ---- old checkpoints (no ENSO arrays) still load, zero-filled
    strip_dir = os.path.join(args.workdir, "strip_test")
    os.makedirs(strip_dir, exist_ok=True)
    payload = {k: acc[k] for k in ARRAY_KEYS + DIURNAL_KEYS}
    payload["version"] = acc["version"]
    payload["done"] = np.array(acc["done"])
    with open(os.path.join(strip_dir, CHECKPOINT), "wb") as fh:
        np.savez(fh, **payload)
    acc_old = load_accumulator(strip_dir)
    assert acc_old["en_nsamp"].sum() == 0 and acc_old["en_hist"].sum() == 0
    assert (acc_old["nsamp"] == acc["nsamp"]).all()
    del acc_old

    # ---- split-key round trip: save writes en_hist0..2, load restacks
    save_accumulator(strip_dir, acc)
    with np.load(os.path.join(strip_dir, CHECKPOINT), allow_pickle=False) as zrt:
        assert "en_hist0" in zrt.files and "en_hist" not in zrt.files
    acc_rt = load_accumulator(strip_dir)
    assert (acc_rt["en_hist"] == acc["en_hist"]).all()
    assert (acc_rt["en_nsamp"] == acc["en_nsamp"]).all()
    print("SELF TEST PASS")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", default="./era5_work")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "web", "data"))
    ap.add_argument("--years", default="1979-2024", help="inclusive span, e.g. 2010-2024")
    ap.add_argument("--download", action="store_true", help="download + accumulate via the CDS API")
    ap.add_argument("--emit", action="store_true", help="write manifest + tiles from the checkpoint")
    ap.add_argument("--merge", help="two checkpoint workdirs, comma separated: merge disjoint "
                                    "spans into --workdir (e.g. a 1980-2009 and a 2010-2024 build)")
    ap.add_argument("--vars", choices=["all", "wind"], default="all",
                    help="wind = swh + u10 + v10 only: completes the wind rose, "
                         "diurnal and ENSO accumulators for a span whose full "
                         "build predates them. The checkpoint is marked and "
                         "refuses --emit (half a dataset must never become tiles).")
    ap.add_argument("--synthetic", action="store_true", help="self test without CDS")
    ap.add_argument("--keep-nc", action="store_true", help="keep downloaded month files")
    ap.add_argument("--no-enso", action="store_true",
                    help="skip ENSO phase tagging (escape hatch if the NOAA ONI feed is down)")
    args = ap.parse_args()

    if args.synthetic:
        run_synthetic(args)
        return
    if args.merge:
        run_merge(args)
    if args.download:
        run_download(args)
    if args.emit:
        run_emit(args)
    if not (args.download or args.emit or args.merge):
        ap.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
