#!/bin/bash
# refresh.sh - bring the Sea State data host up to date after the code
# changes of 3 Sep 26.
#
# WHO RUNS IT: Ben, as root, on the permanent data host (157.180.46.224),
# from the Hetzner web console:
#
#   curl -fsSL -L raw.githubusercontent.com/bnhly/seastate-temp/kit/refresh.sh -o refresh.sh
#   bash refresh.sh
#   cat /root/seastate/webdata/status.txt
#
# The console can be closed as soon as it prints REFRESH STARTED: the work
# runs detached in the background (about an hour, the emit is the long part)
# and reports through status.txt exactly like the first build did. Safe to
# run again: every step either finds its work already done or redoes it in
# place, a second copy refuses to start while one is running, and nothing
# here deletes the WAVERYS checkpoint, the ERA5 graft or the venv.
#
# WHAT IT DOES, in order
#   1/5 site repo   git pull (or a fresh shallow clone: the first build removed
#                   its clone) of bnhly/seastate-temp into /root/seastate/site,
#                   then copy data/ and coast/ over webdata. Copies OVER, never
#                   rm -rf. The wave-tile family (manifest.json, meanhs.json,
#                   t_*.json at the top of data/) is deliberately NOT copied: on
#                   the site those are the old ERA5 tiles, on this host they are
#                   the WAVERYS ones, and copying the ERA5 set over them would
#                   put a wrong manifest live for the hour until step 4 rewrites
#                   them. data/cur/ is the kit's; step 2 owns it.
#   2/5 currents    cur_tiles.part* + cur.sha256 from the kit, sha256-checked,
#                   unzipped into a staging folder and swapped into
#                   webdata/data/cur in one move. Skipped when the kit's
#                   cur.sha256 is the one already applied.
#   3/5 emitter     build_dataset_waverys.py from the kit, checked against
#                   SHA_WAVERYS_PY below (the script refuses to run while that
#                   still says REPLACE_ME). Then the ERA5 graft
#                   wav_work/seastate_accum.npz is verified and re-fetched from
#                   the kit if missing or damaged, the way the first build
#                   fetched it. The WAVERYS checkpoint wav_work/waverys_accum.npz
#                   has to be there: nothing on this host can rebuild it.
#   4/5 emit        ./venv/bin/python build_dataset_waverys.py --emit
#                   --workdir wav_work --era5-workdir wav_work --out webdata/data
#                   About an hour, RAM heavy. Tiles are rewritten in place and
#                   manifest.json is written last, so the site keeps serving
#                   throughout; status.txt shows tiles written every 30 s.
#                   Afterwards the manifest must say "wind": true, the proof
#                   that the graft went in (the 3 Sep 26 emit ran without it).
#   5/5 harden      runs harden.sh when it sits next to this script.
#   Then the DONE line in status.txt: tell Claude.
#
# Logs: /root/seastate/refresh.log (this script) and
# /root/seastate/refresh_emit.log (the emitter's own output).

set -u

# >>> FILL IN BEFORE PUBLISHING <<<
# sha256 of the kit branch's build_dataset_waverys.py (sha256sum on the copy
# that was pushed to the kit). The script refuses to run while this still
# says REPLACE_ME, so a stale kit can never be emitted by accident.
SHA_WAVERYS_PY=5233789e7523da7a1d60d03b00641890e77aa078c3dd804392a37b8ad792ea1a

# whole-file sha256 of the reassembled ERA5 graft (wav_work/seastate_accum.npz),
# the same value the cloud-init and the kit README carry
SHA_ERA5_GRAFT=a2d0f1f0a670203c98afbd09f41a517423c011f23e1b7ee1604c228516abbde4

RAW=https://raw.githubusercontent.com/bnhly/seastate-temp/kit
SITE_REPO=https://github.com/bnhly/seastate-temp
BASE=/root/seastate
WEB=$BASE/webdata
SITE=$BASE/site
WORK=$BASE/wav_work
LOG=$BASE/refresh.log
EMIT_LOG=$BASE/refresh_emit.log
LOCK=$BASE/refresh.lock
SELF=$(readlink -f "$0")
DIR=$(dirname "$SELF")
STEP=start
FINISHED=0

