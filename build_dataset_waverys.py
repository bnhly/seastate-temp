#!/usr/bin/env python3
"""Sea State Explorer wave dataset from WAVERYS, the 0.2 degree CMEMS global
wave reanalysis (GLOBAL_MULTIYEAR_WAV_001_032, MFWAM with altimeter
assimilation). The quality-first backbone: 2.5x finer than ERA5 in each
direction, materially better nearshore and in enclosed seas, same free
Copernicus licence (commercial use with the credit line).

Same statistics and the SAME TILE SCHEMA as build_dataset_era5.py, so the
web app needs no changes - only the grid is finer (0.2 deg, 5 deg tiles) and
the wave source label changes. Differences from the ERA5 builder:

  - source is streamed from CMEMS (copernicusmarine), no CDS queue;
  - variables VHM0 / VTPK / VMDR (Hs, peak period, direction FROM);
  - WAVERYS carries no 10 m wind, so wind statistics are grafted at emit
    from an ERA5 checkpoint (--era5-workdir, nearest 0.5 deg cell). Without
    it the tiles carry wind = -1 and the app hides the wind line;
  - the joint Hs x Tp table is replaced by a plain Tp histogram (the tiles
    only ever needed the Tp distribution; the full scatter table lives in
    the ERA5 checkpoint if a client study ever wants it);
  - the accumulate loop is time-sliced and the emit latitude-banded so the
    6x larger grid fits a 16 GB machine;
  - an input ledger (audit.jsonl) is written from the first month: one line
    per source file with SHA256, bytes and samples added. verify_dataset.py
    covers this builder too: pass --builder waverys (and --era5-workdir to
    verify the grafted wind against its source checkpoint).

Usage (16 GB VM, ~1 TB streamed over a few days, checkpointed per month):
  python3 build_dataset_waverys.py --download --years 2010-2023 --workdir ~/wav_work
  python3 build_dataset_waverys.py --emit --workdir ~/wav_work \
      --era5-workdir ~/era5_work --out web/data
  python3 build_dataset_waverys.py --synthetic --out /tmp/wav_selftest

Auth: free Copernicus Marine account; copernicusmarine login once, or the
COPERNICUSMARINE_SERVICE_USERNAME / _PASSWORD environment variables.
"""

import argparse
import hashlib
import json
import math
import os
import sys
import zipfile

import numpy as np

WAV_DATASET = "cmems_mod_glo_wav_my_0.2deg_PT3H-i"
WAV_VARS = ["VHM0", "VTPK", "VMDR"]

RES = 0.2
LAT0, LON0 = -80.0, -180.0
NLAT, NLON = 851, 1800
STEP_H = 3
THRESHOLDS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10]
HS_BIN = 0.25
HS_NB = 60
TP_NB = 24                     # 1 s bins, 2..26 s (bin = clip(int(tp) - 2))
ROSE_SECT = 12
ROSE_BANDS = 4
P_THR = [1.0, 1.5, 2.0, 2.5, 3.0]
P_EDGES_H = [6, 12, 24, 48, 72, 120]
P_NB = len(P_EDGES_H) + 1
P_CAP_STEPS = 240 // STEP_H
TILE_DEG = 5
DI_NB = 8                      # diurnal: 3 h local-solar-time slots
CKPT_VERSION = 1
CHECKPOINT = "waverys_accum.npz"

DI_SLOT_CACHE = {}


def diurnal_col_slots(utc_h):
    """Local-solar 3 h slot per longitude column at a given UTC hour."""
    if utc_h not in DI_SLOT_CACHE:
        lons = LON0 + RES * np.arange(NLON)
        DI_SLOT_CACHE[utc_h] = (np.floor((utc_h + lons / 15.0 + 1.5) / 3.0)
                                .astype(np.int64) % DI_NB)
    return DI_SLOT_CACHE[utc_h]

# the ERA5 wind graft needs that build's grid
E5_RES, E5_LAT0, E5_LON0 = 0.5, -90.0, -180.0


def e5_row(lat, n):
    """Nearest ERA5 latitude row (no wrap: 90 N is the last row)."""
    return int(np.clip(round((lat - E5_LAT0) / E5_RES), 0, n - 1))


def e5_col(lon, n):
    """Nearest ERA5 longitude column WITH wrap. The last WAVERYS column
    (179.8) rounds to node 720, which is node 0 (-180.0, 0.2 deg away), not
    the clamped node 719 (179.5, 0.3 deg away). One column in 1800 mapped to
    the wrong node before this."""
    return int(round(((lon - E5_LON0) % 360.0) / E5_RES)) % n

ATTRIBUTION_TPL = (
    "Generated using E.U. Copernicus Marine Service Information: WAVERYS global wave "
    "reanalysis [%s], 3 hourly significant wave height, peak period and direction. "
    "%sNeither the European Commission nor ECMWF nor Mercator Ocean is responsible "
    "for any use of this information.")
WIND_NOTE = "Wind statistics from the ERA5 reanalysis (Copernicus C3S) on its 0.5 degree grid%s. "


def new_accumulator():
    return {
        "version": np.int32(CKPT_VERSION),
        "nsamp": np.zeros((12, NLAT, NLON), dtype=np.uint32),
        "hsum": np.zeros((12, NLAT, NLON), dtype=np.float64),
        "hs_hist": np.zeros((12, NLAT, NLON, HS_NB), dtype=np.uint16),
        "tp_hist": np.zeros((12, NLAT, NLON, TP_NB), dtype=np.uint16),
        "rose": np.zeros((12, NLAT, NLON, ROSE_SECT * ROSE_BANDS), dtype=np.uint16),
        "persist": np.zeros((len(P_THR), 12, NLAT, NLON, P_NB), dtype=np.uint16),
        "run_len": np.zeros((len(P_THR), NLAT, NLON), dtype=np.uint16),
        "run_m": np.zeros((len(P_THR), NLAT, NLON), dtype=np.uint8),
        # diurnal Hs in LOCAL SOLAR time (8 x 3 h slots); wind has no native
        # source here, its diurnal cycle grafts from the ERA5 checkpoint
        "dh_sum": np.zeros((12, DI_NB, NLAT, NLON), dtype=np.float32),
        "dh_cnt": np.zeros((12, DI_NB, NLAT, NLON), dtype=np.uint32),
        "done": [],
    }


