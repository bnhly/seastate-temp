#!/bin/bash
# check.sh - full maths check of the live Sea State data (26 Oct 26).
#
# WHO RUNS IT: Ben, as root, on the data host, one line at a time:
#
#   rm -f check.sh
#   wget -q raw.githubusercontent.com/bnhly/seastate-temp/kit/check.sh
#   bash check.sh
#
# The first run starts the check in the background (about 1 to 2 hours,
# mostly re-making every tile to compare it bit for bit) and returns.
# Run "bash check.sh" again any time: while it runs it shows progress, once
# it has finished it prints the summary. "bash check.sh fresh" starts over.
#
# WHAT IT CHECKS (nothing is changed on the site; the re-made tiles go to a
# temporary folder that is deleted afterwards)
#   1. verify_dataset.py: the live tiles against the WAVERYS checkpoint they
#      were made from - coverage, a full re-emit compared file by file,
#      an independent recompute of sampled cells, invariants on every tile.
#   2. check_maths.py: every cell's figures agree with each other, and for
#      3000 sampled cells what the browser shows is compared with the exact
#      value from the full record (all-year and season exceedance, limits
#      between stored heights, mean, 1-in-100, wind top 10%).
# Results: /root/seastate/check/ (summary.txt, verification_report.md,
# maths_check.md, run.log).

set -u
# the TM_CHECK_* overrides are for testing the script away from the host
BASE=${TM_CHECK_BASE:-/root/seastate}
OUT=$BASE/check
RAW=${TM_CHECK_RAW:-https://raw.githubusercontent.com/bnhly/seastate-temp/kit}
BUILDER=${TM_CHECK_BUILDER:-waverys}
CKPT=${TM_CHECK_CKPT:-waverys_accum.npz}
PY=$BASE/venv/bin/python

if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
if [ ! -f "$BASE/wav_work/$CKPT" ]; then
  echo "WRONG SERVER or missing checkpoint: no $BASE/wav_work/$CKPT here."
  exit 1
fi
[ -x "$PY" ] || PY=python3
mkdir -p "$OUT"

running() { [ -f "$OUT/pid" ] && kill -0 "$(cat "$OUT/pid")" 2>/dev/null; }

show_summary() {
  echo
  cat "$OUT/summary.txt"
  echo
  echo "Full reports: $OUT/verification_report.md and $OUT/maths_check.md"
}

if [ "${1:-}" != "fresh" ]; then
  if running; then
    echo "CHECK RUNNING (started $(cat "$OUT/started" 2>/dev/null))"
    echo "now: $(tail -1 "$OUT/progress" 2>/dev/null)"
    echo "Run bash check.sh again later for the result."
    exit 0
  fi
  if [ -s "$OUT/summary.txt" ]; then
    show_summary
    echo "To run it again from the start: bash check.sh fresh"
    exit 0
  fi
fi
if running; then echo "a check is already running; wait for it to finish"; exit 1; fi

# ---- fetch the checkers (the host's own emitter is kept: it made the tiles)
cd "$BASE" || exit 1
for f in check_maths.py verify_dataset.py build_dataset_era5.py; do
  curl -fsSL -o "$OUT/$f.new" "$RAW/$f" || { echo "FAILED to fetch $f from the kit"; exit 1; }
  mv "$OUT/$f.new" "$OUT/$f"
done
if [ -f "$BASE/build_dataset_waverys.py" ]; then
  cp "$BASE/build_dataset_waverys.py" "$OUT/"
else
  curl -fsSL -o "$OUT/build_dataset_waverys.py" "$RAW/build_dataset_waverys.py" || { echo "FAILED to fetch the emitter"; exit 1; }
fi
free_gb=$(df -BG --output=avail "$BASE" | tail -1 | tr -dc 0-9)
if [ "${free_gb:-0}" -lt 15 ]; then
  echo "Only ${free_gb} GB free; the re-emit needs about 10 GB. Free some space and run again."
  exit 1
fi

# re-making every tile holds the whole WAVERYS checkpoint (about 7 GB) plus
# working space; the first run on the host was killed at 10.5 GB. Below
# 24 GB of memory and swap, read the checkpoint lazily and leave that layer
# out (every other layer still runs, and the summary says so)
mem_gb=${TM_CHECK_MEM:-$(awk '/^MemTotal:|^SwapTotal:/ {s += $2} END {print int(s / 1048576)}' /proc/meminfo)}
LOWMEM=""
STEP1="re-emitting every tile and comparing (the long part)"
if [ "${mem_gb:-0}" -lt 24 ]; then
  LOWMEM="--low-memory --skip-reemit"
  STEP1="tiles against the checkpoint (${mem_gb} GB memory: the full re-make is left out)"
fi

rm -f "$OUT/summary.txt" "$OUT/progress" "$OUT/run.log"
date -u '+%Y-%m-%d %H:%M UTC' > "$OUT/started"

# ---- the run itself, detached so the console can close
cat > "$OUT/run.sh" <<EOF
#!/bin/bash
echo \$\$ > "$OUT/pid"
cd "$BASE"
say() { echo "\$(date -u '+%H:%M') \$*" >> "$OUT/progress"; }
say "1/2 verify_dataset: $STEP1"
rm -f "$OUT/verification_report.md"
"$PY" "$OUT/verify_dataset.py" --builder $BUILDER --workdir wav_work --era5-workdir wav_work $LOWMEM \\
    --data webdata/data --report "$OUT/verification_report.md" --sample 400 >> "$OUT/run.log" 2>&1
V=\$?
say "2/2 check_maths: every cell, then 3000 cells against the full record"
"$PY" "$OUT/check_maths.py" --builder $BUILDER --workdir wav_work --era5-workdir wav_work \\
    --data webdata/data --sample 3000 --report "$OUT/maths_check.md" > "$OUT/maths.out" 2>> "$OUT/run.log"
M=\$?
{
  echo "SEA STATE MATHS CHECK  started $(cat "$OUT/started"), finished \$(date -u '+%Y-%m-%d %H:%M UTC')"
  echo
  if [ \$V = 0 ]; then R1="ALL PASS"; elif [ \$V = 1 ]; then R1="FAILED"; else R1="STOPPED (code \$V, see run.log; 137 means out of memory)"; fi
  echo "1. Tiles against the checkpoint (verify_dataset): \$R1"
  grep -E '^\- \*\*(PASS|FAIL)' "$OUT/verification_report.md" 2>/dev/null | sed 's/^- \*\*\(PASS\|FAIL\)\*\* /   \1  /' | cut -c1-110
  grep -q '^SKIPPED' "$OUT/verification_report.md" 2>/dev/null && echo "   SKIP  full re-make of every tile (not enough memory here; all else ran)"
  echo
  echo "2. Browser figures (check_maths): \$( [ \$M = 0 ] && echo NO FAILURES || echo FAILURES FOUND )"
  sed 's/^/   /' "$OUT/maths.out"
} > "$OUT/summary.txt"
say "DONE"
rm -rf /tmp/verify_emit_* 2>/dev/null
rm -f "$OUT/pid"
EOF
chmod +x "$OUT/run.sh"
nohup setsid "$OUT/run.sh" > /dev/null 2>&1 &
sleep 2
echo "CHECK STARTED in the background ($(cat "$OUT/started"))."
echo "It takes about 1 to 2 hours. The console can be closed."
echo "Later, run:  bash check.sh   to see progress or the result."