status() { echo "$(date -u)  $1" > "$WEB/status.txt"; }
fail() {
  FINISHED=1
  status "FAILED: $1 - see $LOG, tell Claude"
  echo "FAILED: $1"
  exit 1
}
fetch() { curl -fsSL --retry 3 --retry-delay 5 -o "$1" "$2"; }

# ---- guards, in the console, before anything detaches ---------------------
[ "$(id -u)" = 0 ] || { echo "run this as root"; exit 1; }
if [ ! -d "$WEB/data" ]; then
  echo "WRONG SERVER: no $WEB/data here. Open the console of the DATA HOST"
  echo "(the permanent server, 157.180.46.224) and run this there."
  exit 1
fi
case "$SHA_WAVERYS_PY" in
  REPLACE_ME|"")
    echo "REFUSING TO RUN: SHA_WAVERYS_PY at the top of refresh.sh still says REPLACE_ME."
    echo "Whoever publishes this script fills in the sha256 of the kit's build_dataset_waverys.py first."
    exit 1 ;;
esac
if [ "${#SHA_WAVERYS_PY}" != 64 ]; then
  echo "REFUSING TO RUN: SHA_WAVERYS_PY is not a 64 character sha256."
  exit 1
fi
for tool in git curl unzip sha256sum flock setsid; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool - is this the data host?"; exit 1; }
done

# ---- detach: the phone console must not have to stay open for an hour -----
if [ "${1:-}" != "--run" ]; then
  if ! flock -n "$LOCK" -c true; then
    echo "A refresh is already running (lock $LOCK). Progress: cat $WEB/status.txt"
    exit 1
  fi
  nohup setsid bash "$SELF" --run >> "$LOG" 2>&1 < /dev/null &
  sleep 3
  echo "REFRESH STARTED in the background, about an hour. This console can be closed."
  echo "Progress   cat $WEB/status.txt"
  echo "Log        tail -20 $LOG"
  echo "Now        $(cat "$WEB/status.txt" 2>/dev/null)"
  exit 0
fi

# ---- the background run ---------------------------------------------------
exec 9>"$LOCK"
flock -n 9 || { echo "another refresh holds the lock"; exit 1; }
trap 'if [ "$FINISHED" = 0 ]; then status "FAILED: refresh.sh stopped unexpectedly during step $STEP - see $LOG, tell Claude"; fi' EXIT
cd "$BASE" || fail "cannot cd to $BASE"
echo "=== refresh.sh started $(date -u) ==="

# headroom: the currents staging needs about 3.5 GB; the emit rewrites in place
AVAIL=$(df -BG --output=avail "$BASE" | tail -1 | tr -dc '0-9')
[ "${AVAIL:-0}" -ge 6 ] || fail "only ${AVAIL:-?} GB free under $BASE, need 6 GB of headroom"

# ---- 1/5: site data + coastline from the public site repo -----------------
STEP="1/5 site repo"
status "refresh 1/5 updating the site data from the public repo..."
if [ -d "$SITE/.git" ]; then
  { git -C "$SITE" fetch -q --depth 1 origin main && git -C "$SITE" reset -q --hard FETCH_HEAD; } \
    || fail "site repo update (git fetch/reset in $SITE)"
else
  rm -rf "$SITE"
  git clone -q --depth 1 "$SITE_REPO" "$SITE" || fail "site repo clone"
fi
{ [ -d "$SITE/data" ] && [ -d "$SITE/coast" ]; } || fail "the site clone has no data/ or coast/ folder"
mkdir -p "$WEB/data" "$WEB/coast"
NCOPY=0
while IFS= read -r f; do
  cp -p "$f" "$WEB/data/" || fail "copy $f"
  NCOPY=$((NCOPY + 1))