ARRAY_KEYS = ["nsamp", "hsum", "hs_hist", "tp_hist", "rose", "persist", "run_len", "run_m",
              "dh_sum", "dh_cnt"]


def load_accumulator(workdir):
    path = os.path.join(workdir, CHECKPOINT)
    if not os.path.exists(path):
        return new_accumulator()
    z = np.load(path, allow_pickle=False)
    if int(z["version"]) != CKPT_VERSION:
        raise SystemExit("checkpoint version %s; this script writes v%d" %
                         (int(z["version"]), CKPT_VERSION))
    acc = {"version": np.int32(CKPT_VERSION), "done": [s for s in z["done"].tolist()]}
    for k in ARRAY_KEYS:
        acc[k] = z[k]
    return acc


def save_accumulator(workdir, acc):
    os.makedirs(workdir, exist_ok=True)
    tmp = os.path.join(workdir, CHECKPOINT + ".tmp")
    payload = {k: acc[k] for k in ARRAY_KEYS}
    payload["version"] = acc["version"]
    payload["done"] = np.array(acc["done"])
    with open(tmp, "wb") as fh:
        np.savez_compressed(fh, **payload)
    os.replace(tmp, os.path.join(workdir, CHECKPOINT))


# ---------------------------------------------------------------- accumulate

def accumulate_slice(acc, m, swh, tp, mwd, t_abs0=0):
    """One time-slice: swh/tp/mwd are (T, NLAT, NLON) float32, NaN dry.
    t_abs0 = absolute 3 h step index of the slice within its month, so the
    diurnal local-solar slots stay aligned across slices."""
    NCELL = NLAT * NLON
    cell_idx = np.arange(NCELL, dtype=np.int64)
    hs_hist = acc["hs_hist"][m].reshape(NCELL, HS_NB)
    tp_hist = acc["tp_hist"][m].reshape(NCELL, TP_NB)
    rose = acc["rose"][m].reshape(NCELL, ROSE_SECT * ROSE_BANDS)
    nsamp = acc["nsamp"][m].reshape(NCELL)
    hsum = acc["hsum"][m].reshape(NCELL)

    for t in range(swh.shape[0]):
        h = swh[t].reshape(NCELL)
        ok = np.isfinite(h)
        oki = cell_idx[ok]
        hv = h[oki]
        nsamp[oki] += 1
        hsum[oki] += hv
        hb = np.minimum((hv / HS_BIN).astype(np.int64), HS_NB - 1)
        np.add.at(hs_hist, (oki, hb), 1)

        tv = tp[t].reshape(NCELL)[oki]
        tok = np.isfinite(tv)
        tb = np.clip(tv[tok].astype(np.int64) - 2, 0, TP_NB - 1)
        np.add.at(tp_hist, (oki[tok], tb), 1)

        dv = mwd[t].reshape(NCELL)[oki]
        dok = np.isfinite(dv)
        sect = ((dv[dok] % 360.0) / 30.0).astype(np.int64) % ROSE_SECT
        band = np.digitize(hv[dok], [1.5, 2.5, 4.0])
        np.add.at(rose, (oki[dok], sect * ROSE_BANDS + band), 1)

        slots = diurnal_col_slots(3 * ((t_abs0 + t) % 8))
        fin2 = np.isfinite(swh[t])
        swh_t = np.where(fin2, swh[t], np.float32(0.0))
        for s2 in range(DI_NB):
            cols = slots == s2
            if cols.any():
                acc["dh_sum"][m, s2][:, cols] += swh_t[:, cols]
                acc["dh_cnt"][m, s2][:, cols] += fin2[:, cols]

        for ti in range(len(P_THR)):
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
                np.add.at(persist, (run_m[ci].astype(np.int64), ci,
                                    np.full(len(ci), P_NB - 1)), 1)
                run_len[ci] = 0


def cm_fetch_month(args, year, month):
    import copernicusmarine
    t0 = "%04d-%02d-01T00:00:00" % (year, month)
    if month == 12:
        t1 = "%04d-01-01T00:00:00" % (year + 1)
    else:
        t1 = "%04d-%02d-01T00:00:00" % (year, month + 1)
    t1 = str(np.datetime64(t1) - np.timedelta64(1, "h"))
    fname = "wav_%04d_%02d.nc" % (year, month)
    kwargs = dict(dataset_id=args.dataset, variables=WAV_VARS,
                  start_datetime=t0, end_datetime=t1,
                  output_directory=args.workdir, output_filename=fname,
                  overwrite=True)
    try:
        copernicusmarine.subset(**kwargs)
    except TypeError:
        kwargs.pop("overwrite", None)
        try:
            copernicusmarine.subset(force_download=True, **kwargs)
        except TypeError:
            copernicusmarine.subset(**kwargs)
    return os.path.join(args.workdir, fname)


def grid_window(lats, lons):
    """Map our fixed emit grid onto the file's grid.

    CMEMS changed WAVERYS coverage: the 202411 version serves 899 latitude
    rows (-89.8 to 89.8) where this build was written against 851 rows from
    -80 to 90. Hardcoding the shape turned that into a hard stop on Ben's
    first real run (1 Sep 26). The tool has no use for latitudes beyond
    +/-80, so the file is WINDOWED onto the fixed grid instead of the grid
    being adopted: checkpoint format, emitter, tile scheme and ERA5 wind
    graft all stay as they are.

    The overlap can be partial - the new coverage stops at 89.8 and so does
    not contain our top row (90.0 N, a polar point that is ice and carries
    no waves) - so this returns the destination rows that the file can fill
    and the source rows to fill them from. Everything outside stays NaN,
    which the accumulator already treats as no data.

    Returns {i0, j0, r0, r1, c0, c1}: our grid rows r0..r1 come from file
    rows i0+r0..i0+r1, likewise columns."""
    if len(lats) < 2 or float(lats[1]) < float(lats[0]):
        raise SystemExit("latitudes are not ascending (%.2f then %.2f); the grid "
                         "window assumes ascending order" % (lats[0], lats[1]))
    i0 = int(round((LAT0 - float(lats[0])) / RES))
    j0 = int(round((LON0 - float(lons[0])) / RES))
    r0, r1 = max(0, -i0), min(NLAT, len(lats) - i0)
    c0, c1 = max(0, -j0), min(NLON, len(lons) - j0)
    # strict: a file covering exactly half the world (0..359.8 E) is not a
    # usable window either, it leaves a hemisphere NaN with only a log line
    if r1 - r0 <= NLAT // 2 or c1 - c0 <= NLON // 2:
        raise SystemExit("file grid %dx%d from %.2f,%.2f overlaps the %dx%d grid "
                         "from %.1f,%.1f in only %dx%d cells"
                         % (len(lats), len(lons), lats[0], lons[0], NLAT, NLON,
                            LAT0, LON0, r1 - r0, c1 - c0))
    # quarter-cell tolerance: at exactly half a cell a 0.1 deg offset lattice
    # (e.g. -89.9..89.7) slipped through and every tile sat 0.1 deg off
    if (abs(float(lats[i0 + r0]) - (LAT0 + r0 * RES)) > 0.25 * RES or
            abs(float(lons[j0 + c0]) - (LON0 + c0 * RES)) > 0.25 * RES):
        raise SystemExit("file grid is offset from the expected %.1f deg lattice "
                         "(row %d is %.3f, wanted %.3f)"
                         % (RES, i0 + r0, float(lats[i0 + r0]), LAT0 + r0 * RES))
    return {"i0": i0, "j0": j0, "r0": r0, "r1": r1, "c0": c0, "c1": c1}


