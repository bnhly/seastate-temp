#!/bin/bash
# rebuild.sh - re-make the live wave tiles from the WAVERYS checkpoint with
# the 27 Oct 26 emitter, check them, and swap them in (27 Oct 26).
#
# WHO RUNS IT: Ben, as root, on the data host, one line at a time:
#
#   rm -f rebuild.sh
#   wget -q raw.githubusercontent.com/bnhly/seastate-temp/kit/rebuild.sh
#   bash rebuild.sh
#
# The site stays live the whole time. The new tiles are written to
# webdata/data_new while webdata/data keeps serving; they are checked; only
# if every check passes are the other layers (currents, joint table,
# cyclones, depth, assets) copied across and the two folders swapped, which
# takes well under a second. The old tiles stay as webdata/data_old.
#
# "bash rebuild.sh" again shows progress or the result.
# "bash rebuild.sh undo" swaps the old tiles back.
# Takes about 1.5 to 2.5 hours. Start it well clear of 16:00 UTC, when the
# automatic updates may restart the server.
#
# WHAT CHANGES IN THE TILES
#   - exceedance stored every 0.25 m to 6 m (was every 0.5 m), so every
#     limit the page offers is exact
#   - each month's wind distribution (nine points), so the page works out
#     the true top 10% for any choice of months
#   - the all-year 1-in-100 pooled over the months the page shows (sea ice)
#   - a data id the page puts on its tile requests, so no browser mixes
#     cached old tiles with new ones

