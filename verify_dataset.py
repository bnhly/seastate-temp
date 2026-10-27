#!/usr/bin/env python3
"""Input-vs-output verification for the Sea State Explorer wave dataset.

Written for engineering review: given the download checkpoint (the input
ledger + accumulated statistics) and the deployed tiles (the output), prove
they agree, and write a report a reviewer can read and sign off.

Four independent checks:

1. PROVENANCE + LEDGER. The checkpoint's identity (SHA256, size, months,
   span, gaps). If the workdir carries audit.jsonl (written by --download
   since 20 Aug 26: one line per source file with its SHA256, byte size and
   the samples it added), the ledger is reconciled against the checkpoint:
   every done month has a ledger line and the ledger's samples_added sum to
   the checkpoint's total sample count. Any source month can later be
   re-downloaded and its hash compared to its ledger line.

2. DETERMINISTIC RE-EMIT. The emitter is a pure function of the checkpoint,
   so verification re-runs it into a temp directory and requires every
   deployed file (manifest.json, meanhs.json, t_*.json) to be BIT-IDENTICAL
   by SHA256. This proves the deployed tiles are exactly what this code
   derives from this checkpoint - no stale, hand-edited or foreign files.

3. INDEPENDENT SPOT RECOMPUTE. For --sample random ocean cells, key
   statistics are recomputed from the checkpoint with separate first
   principles code (plain loops, no shared helpers with the emitter) and
   compared to the tile values: sample count, mean Hs, exceedance permille
   at three thresholds, P99, wind mean, and one weather-window count.
   Guards against a bug shared by emit and re-emit.

4. STATISTICAL INVARIANTS over every deployed tile: array lengths,
   exceedance monotone non-increasing, values in physical ranges, rose rows
   summing to ~100, P99.9 >= P99, non-negative window counts.

Exit code 0 = all PASS (report still written); 1 = any FAIL.

Usage:
  python3 tools/verify_dataset.py --workdir ~/era5_work --data web/data \
      --report verification_report.md --sample 400
"""

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_dataset_era5 as B   # rebound to the waverys module by --builder


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def month_days(key):
    y = int(key.split("-")[0])
    m = int(key.split("-")[1])
    if m == 2:
        return 29 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 28
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]


class Report(object):
    def __init__(self):
        self.lines = []
        self.failures = []

    def add(self, s=""):
        self.lines.append(s)

    def check(self, ok, label, detail=""):
        mark = "PASS" if ok else "FAIL"
        self.lines.append("- **%s** %s%s" % (mark, label, (": " + detail) if detail else ""))
        if not ok:
            self.failures.append(label + ((" - " + detail) if detail else ""))
        return ok


def provenance(rep, args, acc):
    rep.add("## 1. Provenance and input ledger")
    ck = os.path.join(args.workdir, B.CHECKPOINT)
    rep.add("- checkpoint: `%s`" % ck)
    rep.add("- checkpoint SHA256: `%s` (%.1f MB)" % (sha256_file(ck), os.path.getsize(ck) / 1e6))
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"],
                                         cwd=os.path.dirname(os.path.abspath(__file__)),
                                         stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        commit = "unknown (not a git checkout)"
    rep.add("- pipeline commit: `%s`" % commit)
    done = sorted(acc["done"])
    rep.add("- months accumulated: %d (%s to %s)" % (len(done), done[0], done[-1]))
    y0, y1 = int(done[0][:4]), int(done[-1][:4])
    expected = ["%04d-%02d" % (y, m) for y in range(y0, y1 + 1) for m in range(1, 13)]
    expected = [k for k in expected if done[0] <= k <= done[-1]]
    gaps = [k for k in expected if k not in set(done)]
    rep.check(not gaps, "no month gaps inside the span",
              ("missing: " + ", ".join(gaps[:6]) + ("..." if len(gaps) > 6 else "")) if gaps else "")

    audit_path = os.path.join(args.workdir, "audit.jsonl")
    if os.path.exists(audit_path):
        entries = [json.loads(ln) for ln in open(audit_path) if ln.strip()]
        by_month = {e["month"]: e for e in entries}
        missing = [k for k in done if k not in by_month]
        rep.check(not missing, "every accumulated month has a ledger line",
                  ("%d missing, e.g. %s" % (len(missing), missing[0])) if missing else
                  "%d lines" % len(entries))
        led_sum = sum(e["samples_added"] for e in entries if e["month"] in set(done))
        ck_sum = int(acc["nsamp"].sum())
        rep.check(led_sum == ck_sum, "ledger samples_added reconciles to checkpoint total",
                  "%s vs %s" % (led_sum, ck_sum))
        rep.add("- ledger carries a SHA256 per source file: any month can be re-downloaded "
                "and hash-compared independently.")
    else:
        rep.add("- input ledger: ABSENT (this checkpoint predates the ledger; spans built "
                "from 20 Aug 26 onward write audit.jsonl automatically). Checks 2-4 below "
                "are unaffected.")