def accumulate_month_file(acc, m, path):
    """Stream a month netCDF in day-sized slices, windowed to our grid."""
    import xarray as xr
    ds = xr.open_dataset(path)
    lats = ds["latitude"].values
    lons = ds["longitude"].values
    w = grid_window(lats, lons)
    full = (w["r1"] - w["r0"] == NLAT and w["c1"] - w["c0"] == NLON)
    if not full or w["i0"] or w["j0"]:
        print("  file grid %dx%d from %.2f,%.2f -> our rows %d..%d from file rows "
              "%d..%d%s" % (len(lats), len(lons), lats[0], lons[0], w["r0"], w["r1"] - 1,
                            w["i0"] + w["r0"], w["i0"] + w["r1"] - 1,
                            "" if full else " (the rest has no data in this file)"))
        sys.stdout.flush()
    lat_sl = slice(w["i0"] + w["r0"], w["i0"] + w["r1"])
    lon_sl = slice(w["j0"] + w["c0"], w["j0"] + w["c1"])
    T = ds.sizes["time"]
    step = 8

    def windowed(name, t0, t1):
        """File values placed on our grid; anything the file does not cover
        stays NaN, which accumulate_slice counts as no data."""
        sub = ds[name].isel(time=slice(t0, t1), latitude=lat_sl,
                            longitude=lon_sl).values.astype(np.float32)
        if full:
            return sub
        out = np.full((sub.shape[0], NLAT, NLON), np.nan, dtype=np.float32)
        out[:, w["r0"]:w["r1"], w["c0"]:w["c1"]] = sub
        return out

    for t0 in range(0, T, step):
        t1 = min(T, t0 + step)
        accumulate_slice(acc, m, windowed("VHM0", t0, t1), windowed("VTPK", t0, t1),
                         windowed("VMDR", t0, t1), t_abs0=t0)
    ds.close()
    return T


def run_download(args):
    span = args.years.split("-")
    y0, y1 = int(span[0]), int(span[1])
    os.makedirs(args.workdir, exist_ok=True)
    acc = load_accumulator(args.workdir)
    total = (y1 - y0 + 1) * 12
    for year in range(y0, y1 + 1):
        for month in range(1, 13):
            key = "%04d-%02d" % (year, month)
            if key in acc["done"]:
                continue
            print("[%s] fetching from CMEMS..." % key, flush=True)
            path = cm_fetch_month(args, year, month)
            sha = hashlib.sha256()
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    sha.update(chunk)
            fbytes = os.path.getsize(path)
            print("[%s] accumulating..." % key, flush=True)
            ns_before = int(acc["nsamp"].sum())
            hs_before = float(acc["hsum"].sum())
            accumulate_month_file(acc, month - 1, path)
            acc["done"].append(key)
            save_accumulator(args.workdir, acc)
            ns_added = int(acc["nsamp"].sum()) - ns_before
            hs_added = float(acc["hsum"].sum()) - hs_before
            with open(os.path.join(args.workdir, "audit.jsonl"), "a") as fh:
                fh.write(json.dumps({
                    "month": key, "sha256": sha.hexdigest(), "bytes": fbytes,
                    "samples_added": ns_added,
                    "global_mean_hs": round(hs_added / max(ns_added, 1), 4),
                }) + "\n")
            os.remove(path)
            print("[%s] done (%d / %d months in checkpoint)"
                  % (key, len(acc["done"]), total), flush=True)
    print("Download + accumulation complete: %d months." % len(acc["done"]))


# ---------------------------------------------------------------- emit

def load_era5_wind(era5_workdir):
    """wind_hist / wind_sum / wind_n from the ERA5 checkpoint, or None."""
    path = os.path.join(era5_workdir, "seastate_accum.npz")
    if not os.path.exists(path):
        raise SystemExit("no ERA5 checkpoint at %s (drop --era5-workdir to emit "
                         "without wind)" % path)
    z = np.load(path, allow_pickle=False)
    out = {"wind_hist": z["wind_hist"], "wind_sum": z["wind_sum"], "wind_n": z["wind_n"],
           "nb": z["wind_hist"].shape[-1]}
    # the ERA5 emitter refuses wind for a cell-month holding under 30 percent
    # of that month's global maximum sample count (its ice rule); wind_n is
    # that count (wind is accumulated only on steps whose wave field is
    # finite, the self test asserts wind_n == nsamp). Carry the same mask so
    # a grafted field never comes from a source cell the ERA5 build itself
    # would have emitted as -1 (the two models' ice edges differ).
    wn_all = z["wind_n"]
    wn_max = np.maximum(wn_all.reshape(12, -1).max(axis=1), 1)
    out["ok"] = wn_all >= (0.3 * wn_max)[:, None, None]
    out["span_raw"] = ""
    # the graft file's month list names the span its wind actually covers,
    # which can differ from the wave period; surface it in the attribution
    # rather than letting the wave years imply more than the wind holds.
    # span_note wins when present: the 2 Sep 26 graft mixes families (mean
    # wind 1980-2024, direction rose / diurnal / ENSO 1980-2009) and one
    # year range cannot say that.
    if "span_note" in z.files:
        out["span"] = " (" + str(z["span_note"]) + ")"
        out["span_raw"] = str(z["span_note"])
    else:
        dn = [str(x) for x in z["done"].tolist()] if "done" in z.files else []
        dn = [x for x in dn if len(x) >= 7 and x[:4].isdigit()]
        out["span"] = (" (" + dn[0][:4] + "-" + dn[-1][:4] + ")") if dn else ""
        out["span_raw"] = (dn[0][:4] + "-" + dn[-1][:4]) if dn else ""
    # diurnal wind exists only in ERA5 spans built from 20 Aug 26 on
    if "dw_sum" in z.files and "dw_cnt" in z.files:
        out["dw_sum"] = z["dw_sum"]
        out["dw_cnt"] = z["dw_cnt"]
    if "wind_rose" in z.files:
        out["wind_rose"] = z["wind_rose"]
    # ENSO phase split (spans built from 23 Aug 26 on): grafted onto the
    # 0.2 deg tiles the same way as the wind fields - phase anomalies are
    # large-scale, so the 0.5 deg source is the right resolution for them
    if "en_nsamp" in z.files and z["en_nsamp"].any():
        out["en_nsamp"] = z["en_nsamp"]
        out["en_hsum"] = z["en_hsum"]
        # the phase histograms are streamed from the file one phase at a
        # time at emit; holding all three (1.1 GB) tipped the emit over
        out["en_path"] = path
        out["en_split"] = "en_hist0" in z.files
    return out