set -u
BASE=${TM_RB_BASE:-/root/seastate}
OUT=$BASE/rebuild
WEB=$BASE/webdata
RAW=${TM_RB_RAW:-https://raw.githubusercontent.com/bnhly/seastate-temp/kit}
PY=$BASE/venv/bin/python
CKPT=${TM_RB_CKPT:-waverys_accum.npz}

if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
[ -x "$PY" ] || PY=python3
mkdir -p "$OUT"
running() { [ -f "$OUT/pid" ] && kill -0 "$(cat "$OUT/pid")" 2>/dev/null; }

if [ "${1:-}" = "undo" ]; then
  if running; then echo "a rebuild is running; wait for it to finish"; exit 1; fi
  if [ ! -d "$WEB/data_old" ]; then echo "no data_old to go back to"; exit 1; fi
  rm -rf "$WEB/data_undone"
  mv "$WEB/data" "$WEB/data_undone" && mv "$WEB/data_old" "$WEB/data" || { echo "UNDO FAILED - tell Claude"; exit 1; }
  echo "UNDONE: the previous tiles are live again (the rebuilt ones are in webdata/data_undone)."
  exit 0
fi

if running; then
  echo "REBUILD RUNNING (started $(cat "$OUT/started" 2>/dev/null))"
  echo "now: $(tail -1 "$OUT/progress" 2>/dev/null)"
  echo "Run bash rebuild.sh again later for the result."
  exit 0
fi
if [ -s "$OUT/summary.txt" ] && [ "${1:-}" != "fresh" ]; then
  echo; cat "$OUT/summary.txt"; echo
  echo "To rebuild again from the start: bash rebuild.sh fresh"
  exit 0
fi

if [ ! -f "$BASE/wav_work/$CKPT" ]; then
  echo "WRONG SERVER or missing checkpoint: no $BASE/wav_work/$CKPT here."; exit 1
fi
if [ ! -f "$WEB/data/manifest.json" ]; then echo "no live tiles at $WEB/data"; exit 1; fi
if [ -f "$BASE/check/pid" ] && kill -0 "$(cat "$BASE/check/pid")" 2>/dev/null; then
  echo "check.sh is still running; wait for it to finish first (bash check.sh shows its progress)"; exit 1
fi
free_gb=$(df -BG --output=avail "$BASE" | tail -1 | tr -dc 0-9)
if [ "${free_gb:-0}" -lt "${TM_RB_MINFREE:-30}" ]; then echo "Only ${free_gb} GB free; the rebuild needs about 30. Tell Claude."; exit 1; fi

# ---- swap: a memory peak then slows the rebuild instead of killing it
swap_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
if [ "${swap_kb:-0}" -lt 1000000 ] && [ -z "${TM_RB_NOSWAP:-}" ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l 16G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=16384 status=none
    chmod 600 /swapfile
    mkswap /swapfile > /dev/null
  fi
  swapon /swapfile 2>/dev/null
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap: 16 GB added (kept for future rebuilds)"
fi

# ---- the new emitter and the checkers (the host's own emitter is left alone)
for f in build_dataset_waverys.py build_dataset_era5.py check_maths.py verify_dataset.py; do
  curl -fsSL -o "$OUT/$f.new" "$RAW/$f" || { echo "FAILED to fetch $f from the kit"; exit 1; }
  mv "$OUT/$f.new" "$OUT/$f"
done
grep -q "WIND_Q" "$OUT/build_dataset_waverys.py" || { echo "the kit's emitter is not the new one; tell Claude"; exit 1; }

rm -f "$OUT/summary.txt" "$OUT/progress" "$OUT/run.log"
date -u '+%Y-%m-%d %H:%M UTC' > "$OUT/started"

cat > "$OUT/run.sh" <<EOF
#!/bin/bash
echo \$\$ > "$OUT/pid"
cd "$BASE"
say() { echo "\$(date -u '+%H:%M') \$*" >> "$OUT/progress"; }
finish() {
  {
    echo "SEA STATE REBUILD  started $(cat "$OUT/started"), finished \$(date -u '+%Y-%m-%d %H:%M UTC')"
    echo
    echo "\$1"
    [ -f "$OUT/verify.txt" ] && { echo; echo "Recompute from the checkpoint:"; sed 's/^/   /' "$OUT/verify.txt"; }
    [ -f "$OUT/maths.out" ] && { echo; echo "Maths check on the new tiles:"; sed 's/^/   /' "$OUT/maths.out"; }
  } > "$OUT/summary.txt"
  say "DONE"
  rm -f "$OUT/pid"
  exit 0
}

say "1/4 building the new tiles into data_new (the site keeps serving the old ones; about an hour)"
rm -rf "$WEB/data_new"
if [ -n "${TM_RB_EMIT_FROM:-}" ]; then
  cp -a "${TM_RB_EMIT_FROM:-}" "$WEB/data_new"      # testing the script only: tiles built earlier
else
"$PY" "$OUT/build_dataset_waverys.py" --emit --workdir wav_work --era5-workdir wav_work \\
    --out "$WEB/data_new" >> "$OUT/run.log" 2>&1 || finish "NOT SWAPPED: the build stopped (see $OUT/run.log). The live tiles are unchanged."
fi
"$PY" - "$WEB/data/manifest.json" "$WEB/data_new/manifest.json" >> "$OUT/run.log" 2>&1 <<'PYEOF' || finish "NOT SWAPPED: the new tiles do not look complete (see $OUT/run.log). The live tiles are unchanged."
import json, sys
old, new = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
assert new.get("data_id"), "no data_id"
assert new.get("wind") is True and new.get("wind_q"), "wind graft missing"
assert len(new["thresholds"]) == 28, "thresholds"
assert len(new["tiles"]) == len(old["tiles"]), "tile count %d vs %d" % (len(new["tiles"]), len(old["tiles"]))
print("new manifest ok:", new["data_id"], len(new["tiles"]), "tiles")
PYEOF

say "2/4 recomputing sampled cells from the checkpoint"
"$PY" "$OUT/verify_dataset.py" --builder waverys --workdir wav_work --era5-workdir wav_work --low-memory --skip-reemit \\
    --data "$WEB/data_new" --report "$OUT/verification_report.md" --sample 400 >> "$OUT/run.log" 2>&1
grep -E '^\- \*\*(PASS|FAIL)' "$OUT/verification_report.md" 2>/dev/null | sed 's/^- \*\*\(PASS\|FAIL\)\*\* /\1  /' | cut -c1-110 > "$OUT/verify.txt"
if grep -q '^FAIL' "$OUT/verify.txt" && ! grep -q '^FAIL  at least one cell reaches full theoretical coverage' "$OUT/verify.txt"; then
  finish "NOT SWAPPED: the recompute from the checkpoint found a difference. The live tiles are unchanged."
fi

say "3/4 maths check on the new tiles"
"$PY" "$OUT/check_maths.py" --builder waverys --workdir wav_work --era5-workdir wav_work \\
    --data "$WEB/data_new" --sample 3000 --report "$OUT/maths_check.md" > "$OUT/maths.out" 2>> "$OUT/run.log" \\
  || finish "NOT SWAPPED: the maths check found a failure (see $OUT/maths_check.md). The live tiles are unchanged."

say "4/4 copying the other layers across and swapping"
for item in "$WEB/data"/*; do
  name=\$(basename "\$item")
  [ -e "$WEB/data_new/\$name" ] && continue
  cp -al "\$item" "$WEB/data_new/" 2>/dev/null || cp -a "\$item" "$WEB/data_new/" \\
    || finish "NOT SWAPPED: could not copy \$name across. The live tiles are unchanged."
done
rm -rf "$WEB/data_old"
mv "$WEB/data" "$WEB/data_old" && mv "$WEB/data_new" "$WEB/data" \\
  || { [ -d "$WEB/data" ] || mv "$WEB/data_old" "$WEB/data"; finish "SWAP FAILED, the old tiles are back in place. Tell Claude."; }
finish "SWAPPED: the new tiles are live. The old ones are in webdata/data_old (bash rebuild.sh undo puts them back)."
EOF
chmod +x "$OUT/run.sh"
nohup setsid "$OUT/run.sh" > /dev/null 2>&1 &
sleep 2
echo "REBUILD STARTED in the background ($(cat "$OUT/started"))."
echo "The site stays live. It takes about 1.5 to 2.5 hours; the console can be closed."
echo "Later, run:  bash rebuild.sh   to see progress or the result."