done < <(find "$SITE/data" -maxdepth 1 -type f ! -name manifest.json ! -name meanhs.json ! -name 't_*.json')
for d in "$SITE"/data/*/; do
  d=${d%/}
  [ -d "$d" ] || continue
  [ "$(basename "$d")" = cur ] && continue
  cp -rp "$d" "$WEB/data/" || fail "copy data/$(basename "$d")"
  NCOPY=$((NCOPY + 1))
done
cp -rp "$SITE/coast/." "$WEB/coast/" || fail "copy coast"
echo "1/5 copied $NCOPY entries from site/data plus coast/ (site at $(git -C "$SITE" rev-parse --short HEAD))"

# ---- 2/5: currents tiles from the kit -------------------------------------
STEP="2/5 currents"
status "refresh 2/5 checking the currents tiles against the kit..."
fetch cur.sha256.new "$RAW/cur.sha256" || fail "fetch cur.sha256"
if [ -f cur.applied.sha256 ] && cmp -s cur.sha256.new cur.applied.sha256 && [ -f "$WEB/data/cur/manifest.json" ]; then
  rm -f cur.sha256.new
  CUR_NOTE="currents unchanged"
  echo "2/5 currents: kit cur.sha256 already applied, skipped"
else
  mv -f cur.sha256.new cur.sha256
  CPARTS=$(grep -c cur_tiles cur.sha256)
  [ "$CPARTS" -ge 1 ] || fail "cur.sha256 lists no cur_tiles parts"
  rm -f cur_tiles.part* cur_tiles.zip
  for i in $(seq -f %02g 0 $((CPARTS - 1))); do
    status "refresh 2/5 fetching the currents tiles: part $i of $((CPARTS - 1))..."
    fetch "cur_tiles.part$i" "$RAW/cur_tiles.part$i" || fail "cur part $i download"
  done
  sha256sum -c --quiet cur.sha256 || fail "cur checksums"
  cat cur_tiles.part* > cur_tiles.zip
  rm -rf "$WEB/data/cur.new"
  mkdir -p "$WEB/data/cur.new"
  unzip -o -q cur_tiles.zip -d "$WEB/data/cur.new" || fail "cur unzip"
  [ -f "$WEB/data/cur.new/manifest.json" ] || fail "the currents zip has no manifest.json at its top level"
  rm -rf "$WEB/data/cur.old"
  [ -d "$WEB/data/cur" ] && mv "$WEB/data/cur" "$WEB/data/cur.old"
  mv "$WEB/data/cur.new" "$WEB/data/cur" || fail "cur swap"
  rm -rf "$WEB/data/cur.old" cur_tiles.part* cur_tiles.zip
  mv -f cur.sha256 cur.applied.sha256
  CUR_NOTE="currents tiles replaced ($(ls "$WEB/data/cur" | wc -l) files)"
  echo "2/5 $CUR_NOTE"
fi

# ---- 3/5: the emitter, the ERA5 graft, the checkpoint, the venv ------------
STEP="3/5 emitter and graft"
status "refresh 3/5 fetching the emitter and checking the ERA5 graft..."
fetch build_dataset_waverys.py.new "$RAW/build_dataset_waverys.py" || fail "fetch build_dataset_waverys.py"
echo "$SHA_WAVERYS_PY  build_dataset_waverys.py.new" | sha256sum -c --quiet \
  || fail "the kit's build_dataset_waverys.py does not match SHA_WAVERYS_PY in refresh.sh (kit or script is stale, nothing was changed)"
mv -f build_dataset_waverys.py.new build_dataset_waverys.py
echo "3/5 emitter ok (sha256 $SHA_WAVERYS_PY)"

graft_ok() {
  [ -f "$WORK/seastate_accum.npz" ] \
    && echo "$SHA_ERA5_GRAFT  $WORK/seastate_accum.npz" | sha256sum -c --quiet >/dev/null 2>&1
}
if graft_ok; then
  GRAFT_NOTE="graft present"
  echo "3/5 ERA5 graft present and intact"
else
  status "refresh 3/5 ERA5 graft missing or damaged: fetching it from the kit (0.4 GB)..."
  fetch kit.sha256 "$RAW/kit.sha256" || fail "fetch kit.sha256"
  grep era5_graft kit.sha256 > graft.sha256
  NPARTS=$(grep -c era5_graft graft.sha256)
  [ "$NPARTS" -ge 1 ] || fail "kit.sha256 lists no era5_graft parts"
  rm -f era5_graft.part*
  for i in $(seq -f %02g 0 $((NPARTS - 1))); do
    status "refresh 3/5 fetching the ERA5 graft: part $i of $((NPARTS - 1))..."
    fetch "era5_graft.part$i" "$RAW/era5_graft.part$i" || fail "graft part $i download"
  done
  sha256sum -c --quiet graft.sha256 || fail "graft part checksums"
  mkdir -p "$WORK"
  cat era5_graft.part* > "$WORK/seastate_accum.npz.new"
  echo "$SHA_ERA5_GRAFT  $WORK/seastate_accum.npz.new" | sha256sum -c --quiet \
    || fail "reassembled graft checksum"
  mv -f "$WORK/seastate_accum.npz.new" "$WORK/seastate_accum.npz"
  rm -f era5_graft.part* graft.sha256 kit.sha256
  GRAFT_NOTE="graft re-fetched"
  echo "3/5 ERA5 graft re-fetched and verified"
fi
[ -f "$WORK/waverys_accum.npz" ] \
  || fail "the WAVERYS checkpoint $WORK/waverys_accum.npz is missing and nothing on this host can rebuild it"
if [ ! -x venv/bin/python ]; then
  status "refresh 3/5 python venv missing: creating it..."
  { python3 -m venv venv && ./venv/bin/pip -q install numpy netCDF4; } || fail "venv setup"
fi

# ---- 4/5: emit the WAVERYS tiles with the ERA5 graft -----------------------
STEP="4/5 emit"
status "refresh 4/5 emitting WAVERYS tiles with the ERA5 graft (about an hour, RAM-heavy)..."
EXPECT=$(grep -o '"t_' "$WEB/data/manifest.json" 2>/dev/null | wc -l)
[ "$EXPECT" -gt 0 ] || EXPECT=2000
MARK=$BASE/.refresh_emit_start
touch "$MARK"
T0=$(date +%s)
./venv/bin/python build_dataset_waverys.py --emit --workdir wav_work --era5-workdir wav_work --out webdata/data \
  > "$EMIT_LOG" 2>&1 &
EPID=$!
while kill -0 "$EPID" 2>/dev/null; do
  sleep 30
  n=$(find "$WEB/data" -maxdepth 1 -name 't_*.json' -newer "$MARK" | wc -l)
  mins=$(( ($(date +%s) - T0) / 60 ))
  status "refresh 4/5 emitting WAVERYS tiles with the ERA5 graft: $n of about $EXPECT tiles written, $mins min in (about an hour in all)..."
done
wait "$EPID" || { tail -5 "$EMIT_LOG"; fail "emit exited with an error, the end of $EMIT_LOG says why"; }
cat "$EMIT_LOG"
rm -f "$MARK"
grep -Eq '"wind": ?true' "$WEB/data/manifest.json" \
  || fail "the emit finished but manifest.json does not say wind true, so the ERA5 graft did not go in"
EMITTED=$(grep -o 'emitted [0-9]* tiles' "$EMIT_LOG" | tail -1)
echo "4/5 ${EMITTED:-emit finished} in $(( ($(date +%s) - T0) / 60 )) min, manifest says wind true"

# ---- 5/5: harden.sh when it sits next to this script -----------------------
STEP="5/5 harden"
if [ -f "$DIR/harden.sh" ]; then
  status "refresh 5/5 applying harden.sh..."
  bash "$DIR/harden.sh" || fail "harden.sh reported an error"
  HARD="harden.sh applied"
else
  HARD="harden.sh not found next to refresh.sh, skipped"
fi

FINISHED=1
status "DONE $(date -u). Refresh complete: site data + coast copied, $CUR_NOTE, emitter $(printf %.12s "$SHA_WAVERYS_PY"), $GRAFT_NOTE, WAVERYS tiles re-emitted with the ERA5 graft (${EMITTED:-done}), $HARD. Serving. Tell Claude."
echo "=== refresh.sh finished $(date -u) ==="