def run_emit(args, acc=None):
    if acc is None:
        acc = load_accumulator(args.workdir)
    if not acc["done"]:
        raise SystemExit("Nothing accumulated: run --download (or --synthetic) first.")
    os.makedirs(args.out, exist_ok=True)

    years = sorted({int(k.split("-")[0]) for k in acc["done"]})
    period = "%d-%d" % (years[0], years[-1])
    n_years = max(1.0, len(acc["done"]) / 12.0)
    nsamp = acc["nsamp"]
    max_ns = np.maximum(nsamp.reshape(12, -1).max(axis=1), 1)

    wind = None
    wr_sect = wr_pct = wr_rose = None
    stray = os.path.join(args.workdir, "seastate_accum.npz")
    if not args.era5_workdir and os.path.exists(stray):
        raise SystemExit("an ERA5 graft sits at %s but --era5-workdir was not given: the tiles "
                         "would carry no wind, wind rose, diurnal wind or ENSO fields and "
                         "nothing downstream would notice (the data host emit of 3 Sep 26 did "
                         "exactly this). Pass --era5-workdir %s, or move the file away to emit "
                         "wave-only tiles on purpose." % (stray, args.workdir))
    if args.era5_workdir:
        wind = load_era5_wind(args.era5_workdir)
        print("wind graft: ERA5 checkpoint loaded")
        if "wind_rose" in wind and wind["wind_rose"].any():
            wsh = wind["wind_rose"].shape          # [12, elat, elon, 48]
            wrs_all = wind["wind_rose"].reshape(12, wsh[1], wsh[2], 12, 4).sum(axis=-1, dtype=np.int32)
            wrtot = wrs_all.sum(axis=-1)
            wr_sect = np.where(wrtot > 0, np.argmax(wrs_all, axis=-1), -1).astype(np.int32)
            wpeak = np.take_along_axis(wrs_all, np.maximum(wr_sect, 0)[..., None].astype(np.int64),
                                       axis=-1)[..., 0]
            wr_pct = np.where(wrtot > 0,
                              np.round(100.0 * wpeak / np.maximum(wrtot, 1)).astype(np.int32), -1)
            wr_rose = np.round(100.0 * wrs_all / np.maximum(wrtot[..., None], 1)).astype(np.int16)
            wr_rose[wrtot == 0] = -1
    en = None
    if wind is not None and "en_nsamp" in wind:
        # precompute the grafted phase stats ONCE, one phase at a time, then
        # drop the histogram: keeping it resident through the emit (or the
        # full 5-D int64 temporaries) OOM-killed the self test on a 15 GB box
        print("enso graft: ERA5 phase split present")
        en_ns_g = wind["en_nsamp"]
        NTg = len(THRESHOLDS)
        gsh = en_ns_g.shape                      # (3, 12, elat, elon)
        en_exc_g = np.full(gsh + (NTg,), -1, dtype=np.int16)
        en_mean_g = np.full(gsh, -1, dtype=np.int16)
        tbg = [int(round(t / HS_BIN)) for t in THRESHOLDS]
        z9 = np.load(wind["en_path"], allow_pickle=False)
        for p9 in range(3):
            # one phase from disk, one (phase, month) slice per step: cumsum
            # promotes integer input to int64, so anything bigger ran to
            # gigabytes of temporaries (a legacy unsplit checkpoint pays a
            # full load per phase here; only pre-split test runs have one)
            ph_hist = z9["en_hist%d" % p9] if wind["en_split"] else z9["en_hist"][p9]
            for m9 in range(12):
                cum9 = np.cumsum(ph_hist[m9][..., ::-1].astype(np.int64),
                                 axis=-1)[..., ::-1]
                ns9 = en_ns_g[p9, m9]
                ok9 = ns9 > 0
                with np.errstate(divide="ignore", invalid="ignore"):
                    m9v = np.round(10.0 * wind["en_hsum"][p9, m9] / np.maximum(ns9, 1)).astype(np.int16)
                en_mean_g[p9, m9][ok9] = m9v[ok9]
                for x9 in range(NTg):
                    cnt9 = cum9[..., tbg[x9]] if tbg[x9] < cum9.shape[-1] \
                        else np.zeros_like(ns9, dtype=np.int64)
                    with np.errstate(divide="ignore", invalid="ignore"):
                        e9v = np.round(1000.0 * cnt9 / np.maximum(ns9, 1)).astype(np.int16)
                    en_exc_g[p9, m9, :, :, x9][ok9] = e9v[ok9]
                del cum9
            del ph_hist
        del wind["en_hsum"]
        en = {"ns": en_ns_g, "exc": en_exc_g, "mean": en_mean_g}

    thr_bins = [int(round(t / HS_BIN)) for t in THRESHOLDS]
    NT = len(THRESHOLDS)
    tile_ids = []
    total_cells = 0

    # latitude-banded processing bounds BOTH the int64 temporaries and the
    # tile buffers on the 6x grid: a 5 deg tile nests exactly inside a 10 deg
    # band (LAT0 = -80 is 5 deg aligned), so each band's tiles are complete
    # at band end and are written and freed there - holding the whole
    # ocean's tiles as Python lists needs ~20 GB and cannot work
    band_rows = int(TILE_DEG / RES) * 2
    for r0 in range(0, NLAT, band_rows):
        tiles = {}
        r1 = min(NLAT, r0 + band_rows)
        ns_b = nsamp[:, r0:r1, :]
        ocean = ns_b.sum(axis=0) > 0
        if not ocean.any():
            continue
        valid_b = ns_b >= (0.3 * max_ns)[:, None, None]
        # int32 with explicit dtype everywhere: cumsum/sum silently promote
        # integer input to int64, which doubled every temporary in this block
        # and (with the ENSO tile fields) tipped the emit past 14 GB
        hs32 = acc["hs_hist"][:, r0:r1, :].astype(np.int32)
        cum_r = np.cumsum(hs32[..., ::-1], axis=-1, dtype=np.int32)[..., ::-1]
        with np.errstate(divide="ignore", invalid="ignore"):
            mean_dm = np.round(10.0 * acc["hsum"][:, r0:r1, :] / ns_b).astype(np.int32)
        mean_dm[~valid_b] = -1

        tot_m = hs32.sum(axis=-1, dtype=np.int64)
        cum = np.cumsum(hs32, axis=-1, dtype=np.int32)

        def pctl(c, tot, q):
            need = np.ceil(q * tot).astype(np.int64)
            b = np.argmax(c >= np.maximum(need, 1)[..., None], axis=-1)
            return np.floor((b + 1) * HS_BIN * 10.0 + 0.5).astype(np.int32)

        p99_m = pctl(cum, tot_m, 0.99)
        p999_m = pctl(cum, tot_m, 0.999)
        p99_m[~valid_b] = -1
        p999_m[~valid_b] = -1
        del cum
        hs_all = hs32.sum(axis=0, dtype=np.int32)
        del hs32
        tot_all = hs_all.sum(axis=-1, dtype=np.int64)
        cum_all = np.cumsum(hs_all, axis=-1, dtype=np.int32)
        p99_a = pctl(cum_all, tot_all, 0.99)
        p999_a = pctl(cum_all, tot_all, 0.999)
        p99_a[tot_all == 0] = -1
        p999_a[tot_all == 0] = -1
        del hs_all, cum_all

        tp32 = acc["tp_hist"][:, r0:r1, :].astype(np.int32)
        tptot = tp32.sum(axis=-1, dtype=np.int64)
        tpcum = np.cumsum(tp32, axis=-1, dtype=np.int32)
        med = np.argmax(tpcum * 2 >= tptot[..., None], axis=-1)
        del tpcum
        tp_ds = np.round((med + 2.5) * 10).astype(np.int32)
        tp_ds[~(valid_b & (tptot > 0))] = -1
        # peak-period distribution, permille per 1 s bin (2..26 s, ends clamp)
        tp_pml = np.round(1000.0 * tp32 / np.maximum(tptot[..., None], 1)).astype(np.int16)
        tp_pml[~(valid_b & (tptot > 0))] = -1
        del tp32

        rs = acc["rose"][:, r0:r1, :].reshape(12, r1 - r0, NLON, ROSE_SECT, ROSE_BANDS) \
            .sum(axis=-1, dtype=np.int32)
        rtot = rs.sum(axis=-1, dtype=np.int64)
        sect = np.argmax(rs, axis=-1).astype(np.int32)
        peak = np.take_along_axis(rs, sect[..., None].astype(np.int64), axis=-1)[..., 0]
        okr = valid_b & (rtot > 0)
        dir_sect = np.where(okr, sect, -1)
        dir_pct = np.where(okr, np.round(100.0 * peak / np.maximum(rtot, 1)).astype(np.int32), -1)
        rose_pct = np.round(100.0 * rs / np.maximum(rtot[..., None], 1)).astype(np.int16)
        rose_pct[~okr] = -1
        del rs

        pw10 = np.round(10.0 * acc["persist"][:, :, r0:r1, :, :].astype(np.float32) / np.float32(n_years)) \
            .astype(np.int32)
        pw10 = np.transpose(pw10, (1, 2, 3, 0, 4))
        pw10[~valid_b, :, :] = -1

        dhs = acc["dh_sum"][:, :, r0:r1, :]
        dhc = acc["dh_cnt"][:, :, r0:r1, :]
        with np.errstate(divide="ignore", invalid="ignore"):
            dh_b = np.round(10.0 * dhs / np.maximum(dhc, 1)).astype(np.int32)
        dh_b[dhc == 0] = -1
        dh_b = np.transpose(dh_b, (0, 2, 3, 1))     # [12, rows, NLON, DI_NB]
        dh_b[~valid_b] = -1
        have_diurnal = bool((acc["dh_cnt"] > 0).any())


        lat_idx, lon_idx = np.where(ocean)
        total_cells += len(lat_idx)
        cur_trow = None
        for k in range(len(lat_idx)):
            ib, j = int(lat_idx[k]), int(lon_idx[k])
            i = r0 + ib
            lat = LAT0 + i * RES
            lon = LON0 + j * RES
            tj = int((lon + 180) // TILE_DEG) % (360 // TILE_DEG)
            ti_ = int(min((180 // TILE_DEG) - 1, (lat + 90) // TILE_DEG))
            tid = "t_%d_%d" % (-90 + ti_ * TILE_DEG, -180 + tj * TILE_DEG)
            # flush per 5 deg tile row, not per 10 deg band: with the ENSO
            # fields a full band's tile lists alone ran to ~2 GB
            if cur_trow is None:
                cur_trow = ti_
            elif ti_ != cur_trow:
                for tid9 in tiles:
                    with open(os.path.join(args.out, tid9 + ".json"), "w") as fh:
                        json.dump(tiles[tid9], fh, separators=(",", ":"))
                    tile_ids.append(tid9)
                tiles.clear()
                cur_trow = ti_
            t = tiles.setdefault(tid, {"format": 1, "lat": [], "lon": [], "n": [], "mean": [],
                                       "exc": [], "tp": [], "th": [], "wd": [], "wp": [], "wr": [],
                                       "hx": [], "hxa": [], "wm": [], "w9": [], "pw": [],
                                       "dh": [], "dw": [], "vd": [], "vp": [], "vr": [],
                                       "pn": [], "pm": [], "pe": []})
            t["lat"].append(round(lat, 2))
            t["lon"].append(round(lon, 2))
            t["n"].append([int(ns_b[m, ib, j]) for m in range(12)])
            t["mean"].append([int(mean_dm[m, ib, j]) for m in range(12)])
            t["tp"].append([int(tp_ds[m, ib, j]) for m in range(12)])
            t["th"].append([int(tp_pml[m, ib, j, b]) for m in range(12) for b in range(TP_NB)])
            t["wd"].append([int(dir_sect[m, ib, j]) for m in range(12)])
            t["wp"].append([int(dir_pct[m, ib, j]) for m in range(12)])
            t["wr"].append([int(rose_pct[m, ib, j, s]) for m in range(12) for s in range(ROSE_SECT)])
            t["hx"].append([int(x) for m in range(12) for x in (p99_m[m, ib, j], p999_m[m, ib, j])])
            t["hxa"].append([int(p99_a[ib, j]), int(p999_a[ib, j])])
            if wind is not None:
                ei = e5_row(lat, wind["wind_n"].shape[1])
                ej = e5_col(lon, wind["wind_n"].shape[2])
                wmv, w9v = [], []
                for m in range(12):
                    wn = int(wind["wind_n"][m, ei, ej])
                    wh = wind["wind_hist"][m, ei, ej].astype(np.int64)
                    wtot = int(wh.sum())
                    if not valid_b[m, ib, j] or wtot == 0 or not wind["ok"][m, ei, ej]:
                        wmv.append(-1)
                        w9v.append(-1)
                        continue
                    wmv.append(int(np.round(10.0 * float(wind["wind_sum"][m, ei, ej]) / max(wn, 1))))
                    need = int(math.ceil(0.9 * wtot))
                    runsum = 0
                    wb = wind["nb"] - 1
                    for b in range(wind["nb"]):
                        runsum += int(wh[b])
                        if runsum >= max(need, 1):
                            wb = b
                            break
                    w9v.append((wb + 1) * 10)
                t["wm"].append(wmv)
                t["w9"].append(w9v)
            else:
                t["wm"].append([-1] * 12)
                t["w9"].append([-1] * 12)
            t["pw"].append([int(pw10[m, ib, j, x, b])
                            for m in range(12) for x in range(len(P_THR)) for b in range(P_NB)])
            if have_diurnal:
                t["dh"].append([int(dh_b[m, ib, j, s]) for m in range(12) for s in range(DI_NB)])
            else:
                t["dh"].append([])
            if wr_sect is not None:
                ei3 = e5_row(lat, wr_sect.shape[1])
                ej3 = e5_col(lon, wr_sect.shape[2])
                ok3 = [bool(valid_b[m, ib, j] and wind["ok"][m, ei3, ej3]) for m in range(12)]
                t["vd"].append([int(wr_sect[m, ei3, ej3]) if ok3[m] else -1
                                for m in range(12)])
                t["vp"].append([int(wr_pct[m, ei3, ej3]) if ok3[m] else -1
                                for m in range(12)])
                t["vr"].append([int(wr_rose[m, ei3, ej3, s]) if ok3[m] else -1
                                for m in range(12) for s in range(12)])
            else:
                t["vd"].append([])
                t["vp"].append([])
                t["vr"].append([])
            if wind is not None and "dw_sum" in wind:
                ei2 = e5_row(lat, wind["dw_sum"].shape[2])
                ej2 = e5_col(lon, wind["dw_sum"].shape[3])
                dwrow = []
                for m in range(12):
                    for s in range(DI_NB):
                        cnt = int(wind["dw_cnt"][m, s, ei2, ej2])
                        if cnt == 0 or not valid_b[m, ib, j] or not wind["ok"][m, ei2, ej2]:
                            dwrow.append(-1)
                        else:
                            dwrow.append(int(np.round(10.0 * float(wind["dw_sum"][m, s, ei2, ej2]) / cnt)))
                t["dw"].append(dwrow)
            else:
                t["dw"].append([])
            if en is not None:
                ei4 = e5_row(lat, en["ns"].shape[2])
                ej4 = e5_col(lon, en["ns"].shape[3])
                t["pn"].append([int(en["ns"][p, m, ei4, ej4])
                                for m in range(12) for p in range(3)])
                ok4 = [bool(valid_b[m, ib, j] and wind["ok"][m, ei4, ej4]) for m in range(12)]
                t["pm"].append([int(en["mean"][p, m, ei4, ej4]) if ok4[m] else -1
                                for m in range(12) for p in range(3)])
                t["pe"].append([int(en["exc"][p, m, ei4, ej4, x9]) if ok4[m] else -1
                                for m in range(12) for p in range(3) for x9 in range(NT)])
            else:
                t["pn"].append([])
                t["pm"].append([])
                t["pe"].append([])
            flat = []
            for m in range(12):
                if valid_b[m, ib, j]:
                    ns = int(ns_b[m, ib, j])
                    for xb in thr_bins:
                        cnt = int(cum_r[m, ib, j, xb]) if xb < HS_NB else 0
                        flat.append(int(round(1000.0 * cnt / ns)) if ns else -1)
                else:
                    flat.extend([-1] * NT)
            t["exc"].append(flat)

        for tid, t in tiles.items():
            with open(os.path.join(args.out, tid + ".json"), "w") as fh:
                json.dump(t, fh, separators=(",", ":"))
            tile_ids.append(tid)
        tiles = None

    # coarse mean raster for map shading (2 deg cells, nsamp weighted)
    g_res, g_nlat, g_nlon = 2, 90, 180
    mean_grid = []
    cells_per = int(g_res / RES)
    pad = np.zeros((12, 900, NLON))
    padn = np.zeros((12, 900, NLON))
    off = int(round((LAT0 + 90) / RES))
    max_ns_b = (0.3 * max_ns)[:, None, None]
    valid_full = nsamp >= max_ns_b
    # the grid includes the lat 90 row (row NLAT-1); the 2 deg raster spans
    # -90..90 in 90 rows of 10 cells, so the pole row is dropped
    padn[:, off:off + NLAT - 1, :] = np.where(valid_full, nsamp, 0)[:, :NLAT - 1, :]
    pad[:, off:off + NLAT - 1, :] = np.where(valid_full, acc["hsum"], 0.0)[:, :NLAT - 1, :]
    for m in range(12):
        w2 = padn[m].reshape(g_nlat, cells_per, g_nlon, NLON // g_nlon).sum(axis=(1, 3))
        h2 = pad[m].reshape(g_nlat, cells_per, g_nlon, NLON // g_nlon).sum(axis=(1, 3))
        with np.errstate(divide="ignore", invalid="ignore"):
            mg = np.where(w2 > 0, np.round(10.0 * h2 / w2), -1).astype(int)
        mean_grid.append([int(x) for x in mg.flatten()])
    with open(os.path.join(args.out, "meanhs.json"), "w") as fh:
        # block (r, c) sums 10 x 10 cells whose centres run -90 + 2r .. -90 + 2r + 1.8
        # (and likewise in longitude), so the block centre is 0.9 deg past the
        # round number, not 1.0: the client places the block at lat0 + 2r
        json.dump({"res": g_res, "lat0": -89.1, "lon0": -179.1, "nlat": g_nlat, "nlon": g_nlon,
                   "mean": mean_grid}, fh, separators=(",", ":"))

    manifest = {
        "format": 1,
        "source": "WAVERYS",
        "source_label": "WAVERYS wave reanalysis (Copernicus Marine)" +
                        (" + ERA5 wind" if wind is not None else ""),
        "period": period + ", 3 hourly",
        "attribution": ATTRIBUTION_TPL % (period, (WIND_NOTE % wind.get("span", "")) if wind is not None else ""),
        "grid": {"res": RES, "lat0": LAT0, "lon0": LON0},
        "thresholds": THRESHOLDS,
        "persist": {"thresholds": P_THR, "edges_h": P_EDGES_H},
        "tp_hist": {"t0": 2, "step": 1, "nb": TP_NB},
        "wind": wind is not None,
        "enso": ({"phases": ["elnino", "neutral", "lanina"],
                  "index": "ONI (NOAA CPC, ERSSTv5), +/-0.5 C monthly threshold",
                  "source": "ERA5 0.5 deg graft",
                  "period": wind["span_raw"] if wind is not None else "",
                  "note": "phase means and exceedances are ERA5 wave statistics for the "
                          "graft period, not WAVERYS; compare phases against each other, "
                          "not against the headline mean"}
                 if en is not None else False),
        "tile_deg": TILE_DEG,
        "max_snap_km": 150,
        "tiles": sorted(tile_ids),
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    sizes = sum(os.path.getsize(os.path.join(args.out, f)) for f in os.listdir(args.out))
    print("emitted %d tiles (%d cells) + manifest + meanhs to %s (%.1f MB)"
          % (len(tile_ids), total_cells, args.out, sizes / 1e6))


# ---------------------------------------------------------------- synthetic self test

def run_synthetic(args):
    print("synthetic self test on the real 0.2 deg grid (needs ~8 GB RAM)...")
    acc = new_accumulator()
    rng = np.random.default_rng(9)
    lats = LAT0 + RES * np.arange(NLAT)
    base = 1.5 + 2.5 * np.exp(-((np.abs(lats) - 50.0) / 18.0) ** 2)
    land = np.zeros((NLAT, NLON), dtype=bool)
    land[(np.abs(lats) < 30)[:, None] & (np.abs(LON0 + RES * np.arange(NLON)) < 20)[None, :]] = True

    pi = int(round((10.0 - LAT0) / RES))
    pj = int(round((-130.0 - LON0) / RES))
    pattern = np.array(([0.5] * 5 + [2.0] * 3) * 2, dtype=np.float32)   # nt=16

    nt = 16
    for year in (2001, 2002):
        for month in range(1, 13):
            seas = 1.0 + 0.35 * math.cos(2 * math.pi * (month - 1) / 12.0)
            mean = (base * seas)[None, :, None].astype(np.float32)
            swh = rng.weibull(2.0, size=(nt, NLAT, NLON)).astype(np.float32) * mean / np.float32(0.886)
            swh[:, land] = np.nan
            swh[:, pi, pj] = pattern
            tp = np.full_like(swh, 8.0)
            mwd = np.full_like(swh, 90.0)
            tp[:, land] = np.nan
            mwd[:, land] = np.nan
            accumulate_slice(acc, month - 1, swh, tp, mwd)
            acc["done"].append("%04d-%02d" % (year, month))

    assert (acc["hs_hist"].sum(axis=-1) == acc["nsamp"]).all()
    assert (acc["tp_hist"].sum(axis=-1) == acc["nsamp"]).all()
    assert (acc["rose"].sum(axis=-1) == acc["nsamp"]).all()
    assert acc["nsamp"][0, pi, pj] == 32
    # probe: 6 of 16 samples >= 2.0 per file -> 12 of 32
    hb2 = int(round(2.0 / HS_BIN))
    assert int(acc["hs_hist"][0, pi, pj, hb2:].sum()) == 12
    # calm runs at 1.0 m: 2 x 15 h per file -> bin 2, 4 per month over 2 years
    assert (acc["persist"][0, :, pi, pj, 2] == 4).all()

    # a fake ERA5 wind checkpoint: constant 5 m/s -> mean 50, P90 60
    e5 = {"wind_hist": np.zeros((12, 361, 720, 40), dtype=np.uint16),
          "wind_sum": np.zeros((12, 361, 720)), "wind_n": np.zeros((12, 361, 720), dtype=np.uint32)}
    e5["wind_hist"][:, :, :, 5] = 64
    e5["wind_n"][:] = 64
    e5["wind_sum"][:] = 64 * 5.0
    dw_sum = np.full((12, DI_NB, 361, 720), 8 * 5.0, dtype=np.float32)
    dw_cnt = np.full((12, DI_NB, 361, 720), 8, dtype=np.uint32)
    wrose = np.zeros((12, 361, 720, 48), dtype=np.uint16)
    wrose[:, :, :, 7 * 4] = 64          # all wind from sector 7, lightest band
    # fake ENSO split: every month neutral (phase 1), 32 samples, 20 in the
    # 0.5 m bin + 12 in the 2.0 m bin -> exc(2.0) = 375 permille, mean 1.0625 m
    en_ns = np.zeros((3, 12, 361, 720), dtype=np.uint32)
    en_ns[1] = 32
    en_hs = np.zeros((3, 12, 361, 720), dtype=np.float64)
    en_hs[1] = 32 * 1.0625
    en_hi = np.zeros((3, 12, 361, 720, 60), dtype=np.uint16)
    en_hi[1, :, :, :, 2] = 20
    en_hi[1, :, :, :, 8] = 12
    os.makedirs(args.workdir, exist_ok=True)
    np.savez(os.path.join(args.workdir, "seastate_accum.npz"),
             version=np.int32(3), done=np.array(["x"]),
             wind_hist=e5["wind_hist"], wind_sum=e5["wind_sum"], wind_n=e5["wind_n"],
             dw_sum=dw_sum, dw_cnt=dw_cnt, wind_rose=wrose,
             en_nsamp=en_ns, en_hsum=en_hs,
             en_hist0=en_hi[0], en_hist1=en_hi[1], en_hist2=en_hi[2])
    del en_ns, en_hs, en_hi, wrose, dw_sum, dw_cnt, e5

    class A(object):
        pass
    ea = A()
    ea.workdir = args.workdir
    ea.out = args.out
    ea.era5_workdir = args.workdir
    run_emit(ea, acc)

    with open(os.path.join(args.out, "manifest.json")) as fh:
        mf = json.load(fh)
    assert mf["format"] == 1 and mf["source"] == "WAVERYS" and mf["wind"] is True
    assert mf["grid"]["res"] == RES and mf["tile_deg"] == TILE_DEG
    with open(os.path.join(args.out, "t_10_-130.json")) as fh:
        pt = json.load(fh)
    pk = None
    for c in range(len(pt["lat"])):
        if abs(pt["lat"][c] - 10.0) < 1e-6 and abs(pt["lon"][c] - (-130.0)) < 1e-6:
            pk = c
            break
    assert pk is not None, "probe cell missing"
    NT = len(THRESHOLDS)
    x20 = THRESHOLDS.index(2.0)
    # 12/32 = 375 permille at 2.0 m, every month
    for m in range(12):
        assert pt["exc"][pk][m * NT + x20] == 375, pt["exc"][pk][m * NT + x20]
    assert all(v == 85 for v in pt["tp"][pk])
    # period distribution: Tp = 8 s always -> bin 6 carries 1000
    th5 = pt["th"][pk]
    assert len(th5) == 12 * TP_NB, len(th5)
    for m9 in range(12):
        row9 = th5[m9 * TP_NB:(m9 + 1) * TP_NB]
        assert row9[6] == 1000 and sum(v for v in row9 if v > 0) == 1000, row9
    assert mf["tp_hist"] == {"t0": 2, "step": 1, "nb": TP_NB}, mf.get("tp_hist")
    assert all(v == 3 for v in pt["wd"][pk])
    assert pt["hxa"][pk] == [23, 23], pt["hxa"][pk]
    assert all(v == 50 for v in pt["wm"][pk]) and all(v == 60 for v in pt["w9"][pk])
    # diurnal: pattern value depends only on t%8; at 130 W the rough utc
    # hours (15..21) land in local slots 2..4
    dh = pt["dh"][pk]
    assert len(dh) == 96, len(dh)
    for m in range(12):
        assert dh[m * 8:(m + 1) * 8] == [5, 5, 20, 20, 20, 5, 5, 5], dh[m * 8:(m + 1) * 8]
    assert len(pt["dw"][pk]) == 96 and all(v == 50 for v in pt["dw"][pk]), pt["dw"][pk][:8]
    assert all(v == 7 for v in pt["vd"][pk]) and all(v == 100 for v in pt["vp"][pk])
    assert len(pt["vr"][pk]) == 144 and pt["vr"][pk][7] == 100, pt["vr"][pk][:12]
    # ENSO graft: neutral phase carries everything (n 32, mean 11 dm, 375
    # permille at 2.0 m, 1000 at 0.5 m); El Nino / La Nina read 0 / -1
    assert mf["enso"] and mf["enso"]["phases"] == ["elnino", "neutral", "lanina"]
    pn3, pm3, pe3 = pt["pn"][pk], pt["pm"][pk], pt["pe"][pk]
    assert len(pn3) == 36 and len(pm3) == 36 and len(pe3) == 36 * NT
    for m in range(12):
        assert pn3[m * 3 + 1] == 32 and pn3[m * 3] == 0 and pn3[m * 3 + 2] == 0, pn3[m * 3:m * 3 + 3]
        assert pm3[m * 3 + 1] == 11 and pm3[m * 3] == -1, pm3[m * 3:m * 3 + 3]
        e9 = pe3[(m * 3 + 1) * NT:(m * 3 + 2) * NT]
        assert e9[x20] == 375 and e9[0] == 1000, e9
        assert all(x == -1 for x in pe3[m * 3 * NT:(m * 3 + 1) * NT])
    # windows: 4 runs / 2 years x10 = 20 in the 12-24 h bin for thr <= 2.0
    for m in range(12):
        for x in range(3):
            row = pt["pw"][pk][m * len(P_THR) * P_NB + x * P_NB:
                               m * len(P_THR) * P_NB + x * P_NB + P_NB]
            assert row[2] == 20 and sum(row) == 20, (m, x, row)
    # exceedance monotone on a random busy tile
    with open(os.path.join(args.out, "t_50_-30.json")) as fh:
        tt = json.load(fh)
    row = tt["exc"][0][:NT]
    vals = [v for v in row if v >= 0]
    assert all(vals[i] >= vals[i + 1] for i in range(len(vals) - 1))
    print("SELF TEST PASS")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", default="./wav_work")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "web", "data"))
    ap.add_argument("--years", default="2010-2023", help="inclusive span (WAVERYS runs 1980-2023+)")
    ap.add_argument("--dataset", default=WAV_DATASET)
    ap.add_argument("--era5-workdir", help="ERA5 checkpoint dir: grafts wind statistics at emit")
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--emit", action="store_true")
    ap.add_argument("--synthetic", action="store_true")
    args = ap.parse_args()

    if args.synthetic:
        run_synthetic(args)
        return
    if args.download:
        run_download(args)
    if args.emit:
        run_emit(args)
    if not (args.download or args.emit):
        ap.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