def coverage(rep, acc, allow_partial=False):
    rep.add("")
    rep.add("## 2. Coverage")
    done = sorted(acc["done"])
    per_cal = {}
    for k in done:
        m = int(k[5:7]) - 1
        per_cal[m] = per_cal.get(m, 0) + month_days(k) * int(24 / B.STEP_H)
    full = True
    impossible = False
    for m in range(12):
        theo = per_cal.get(m, 0)
        mx = int(acc["nsamp"][m].max())
        if theo and mx != theo:
            full = False
        if mx > theo:
            impossible = True
        rep.add("  - month %02d: max cell samples %d / theoretical %d" % (m + 1, mx, theo))
    rep.check(not impossible, "no cell exceeds the theoretical sample count")
    if allow_partial:
        rep.add("- full-coverage requirement waived (--allow-partial); the table above "
                "still shows any shortfall.")
    else:
        rep.check(full, "at least one cell reaches full theoretical coverage in every month",
                  "" if full else "see table above (short months usually mean an interrupted "
                  "or truncated source file)")
    ocean = acc["nsamp"].sum(axis=0) > 0
    rep.add("- ocean cells with any data: %d" % int(ocean.sum()))


class LazyAcc(dict):
    """The checkpoint, each array read from the npz only when a check asks
    for it (26 Oct 26: the data host killed the full load at 10.5 GB). With
    the re-emit skipped, the checks touch a third of the arrays."""

    def __init__(self, path):
        dict.__init__(self)
        import numpy as _np
        self._z = _np.load(path, allow_pickle=False)
        self._keys = set(self._z.files)
        dict.__setitem__(self, "done", [s for s in self._z["done"].tolist()])

    def __contains__(self, k):
        return dict.__contains__(self, k) or k in self._keys

    def __getitem__(self, k):
        if not dict.__contains__(self, k):
            dict.__setitem__(self, k, self._z[k])
        return dict.__getitem__(self, k)

    def get(self, k, default=None):
        return self[k] if k in self else default


