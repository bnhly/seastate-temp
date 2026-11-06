#!/bin/bash
# extremes-data.sh - bring the extremes pass (1 to 100-year wave heights and
# Tz) from the build server onto the data host (6 Nov 26). Nothing on the
# site changes: the next rebuild.sh picks it up.
#
#   rm -f extremes-data.sh
#   wget -q raw.githubusercontent.com/bnhly/seastate-temp/kit/extremes-data.sh
#   bash extremes-data.sh 1.2.3.4        (the build server's address)
#
# "bash extremes-data.sh" again shows progress or the result. When it says
# READY, delete the build server and run rebuild.sh fresh.

set -u
BASE=${TM_EX_BASE:-/root/seastate}
DEST=$BASE/wav_work/ex
OUT=$BASE/extremes_in
if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
if [ ! -d "$BASE/wav_work" ]; then echo "WRONG SERVER: no $BASE/wav_work here."; exit 1; fi
mkdir -p "$OUT"
running() { [ -f "$OUT/pid" ] && kill -0 "$(cat "$OUT/pid")" 2>/dev/null; }

if running; then echo "RUNNING: $(tail -1 "$OUT/progress" 2>/dev/null)"; exit 0; fi
IP="${1:-}"
if [ -z "$IP" ]; then
  if [ -s "$OUT/progress" ]; then tail -3 "$OUT/progress"; exit 0; fi
  echo "give the build server's address, e.g.  bash extremes-data.sh 1.2.3.4"; exit 1
fi
if [ -f "$BASE/rebuild/pid" ] && kill -0 "$(cat "$BASE/rebuild/pid")" 2>/dev/null; then
  echo "a rebuild is running; run this after it finishes"; exit 1
fi
if ! curl -fsS -m 20 "http://$IP:8080/status.txt" | grep -q "^DONE "; then
  echo "the build server at $IP does not say DONE yet (or cannot be reached). Check http://$IP:8080/status.txt"; exit 1
fi
free_gb=$(df -BG --output=avail "$BASE" | tail -1 | tr -dc 0-9)
if [ "${free_gb:-0}" -lt "${TM_EX_MINFREE:-25}" ]; then echo "Only ${free_gb} GB free; this needs about 25. Tell Claude."; exit 1; fi

rm -f "$OUT/progress"
cat > "$OUT/run.sh" <<EOF
#!/bin/bash
echo \$\$ > "$OUT/pid"
say() { echo "\$(date -u '+%H:%M') \$*" >> "$OUT/progress"; }
fail() { say "FAILED: \$1. Nothing on the site changed. Tell Claude."; rm -f "$OUT/pid" "$OUT/extremes.zip"; exit 1; }
say "1/3 downloading extremes.zip from $IP"
curl -fsS -o "$OUT/extremes.zip" "http://$IP:8080/extremes.zip" || fail "download"
want=\$(curl -fsS "http://$IP:8080/extremes.sha256" | cut -c1-64)
got=\$(sha256sum "$OUT/extremes.zip" | cut -c1-64)
[ -n "\$want" ] && [ "\$want" = "\$got" ] || fail "the file does not match its checksum"
say "2/3 unpacking"
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
cd "$DEST.new" && python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall('.')" "$OUT/extremes.zip" || fail "unpack"
n=\$(ls "$DEST.new/months" 2>/dev/null | grep -c '\.npz$')
[ -f "$DEST.new/tz_hist.npz" ] && [ "\$n" -ge 240 ] || fail "only \$n months in the zip"
say "3/3 putting it in place (\$n months)"
rm -rf "$DEST.old"
[ -d "$DEST" ] && mv "$DEST" "$DEST.old"
mv "$DEST.new" "$DEST" || fail "move"
rm -rf "$DEST.old" "$OUT/extremes.zip"
say "READY: \$n months in wav_work/ex, \$(df -BG --output=avail "$BASE" | tail -1 | tr -dc 0-9) GB free. Delete the build server, then run:  bash rebuild.sh fresh"
rm -f "$OUT/pid"
EOF
chmod +x "$OUT/run.sh"
nohup setsid "$OUT/run.sh" > /dev/null 2>&1 &
sleep 2
echo "STARTED in the background. Run  bash extremes-data.sh  again for progress."
