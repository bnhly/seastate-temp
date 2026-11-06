#!/bin/bash
# who.sh - what one address did on the data host (6 Nov 26), to tell a busy
# person from a scraper before anything is blocked. Read only.
#
#   rm -f who.sh
#   wget -q raw.githubusercontent.com/bnhly/seastate-temp/kit/who.sh
#   bash who.sh 185.212.234.65
#
# Reads the nginx access logs (current and rotated) for that address: when,
# how fast, which kinds of data file, where the requests said they came from,
# and whether the same address also used the site's pages (the usage signal
# hit.js sends: page views, places looked at, PDFs). A person using the site
# sends those; a script pulling files directly does not.

set -u
if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
IP="${1:-}"
if [ -z "$IP" ]; then echo "give the address, e.g.  bash who.sh 185.212.234.65"; exit 1; fi

python3 - "$IP" "${TM_WHO_LOGS:-/var/log/nginx/access.log*}" <<'PY'
import collections, datetime, glob, gzip, re, sys
ip, logglob = sys.argv[1], sys.argv[2]
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(?:\S+ (\S+)[^"]*|[^"]*)" (\d{3}) \S+ "([^"]*)" "([^"]*)"')
KINDS = [("wave tiles", r"^/data/t_"), ("depth", r"^/data/depth/"), ("currents", r"^/data/cur/"),
         ("wave/period tables", r"^/data/joint/"), ("cyclones", r"^/data/cyc/"),
         ("assets / map shading", r"^/data/(assets|meanhs)\.json"), ("manifests", r"manifest\.json")]
days = collections.defaultdict(lambda: {"req": 0, "files": set(), "first": None, "last": None,
                                        "min": collections.Counter(), "kinds": collections.Counter(),
                                        "status": collections.Counter(), "hits": collections.Counter()})
refs, uas, places = collections.Counter(), collections.Counter(), collections.Counter()
for path in sorted(glob.glob(logglob)):
    try:
        fh = gzip.open(path, "rt", errors="replace") if path.endswith(".gz") else open(path, errors="replace")
    except Exception:
        continue
    with fh:
        for line in fh:
            if not line.startswith(ip + " "):
                continue
            m = LINE.match(line)
            if not m or m.group(1) != ip:
                continue
            _, ts, url, status, ref, ua = m.groups()
            try:
                t = datetime.datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z").astimezone(datetime.timezone.utc)
            except ValueError:
                continue
            d = days[t.date()]
            d["req"] += 1
            d["first"] = t if d["first"] is None or t < d["first"] else d["first"]
            d["last"] = t if d["last"] is None or t > d["last"] else d["last"]
            d["min"][t.strftime("%H:%M")] += 1
            d["status"][status] += 1
            url = url or ""
            if url.startswith("/hit?"):
                q = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&") if "=" in x)
                d["hits"][q.get("e", "?")] += 1
                if q.get("e") == "place" and q.get("g"):
                    places[q["g"]] += 1
                continue
            p = url.split("?")[0]
            d["files"].add(p)
            for name, rx in KINDS:
                if re.search(rx, p):
                    d["kinds"][name] += 1
                    break
            else:
                d["kinds"]["other"] += 1
            h = re.sub(r"^https?://([^/]+).*$", r"\1", ref) if ref and ref != "-" else "(none)"
            refs[h] += 1
            uas[ua[:120]] += 1
if not days:
    print("Nothing from %s in the logs the host still keeps." % ip)
    sys.exit(0)
print("ADDRESS %s" % ip)
for day in sorted(days):
    d = days[day]
    span = (d["last"] - d["first"]).total_seconds() / 60.0
    busiest = d["min"].most_common(1)[0]
    print()
    print("%s  %d requests, %d different files, %s to %s UTC (%.0f minutes)"
          % (day, d["req"], len(d["files"]), d["first"].strftime("%H:%M"), d["last"].strftime("%H:%M"), span))
    print("   busiest minute %s UTC: %d requests; active in %d different minutes"
          % (busiest[0], busiest[1], len(d["min"])))
    print("   files: " + ", ".join("%s %d" % kv for kv in d["kinds"].most_common()))
    print("   answers: " + ", ".join("%s %d" % kv for kv in sorted(d["status"].items())))
    if d["hits"]:
        print("   USED THE SITE'S PAGES: " + ", ".join("%s %d" % kv for kv in d["hits"].most_common())
              + "   (pv = page view, place = a point looked at)")
    else:
        print("   no page use from this address (no page views or places looked at)")
print()
print("Said it came from: " + ", ".join("%s %d" % kv for kv in refs.most_common(4)))
print("Browser: " + "; ".join("%s (%d)" % kv for kv in uas.most_common(2)))
if places:
    print("Places looked at (rounded to 1 degree): " + ", ".join("%s x%d" % kv for kv in places.most_common(10)))
PY