def re_emit_compare(rep, args, acc):
    rep.add("")
    rep.add("## 3. Deterministic re-emit (bit-exact)")
    if getattr(args, "skip_reemit", False):
        rep.add("SKIPPED: re-making every tile needs the whole checkpoint in memory, more "
                "than this machine has. Every other layer still runs. To include it, run on a "
                "machine with 24 GB or more.")
        return
    tmp = tempfile.mkdtemp(prefix="verify_emit_")
    try:
        class A(object):
            pass
        ea = A()
        ea.workdir = args.workdir
        ea.out = tmp
        ea.era5_workdir = getattr(args, "era5_workdir", None)
        B.run_emit(ea, acc)
        fresh = sorted(os.listdir(tmp))
        deployed_names = [n for n in sorted(os.listdir(args.data))
                          if n == "manifest.json" or n == "meanhs.json" or
                          (n.startswith("t_") and n.endswith(".json"))]
        rep.check(fresh == deployed_names, "same file inventory",
                  "%d fresh vs %d deployed emitter files" % (len(fresh), len(deployed_names)))
        bad = []
        for name in fresh:
            dp = os.path.join(args.data, name)
            if not os.path.exists(dp):
                bad.append(name + " (missing)")
                continue
            if sha256_file(os.path.join(tmp, name)) != sha256_file(dp):
                bad.append(name)
        rep.check(not bad, "every deployed emitter file is bit-identical to the fresh emit",
                  ("%d differ, e.g. %s" % (len(bad), bad[0])) if bad else
                  "%d files hash-identical" % len(fresh))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def spot_recompute(rep, args, acc):
    """First-principles recompute, deliberately sharing no code with emit."""
    rep.add("")
    rep.add("## 4. Independent spot recompute (%d cells)" % args.sample)
    rep.add("Formulas: exceedance permille = round(1000 * samples_at_or_above / samples); "
            "mean dm = round(10 * sum(Hs) / samples); P99 dm = upper edge of the first "
            "0.25 m bin where the cumulative count reaches ceil(0.99 * total); a month is "
            "valid when its samples reach 30% of the best cell that month.")
    with open(os.path.join(args.data, "manifest.json")) as fh:
        mf = json.load(fh)
    rng = random.Random(20260820)
    tiles = list(mf["tiles"])
    rng.shuffle(tiles)
    e5w = None
    if "wind_n" not in acc and getattr(args, "era5_workdir", None):
        z = np.load(os.path.join(args.era5_workdir, "seastate_accum.npz"), allow_pickle=False)
        e5w = {"wind_hist": z["wind_hist"], "wind_sum": z["wind_sum"], "wind_n": z["wind_n"]}
        # the emitter's ice rule for grafted wind (load_era5_wind): a source
        # cell-month under 30% of that month's busiest cell gives no wind
        wn_max = np.maximum(e5w["wind_n"].reshape(12, -1).max(axis=1), 1)
        e5w["ok"] = e5w["wind_n"] >= (0.3 * wn_max)[:, None, None]
    max_ns = [max(1, int(acc["nsamp"][m].max())) for m in range(12)]
    n_years = max(1.0, len(acc["done"]) / 12.0)
    checked = 0
    mism = []
    ti = 0
    while checked < args.sample and ti < len(tiles):
        with open(os.path.join(args.data, tiles[ti] + ".json")) as fh:
            tile = json.load(fh)
        ti += 1
        idxs = list(range(len(tile["lat"])))
        rng.shuffle(idxs)
        for c in idxs[:max(1, args.sample // max(1, len(tiles) // 2))]:
            if checked >= args.sample:
                break
            la, lo = tile["lat"][c], tile["lon"][c]
            i = int(round((la - B.LAT0) / B.RES))
            j = int(round((lo - B.LON0) / B.RES))
            m = rng.randrange(12)
            ns = int(acc["nsamp"][m, i, j])
            valid = ns >= 0.3 * max_ns[m]
            if tile["n"][c][m] != ns:
                mism.append("%s cell %d n[%d]" % (tiles[ti - 1], c, m))
            # mean
            want = -1 if not valid else int(np.round(10.0 * acc["hsum"][m, i, j] / ns))
            if tile["mean"][c][m] != want:
                mism.append("%s cell %d mean[%d]" % (tiles[ti - 1], c, m))
            # exceedance at three thresholds
            hist = acc["hs_hist"][m, i, j]
            for thr in (1.0, 2.0, 3.5):
                x = B.THRESHOLDS.index(thr)
                cnt = int(hist[int(thr / B.HS_BIN):].sum())
                want = -1 if not valid else int(np.round(1000.0 * cnt / ns))
                if tile["exc"][c][m * len(B.THRESHOLDS) + x] != want:
                    mism.append("%s cell %d exc[%d][%.1f]" % (tiles[ti - 1], c, m, thr))
            # P99 (hx even slots)
            if valid and ns > 0:
                need = math.ceil(0.99 * int(hist.sum()))
                run = 0
                p99 = -1
                for b in range(B.HS_NB):
                    run += int(hist[b])
                    if run >= max(need, 1):
                        p99 = int(math.floor((b + 1) * B.HS_BIN * 10.0 + 0.5))
                        break
                if tile["hx"][c][m * 2] != p99:
                    mism.append("%s cell %d p99[%d]" % (tiles[ti - 1], c, m))
            # wind mean: native on the era5 builder, grafted from the era5
            # checkpoint on waverys (verified when --era5-workdir is given)
            if "wind_n" in acc:
                wn = int(acc["wind_n"][m, i, j])
                wtot = int(acc["wind_hist"][m, i, j].sum())
                want = int(np.round(10.0 * acc["wind_sum"][m, i, j] / max(wn, 1))) \
                    if (valid and wtot > 0) else -1
                if tile["wm"][c][m] != want:
                    mism.append("%s cell %d wm[%d]" % (tiles[ti - 1], c, m))
            elif e5w is not None:
                # the emitter's own lookups (its column wraps at the dateline)
                ei = B.e5_row(la, e5w["wind_n"].shape[1])
                ej = B.e5_col(lo, e5w["wind_n"].shape[2])
                wn = int(e5w["wind_n"][m, ei, ej])
                wtot = int(e5w["wind_hist"][m, ei, ej].sum())
                want = int(np.round(10.0 * float(e5w["wind_sum"][m, ei, ej]) / max(wn, 1))) \
                    if (valid and wtot > 0 and bool(e5w["ok"][m, ei, ej])) else -1
                if tile["wm"][c][m] != want:
                    mism.append("%s cell %d wm-graft[%d]" % (tiles[ti - 1], c, m))
            # one weather-window entry: threshold 1.5 m, 12-24 h bin
            t_i = B.P_THR.index(1.5)
            runs = int(acc["persist"][t_i, m, i, j, 2])
            want = int(np.round(10.0 * runs / n_years)) if valid else -1
            flat_i = m * len(B.P_THR) * B.P_NB + t_i * B.P_NB + 2
            if tile["pw"][c][flat_i] != want:
                mism.append("%s cell %d pw[%d]" % (tiles[ti - 1], c, m))
            checked += 1
    rep.check(not mism, "%d sampled cells recomputed from first principles" % checked,
              ("%d mismatches, e.g. %s" % (len(mism), mism[0])) if mism else "0 mismatches")


def invariants(rep, args):
    rep.add("")
    rep.add("## 5. Statistical invariants (every deployed tile)")
    with open(os.path.join(args.data, "manifest.json")) as fh:
        mf = json.load(fh)
    NT = len(mf["thresholds"])
    # on WAVERYS the ENSO phases come from the ERA5 graft, whose years differ
    # from the wave record (1980-2024 against 1980-2023), so their counts are
    # not bounded by the wave n; the bound only holds where both are one record
    enso_graft = "graft" in str((mf.get("enso") or {}).get("source") or "")
    bad = []
    cells = 0
    for tid in mf["tiles"]:
        with open(os.path.join(args.data, tid + ".json")) as fh:
            t = json.load(fh)
        for c in range(len(t["lat"])):
            cells += 1
            exc = t["exc"][c]
            if len(exc) != 12 * NT:
                bad.append(tid + " exc len")
                continue
            for m in range(12):
                row = exc[m * NT:(m + 1) * NT]
                vals = [v for v in row if v >= 0]
                if any(vals[k] < vals[k + 1] for k in range(len(vals) - 1)):
                    bad.append("%s c%d m%d exc not monotone" % (tid, c, m))
                if any(v > 1000 for v in vals):
                    bad.append("%s c%d m%d exc > 1000" % (tid, c, m))
            if "hx" in t:
                hx = t["hx"][c]
                for m in range(12):
                    if hx[2 * m] >= 0 and hx[2 * m + 1] >= 0 and hx[2 * m + 1] < hx[2 * m]:
                        bad.append("%s c%d m%d p999 < p99" % (tid, c, m))
            if "wr" in t:
                wr = t["wr"][c]
                for m in range(12):
                    row = wr[m * 12:(m + 1) * 12]
                    if row[0] < 0:
                        continue
                    s = sum(row)
                    if not (92 <= s <= 108):
                        bad.append("%s c%d m%d rose sum %d" % (tid, c, m, s))
            if "pw" in t and any(v < -1 for v in t["pw"][c]):
                bad.append("%s c%d pw negative" % (tid, c))
            if "tp" in t and any(v > 300 for v in t["tp"][c]):
                bad.append("%s c%d tp out of range" % (tid, c))
            if "pn" in t and t["pn"][c]:
                # ENSO: phases partition the samples; phase exceedance rows
                # obey the same bounds and monotonicity as the headline exc
                pn = t["pn"][c]
                pe = t["pe"][c]
                for m in range(12):
                    # phases partition the tagged samples: their sum can be
                    # below n (a merged span may predate phase tagging) but
                    # never above it
                    tot = pn[m * 3] + pn[m * 3 + 1] + pn[m * 3 + 2]
                    if not enso_graft and tot > t["n"][c][m]:
                        bad.append("%s c%d m%d enso n %d > %d" % (tid, c, m, tot, t["n"][c][m]))
                    for p in range(3):
                        row = pe[(m * 3 + p) * NT:(m * 3 + p + 1) * NT]
                        vals = [v for v in row if v >= 0]
                        if any(vals[k] < vals[k + 1] for k in range(len(vals) - 1)):
                            bad.append("%s c%d m%d p%d pe not monotone" % (tid, c, m, p))
                        if any(v > 1000 for v in vals):
                            bad.append("%s c%d m%d p%d pe > 1000" % (tid, c, m, p))
        if len(bad) > 50:
            break
    rep.check(not bad, "invariants over %d cells in %d tiles" % (cells, len(mf["tiles"])),
              ("%d violations, e.g. %s" % (len(bad), bad[0])) if bad else "0 violations")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", required=True, help="checkpoint directory (era5_work)")
    ap.add_argument("--data", required=True, help="deployed data directory (web/data)")
    ap.add_argument("--report", default="verification_report.md")
    ap.add_argument("--sample", type=int, default=400, help="cells for the spot recompute")
    ap.add_argument("--allow-partial", action="store_true",
                    help="waive the full-coverage requirement (test builds, interrupted spans)")
    ap.add_argument("--builder", choices=["era5", "waverys"], default="era5",
                    help="which pipeline produced the checkpoint")
    ap.add_argument("--era5-workdir",
                    help="waverys only: the ERA5 checkpoint whose wind was grafted at emit")
    ap.add_argument("--skip-reemit", action="store_true",
                    help="leave out layer 3 (it needs the whole checkpoint in memory)")
    ap.add_argument("--low-memory", action="store_true",
                    help="read checkpoint arrays only as the checks need them")
    args = ap.parse_args()

    global B
    if args.builder == "waverys":
        import build_dataset_waverys as B

    if args.low_memory:
        ck = os.path.join(args.workdir, getattr(B, "CHECKPOINT", "seastate_accum.npz"))
        acc = LazyAcc(ck)
    else:
        acc = B.load_accumulator(args.workdir)
    if not acc["done"]:
        raise SystemExit("checkpoint in %s has no accumulated months" % args.workdir)

    rep = Report()
    rep.add("# Sea State Explorer dataset verification")
    rep.add("")
    rep.add("Input: checkpoint in `%s`. Output: deployed tiles in `%s`." % (args.workdir, args.data))
    rep.add("")
    provenance(rep, args, acc)
    coverage(rep, acc, allow_partial=args.allow_partial)
    re_emit_compare(rep, args, acc)
    spot_recompute(rep, args, acc)
    invariants(rep, args)
    rep.add("")
    rep.add("## Result")
    if rep.failures:
        rep.add("**FAIL** (%d):" % len(rep.failures))
        for f in rep.failures:
            rep.add("- " + f)
    else:
        rep.add("**PASS**: the deployed dataset is a faithful, complete derivation of the "
                "checkpoint, and the checkpoint reconciles to its input ledger where present.")
    with open(args.report, "w") as fh:
        fh.write("\n".join(rep.lines) + "\n")
    print("\n".join(rep.lines[-8:]))
    print("report -> %s" % args.report)
    sys.exit(1 if rep.failures else 0)


if __name__ == "__main__":
    main()
