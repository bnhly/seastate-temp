#!/bin/bash
# stats.sh - nightly usage summary on the Sea State data host (23 Oct 26).
#
# WHO RUNS IT: Ben, as root, on the permanent data host
# (seastate-data.thrustm.com, 157.180.46.224), from the Hetzner web console,
# one line at a time:
#
#   curl -fsSL -L raw.githubusercontent.com/bnhly/seastate-temp/kit/stats.sh -o stats.sh
#   bash stats.sh
#
# Safe to run again: it keeps the same token, rewrites the report script and
# the cron line, and reruns the summary.
#
# WHAT IT DOES
#   - writes /root/seastate/stats_report.py and runs it every night at
#     00:40 UTC (cron). It reads the nginx access logs, keeps one small
#     file per day under /root/seastate/stats/daily/ (a year of them) and
#     publishes the last 7 days as /stats/<token>.json on this host, plus
#     the last 60 days one by one ("daily") for ERPNext's TM Sea State Day.
#   - makes the token once (/root/seastate/stats_token, 20 lowercase hex
#     characters) and prints it. The ERPNext script needs it.
#   - runs the summary straight away over whatever the logs already hold.
#
# The summary is counts only: lookups, visitors, regions, refused requests,
# disk and certificate. The one exception is the address and browser string
# of anything flagged as a scraper. Nothing here sends mail; ERPNext fetches
# the file and emails Ben, so this public box holds no mail or ERP login.

set -u
BASE=/root/seastate
WEB=$BASE/webdata

if [ "$(id -u)" != 0 ]; then echo "run this as root"; exit 1; fi
if [ ! -d "$WEB/data" ]; then
  echo "WRONG SERVER: no $WEB/data here. Open the console of the DATA HOST and run this there."
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 missing"; exit 1; }

if [ ! -s "$BASE/stats_token" ]; then
  head -c 10 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$BASE/stats_token"
  chmod 600 "$BASE/stats_token"
fi
TOKEN=$(cat "$BASE/stats_token")
mkdir -p "$BASE/stats/daily" "$WEB/stats"

cat > "$BASE/stats_report.py" <<'PY'
#!/usr/bin/env python3
# stats_report.py - nightly usage summary for the Sea State data host.
# Installed by stats.sh; runs from cron at 00:40 UTC. Log: stats.log
#
# Reads the nginx access logs (current and rotated), works out each complete
# UTC day, keeps one small file per day under /root/seastate/stats/daily/ and
# publishes a summary of the last 7 days at /stats/<token>.json, which the
# ERPNext script fetches. The summary holds counts only. The one exception
# is the address and browser string of anything flagged as a scraper.
import datetime
import glob
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import urllib.parse

BASE = os.environ.get("TM_STATS_BASE", "/root/seastate")
WEB = BASE + "/webdata"
DAILY = BASE + "/stats/daily"
LOGGLOB = os.environ.get("TM_STATS_LOGS", "/var/log/nginx/access.log*")
HOST = "seastate-data.thrustm.com"
CERT = "/etc/letsencrypt/live/" + HOST + "/fullchain.pem"

# thresholds (alerts go out the next morning)
SCRAPE_FILES = 300     # different data files from one address in a day
BLOCK_MIN = 500        # blocked + rate limited in a day, at least this many...
BLOCK_FACTOR = 5       # ...and this many times the usual day
DISK_PCT = 80
CERT_DAYS = 14
KEEP_DAYS = 400
DAILY_ROWS = 60        # days published one by one for ERPNext's daily table

LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(?:\S+ (\S+)[^"]*|[^"]*)" (\d{3}) \S+ "([^"]*)" "([^"]*)"')
TILE = re.compile(r"^/data/t_(-?\d+)_(-?\d+)\.json")
LOCAL = ("127.0.0.1", "::1")
SITE = "seastate.thrustm.com"
EVENTS = ("pv", "place", "pdf", "share", "cta", "li", "fb")
SALT_FILE = BASE + "/stats_salt"

# named places for the region labels (from the location pages list)
LOCS = [
    ('Ekofisk', 56.55, 3.21, 'North Sea'),
    ('Forties', 57.73, 0.92, 'North Sea'),
    ('Statfjord', 61.25, 1.85, 'North Sea'),
    ('Sleipner', 58.37, 1.91, 'North Sea'),
    ('Troll', 60.64, 3.72, 'North Sea'),
    ('Johan Sverdrup', 58.84, 2.55, 'North Sea'),
    ('Dogger Bank wind farm zone', 54.75, 2.0, 'North Sea'),
    ('Leman', 53.07, 2.22, 'North Sea'),
    ('Tyra', 55.72, 4.78, 'North Sea'),
    ('Gemini wind farm', 54.03, 5.96, 'North Sea'),
    ('Clair', 60.68, -2.56, 'West of Shetland'),
    ('Morecambe Bay gas fields', 53.9, -3.62, 'Irish Sea'),
    ('Corrib', 54.33, -11.06, 'Atlantic Ireland'),
    ('Heidrun', 65.31, 7.3, 'Norwegian Sea'),
    ('Ormen Lange', 63.5, 5.38, 'Norwegian Sea'),
    ('Aasta Hansteen', 67.05, 7.05, 'Norwegian Sea'),
    ('Goliat', 71.3, 22.26, 'Barents Sea'),
    ('Johan Castberg', 72.45, 20.15, 'Barents Sea'),
    ('Prirazlomnoye', 69.47, 56.63, 'Barents Sea'),
    ('Arkona Basin wind farms', 54.83, 14.07, 'Baltic Sea'),
    ('Zohr', 32.36, 32.86, 'Mediterranean'),
    ('Leviathan', 33.0, 33.65, 'Mediterranean'),
    ('Raven (West Nile Delta)', 31.74, 29.95, 'Mediterranean'),
    ('Bouri', 34.01, 12.47, 'Mediterranean'),
    ('Barbara (Adriatic)', 44.05, 13.76, 'Mediterranean'),
    ('Sakarya', 42.75, 31.26, 'Black Sea'),
    ('Neptun Deep', 43.88, 30.72, 'Black Sea'),
    ('Northern Red Sea off Hurghada', 27.0, 34.8, 'Red Sea'),
    ('Marjan', 28.44, 49.67, 'Persian Gulf'),
    ('North Field and South Pars', 26.57, 51.85, 'Persian Gulf'),
    ('Upper Zakum', 24.84, 53.66, 'Persian Gulf'),
    ('Azeri-Chirag-Guneshli', 40.22, 51.1, 'Caspian Sea'),
    ('Kashagan', 46.49, 50.14, 'Caspian Sea'),
    ('Mars-Ursa', 28.17, -89.22, 'Gulf of Mexico'),
    ('Thunder Horse', 28.19, -88.5, 'Gulf of Mexico'),
    ('Perdido', 26.13, -94.9, 'Gulf of Mexico'),
    ('Louisiana shelf (Ship Shoal and South Timbalier)', 28.6, -90.4, 'Gulf of Mexico'),
    ('Cantarell', 19.45, -92.15, 'Gulf of Mexico'),
    ('Roncador', -21.94, -39.75, 'Brazil'),
    ('Tupi', -25.4, -42.84, 'Brazil'),
    ('Búzios', -24.66, -42.5, 'Brazil'),
    ('Sergipe deepwater', -11.5, -36.2, 'Brazil'),
    ('Liza (Stabroek)', 8.11, -56.93, 'Guyana and Suriname'),
    ('Block 58 Suriname', 7.45, -56.05, 'Guyana and Suriname'),
    ('Girassol and Dalia (Block 17)', -7.66, 11.75, 'West Africa'),
    ('Bonga', 4.59, 4.61, 'West Africa'),
    ('Akpo and Egina (OML 130)', 3.2, 6.63, 'West Africa'),
    ('Sankofa and Jubilee area', 4.45, -2.52, 'West Africa'),
    ('Greater Tortue Ahmeyim', 16.12, -17.63, 'West Africa'),
    ('Sangomar', 13.74, -17.61, 'West Africa'),
    ('Venus (Orange Basin)', -29.5, 13.65, 'Southern Africa'),
    ('Brulpadda and Luiperd', -35.85, 22.9, 'Southern Africa'),
    ('Coral South (Rovuma)', -10.9, 41.2, 'East Africa'),
    ('Gorgon', -20.38, 114.86, 'NW Shelf Australia'),
    ('Ichthys and Prelude', -13.91, 123.26, 'NW Shelf Australia'),
    ('Scarborough', -19.88, 113.15, 'NW Shelf Australia'),
    ('North Rankin and Goodwyn', -19.58, 116.13, 'NW Shelf Australia'),
    ('Bayu-Undan', -11.1, 126.5, 'NW Shelf Australia'),
    ('Kingfish (Gippsland)', -38.6, 148.15, 'Bass Strait'),
    ('Thylacine (Otway)', -39.24, 142.9, 'Bass Strait'),
    ('Kikeh and Gumusut-Kakap', 5.85, 114.35, 'SE Asia'),
    ('Tapis', 5.51, 104.99, 'SE Asia'),
    ('Bongkot', 7.83, 102.58, 'SE Asia'),
    ('Bach Ho', 9.73, 107.97, 'SE Asia'),
    ('Kutei deepwater (Jangkrik and Merakes)', -1.5, 118.0, 'SE Asia'),
    ('Malampaya', 11.64, 118.9, 'SE Asia'),
    ('Yadana', 15.19, 94.64, 'SE Asia'),
    ('Bozhong 19-6 (Bohai)', 38.55, 119.07, 'East Asia'),
    ('Pinghu (East China Sea)', 29.16, 124.9, 'East Asia'),
    ('Liuhua 11-1', 20.82, 115.73, 'East Asia'),
    ('Ulsan offshore (Donghae-1)', 35.4, 130.0, 'East Asia'),
    ('Changhua wind farm zone', 24.1, 119.9, 'East Asia'),
    ('Mumbai High', 19.3, 71.3, 'India'),
    ('KG-D6', 16.3, 82.6, 'India'),
    ('Hibernia', 46.75, -48.78, 'East Coast Canada'),
    ('Bay du Nord (Flemish Pass)', 47.95, -46.44, 'East Coast Canada'),
    ('Beaufort Sea off Prudhoe Bay', 71.0, -149.0, 'Alaska'),
    ('Chukchi Sea (Burger)', 71.3, -163.2, 'Alaska'),
    ('North Aleutian Basin', 56.5, -161.5, 'Alaska'),
    ('Vineyard Wind', 40.95, -70.55, 'US Atlantic'),
    ('Empire Wind (New York Bight)', 40.35, -73.35, 'US Atlantic'),
    ('Coastal Virginia Offshore Wind', 36.9, -75.4, 'US Atlantic'),
    ('Georges Bank', 41.5, -67.5, 'US Atlantic'),
    ('Columbus Basin (Trinidad)', 10.2, -60.3, 'Caribbean'),
    ('Maui (Taranaki)', -39.56, 173.42, 'New Zealand'),
]


def tile_deg():
    try:
        with open(WEB + "/data/manifest.json") as f:
            return float(json.load(f).get("tile_deg") or 5)
    except Exception:
        return 5.0


def km(a, b, c, d):
    p = math.pi / 180
    h = (math.sin((c - a) * p / 2) ** 2 +
         math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2)
    return 12742 * math.asin(min(1, math.sqrt(h)))


def region(tile, t):
    m = re.match(r"t_(-?\d+)_(-?\d+)$", tile)
    if not m:
        return tile
    la, lo = float(m.group(1)), float(m.group(2))
    cla, clo = la + t / 2, lo + t / 2

    def ns(v):
        return "%g%s" % (abs(v), "S" if v < 0 else "N")

    def ew(v):
        return "%g%s" % (abs(v), "W" if v < 0 else "E")
    box = "%s to %s, %s to %s" % (ns(la), ns(la + t), ew(lo), ew(lo + t))
    best = None
    for name, lat, lon, reg in LOCS:
        d = km(cla, clo, lat, lon)
        if best is None or d < best[0]:
            best = (d, reg)
    if best and best[0] <= 900:
        return "%s (%s)" % (best[1], box)
    return box


def salt():
    """A random key kept on this box, so visitor keys are never plain
    addresses and cannot be matched to anything outside it."""
    if not os.path.exists(SALT_FILE):
        with open(SALT_FILE, "w") as f:
            f.write(os.urandom(16).hex())
        os.chmod(SALT_FILE, 0o600)
    with open(SALT_FILE) as f:
        return f.read().strip()


def ref_host(ref):
    if not ref or ref == "-":
        return ""
    return re.sub(r"^https?://([^/:]+).*$", r"\1", ref).lower()


def internal_ref(host):
    """Requests from the preview copy on this box (its bare IP address) or
    from this host's own pages are the team testing, not visitors."""
    return host == "seastate-data.thrustm.com" or bool(re.match(r"^[\d.]+$|^\[", host))


def place_label(cell):
    """A 1 degree cell as words: the named place within 150 km, else the
    region within 600 km, else the bare position."""
    try:
        la, lo = [float(x) for x in cell.split(",")]
    except ValueError:
        return cell
    pos = "%g%s %g%s" % (abs(la), "S" if la < 0 else "N", abs(lo), "W" if lo < 0 else "E")
    best = None
    for name, lat, lon, reg in LOCS:
        d = km(la, lo, lat, lon)
        if best is None or d < best[0]:
            best = (d, name, reg)
    if best and best[0] <= 150:
        return "near %s, %s (%s)" % (best[1], best[2], pos)
    if best and best[0] <= 600:
        return "%s (%s)" % (best[2], pos)
    return pos


def page_label(p):
    if p == "home":
        return "Explorer (main page)"
    if p == "how":
        return "How it works"
    if p == "locations":
        return "Locations index"
    if p.startswith("loc:"):
        slug = p[4:]
        return "Location: " + slug.replace("-", " ").capitalize()
    return p


def open_log(path):
    if path.endswith(".gz"):
        return gzip.open(path, "rt", errors="replace")
    return open(path, errors="replace")


def new_day():
    return {"req": 0, "blocked": 0, "limited": 0, "internal": 0, "files": {},
            "tiles": {}, "refs": {}, "ua": {},
            "hit": {"team": 0, "team_v": set(), "v": set(), "ev": {}, "pages": {}, "src": {}, "places": {}}}


def parse(today):
    key_salt = salt()
    days = {}
    for path in sorted(glob.glob(LOGGLOB)):
        try:
            fh = open_log(path)
        except Exception:
            continue
        with fh:
            for line in fh:
                m = LINE.match(line)
                if not m:
                    continue
                ip, ts, url, status, ref, ua = m.groups()
                if ip in LOCAL or not url:
                    continue
                is_hit = url.startswith("/hit?")
                if not is_hit and not url.startswith("/data/"):
                    continue
                try:
                    day = datetime.datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z").astimezone(
                        datetime.timezone.utc).date()
                except ValueError:
                    continue
                if day >= today:
                    continue
                d = days.get(day)
                if d is None:
                    d = days[day] = new_day()
                if is_hit:
                    # the site's own pages only (hit.js sends from nowhere else)
                    if status != "204" or ref_host(ref) != SITE:
                        continue
                    q = dict(urllib.parse.parse_qsl(url.split("?", 1)[1]))
                    e = q.get("e", "")
                    if e not in EVENTS:
                        continue
                    v = hashlib.sha1((key_salt + ip + "|" + ua).encode("utf-8", "replace")).hexdigest()[:12]
                    h = d["hit"]
                    if q.get("t") == "1":
                        h["team"] += 1
                        h["team_v"].add(v)
                        continue
                    h["v"].add(v)
                    ev = h["ev"].setdefault(e, {"n": 0, "v": set()})
                    ev["n"] += 1
                    ev["v"].add(v)
                    if v not in h["src"]:
                        h["src"][v] = (q.get("s") or "direct")[:40]
                    if e == "pv":
                        pg = (q.get("p") or "home")[:60]
                        h["pages"].setdefault(pg, set()).add(v)
                    elif e == "place" and q.get("g"):
                        h["places"].setdefault(q["g"][:12], set()).add(v)
                    continue
                if internal_ref(ref_host(ref)):
                    d["internal"] += 1
                    continue
                d["req"] += 1
                path_only = url.split("?")[0]
                if status == "403":
                    d["blocked"] += 1
                elif status == "429":
                    d["limited"] += 1
                elif status in ("200", "304"):
                    d["files"].setdefault(ip, set()).add(path_only)
                    d["ua"][ip] = ua
                    t = TILE.match(path_only)
                    if t:
                        d["tiles"].setdefault("t_%s_%s" % (t.group(1), t.group(2)), set()).add(ip)
                    host = re.sub(r"^https?://([^/]+).*$", r"\1", ref) if ref and ref != "-" else "(none)"
                    d["refs"][host] = d["refs"].get(host, 0) + 1
    return days


def day_record(day, d):
    files = d["files"]
    heavy = sorted(((len(v), ip) for ip, v in files.items() if len(v) >= SCRAPE_FILES), reverse=True)
    # flagged addresses are reported on their own and kept out of the
    # people counts, or one scraper would read as a busy day
    hset = set(ip for n, ip in heavy)
    tiles = dict((k, len(v - hset)) for k, v in d["tiles"].items() if v - hset)
    return {
        "day": day.isoformat(),
        "lookups": sum(tiles.values()),
        "visitors": len(set(files) - hset),
        "data_requests": d["req"],
        "blocked": d["blocked"],
        "rate_limited": d["limited"],
        "max_files_one_address": max([len(v) for v in files.values()] or [0]),
        "tiles": tiles,
        "referers": dict(sorted(d["refs"].items(), key=lambda kv: -kv[1])[:10]),
        "heavy": [{"address": ip, "files": n, "browser": d["ua"].get(ip, "")[:160]} for n, ip in heavy[:10]],
        "internal_requests": d["internal"],
        # usage from hit.js; visitor keys are salted hashes, kept on this box
        # so the week can count each visitor once
        "hits": {
            "v": sorted(d["hit"]["v"]),
            "team_hits": d["hit"]["team"],
            "team_visitors": len(d["hit"]["team_v"]),
            "ev": dict((e, {"n": x["n"], "v": sorted(x["v"])}) for e, x in d["hit"]["ev"].items()),
            "pages": dict((k, sorted(x)) for k, x in d["hit"]["pages"].items()),
            "src": d["hit"]["src"],
            "places": dict((k, sorted(x)) for k, x in d["hit"]["places"].items()),
        },
    }


def health():
    out = {}
    try:
        u = shutil.disk_usage("/")
        out["disk_pct"] = round(100.0 * u.used / u.total, 1)
    except Exception:
        out["disk_pct"] = None
    out["cert_days"] = None
    if os.path.exists(CERT):
        try:
            s = subprocess.run(["openssl", "x509", "-enddate", "-noout", "-in", CERT],
                               capture_output=True, text=True, timeout=10).stdout.strip()
            end = datetime.datetime.strptime(s.split("=", 1)[1], "%b %d %H:%M:%S %Y %Z")
            out["cert_days"] = (end - datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)).days
        except Exception:
            pass
    # patching (secure.sh turns on automatic updates)
    out["reboot_required"] = os.path.exists("/var/run/reboot-required")
    out["updates_last_run"] = None
    for lp in ("/var/log/unattended-upgrades/unattended-upgrades.log",):
        if os.path.exists(lp):
            out["updates_last_run"] = datetime.datetime.fromtimestamp(os.path.getmtime(lp), datetime.timezone.utc).strftime("%Y-%m-%d")
    out["security_pending"] = None
    try:
        s = subprocess.run(["apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade"],
                           capture_output=True, text=True, timeout=120).stdout
        out["security_pending"] = sum(1 for l in s.splitlines() if l.startswith("Inst ") and "-security" in l)
    except Exception:
        pass
    return out


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    today = now.date()
    os.makedirs(DAILY, exist_ok=True)
    for day, d in parse(today).items():
        with open(os.path.join(DAILY, day.isoformat() + ".json"), "w") as f:
            json.dump(day_record(day, d), f)
    for p in glob.glob(os.path.join(DAILY, "*.json")):
        try:
            if (today - datetime.date.fromisoformat(os.path.basename(p)[:10])).days > KEEP_DAYS:
                os.remove(p)
        except ValueError:
            pass

    def load(day):
        p = os.path.join(DAILY, day.isoformat() + ".json")
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f)
        return {"day": day.isoformat(), "lookups": 0, "visitors": 0, "data_requests": 0, "blocked": 0,
                "rate_limited": 0, "max_files_one_address": 0, "tiles": {}, "referers": {}, "heavy": []}

    week = [load(today - datetime.timedelta(days=i)) for i in range(7, 0, -1)]
    prior = [load(today - datetime.timedelta(days=i)) for i in range(14, 7, -1)]
    yday = week[-1]
    t = tile_deg()
    regions = {}
    for r in week:
        for tile, n in r["tiles"].items():
            k = region(tile, t)
            regions[k] = regions.get(k, 0) + n
    refs = {}
    for r in week:
        for k, n in r["referers"].items():
            refs[k] = refs.get(k, 0) + n

    def visits(days):
        """The hit.js numbers over a run of days, each visitor once."""
        allv, ev, pages, places, src = set(), {}, {}, {}, {}
        team_h, team_v = 0, 0
        for r in days:
            hh = r.get("hits") or {}
            allv.update(hh.get("v") or [])
            team_h += hh.get("team_hits") or 0
            team_v += hh.get("team_visitors") or 0
            for e, x in (hh.get("ev") or {}).items():
                a = ev.setdefault(e, [0, set()])
                a[0] += x.get("n") or 0
                a[1].update(x.get("v") or [])
            for k, vs in (hh.get("pages") or {}).items():
                pages.setdefault(k, set()).update(vs)
            for k, vs in (hh.get("places") or {}).items():
                places.setdefault(k, set()).update(vs)
            for vk, sname in (hh.get("src") or {}).items():
                src.setdefault(vk, sname)     # the first source seen in the week
        by_src = {}
        for sname in src.values():
            by_src[sname] = by_src.get(sname, 0) + 1
        by_place = {}
        for cell, vs in places.items():
            lab = place_label(cell)
            by_place.setdefault(lab, set()).update(vs)
        funnel = {"visitors": len(allv)}
        for e in EVENTS:
            if e == "pv":
                continue
            a = ev.get(e)
            funnel[e] = {"n": a[0] if a else 0, "visitors": len(a[1]) if a else 0}
        return {
            "funnel": funnel,
            "page_views": ev.get("pv", [0])[0],
            "sources": sorted(([k, n] for k, n in by_src.items()), key=lambda kv: -kv[1])[:10],
            "places": sorted(([k, len(vs)] for k, vs in by_place.items()), key=lambda kv: -kv[1])[:12],
            "pages": sorted(([page_label(k), len(vs)] for k, vs in pages.items()), key=lambda kv: -kv[1])[:12],
            "team_hits": team_h,
            "team_visitor_days": team_v,
        }

    vw, vp = visits(week), visits(prior)

    # one row per day for ERPNext's daily table (TM Sea State Day), the last
    # DAILY_ROWS days that have a file, so a missed pull fills itself in
    daily = []
    for i in range(DAILY_ROWS, 0, -1):
        dd = today - datetime.timedelta(days=i)
        if not os.path.exists(os.path.join(DAILY, dd.isoformat() + ".json")):
            continue
        r = load(dd)
        v1 = visits([r])
        f1 = v1["funnel"]
        daily.append({
            "day": r["day"], "visitors": f1["visitors"], "page_views": v1["page_views"],
            "place_visitors": f1["place"]["visitors"], "places": f1["place"]["n"],
            "pdf": f1["pdf"]["n"], "share": f1["share"]["n"], "cta": f1["cta"]["n"],
            "li": f1["li"]["n"], "fb": f1["fb"]["n"],
            "lookups": r["lookups"], "data_visitors": r["visitors"],
            "team_hits": v1["team_hits"],
            "sources": v1["sources"], "top_places": v1["places"][:8],
        })
    vdays = []
    for r in week:
        hh = r.get("hits") or {}
        vdays.append({"day": r["day"], "visitors": len(hh.get("v") or []),
                      "places": len(set(x for vs in (hh.get("places") or {}).values() for x in vs))})

    def day_alerts(r, before):
        out = []
        for h in r["heavy"]:
            out.append("Possible scraping on %s: one address (%s) pulled %d different data files. Browser: %s"
                       % (r["day"], h["address"], h["files"], h["browser"] or "not given"))
        bad = r["blocked"] + r["rate_limited"]
        usual = sorted(x["blocked"] + x["rate_limited"] for x in before)
        median = usual[len(usual) // 2] if usual else 0
        if bad >= BLOCK_MIN and bad >= BLOCK_FACTOR * max(median, 1):
            out.append("Spike in refused requests on %s: %d blocked or rate limited (a usual day is about %d)."
                       % (r["day"], bad, median))
        return out

    alerts = day_alerts(yday, week[:-1])
    week_alerts = []
    for i, r in enumerate(week):
        week_alerts += day_alerts(r, (prior + week)[i:i + 7])
    h = health()
    if h.get("disk_pct") is not None and h["disk_pct"] >= DISK_PCT:
        alerts.append("Data host disk is %s%% full." % h["disk_pct"])
    if h.get("updates_last_run"):
        age = (today - datetime.date.fromisoformat(h["updates_last_run"])).days
        if age > 7 and (h.get("security_pending") or 0) > 0:
            alerts.append("Automatic updates have not run for %d days and %d security updates are waiting. "
                          "Run secure.sh on the data host." % (age, h["security_pending"]))
    if h.get("cert_days") is not None and h["cert_days"] < CERT_DAYS:
        alerts.append("The https certificate expires in %d days and should have renewed by now." % h["cert_days"])

    summary = {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "day": yday["day"],
        "yesterday": dict((k, yday[k]) for k in ("lookups", "visitors", "data_requests", "blocked",
                                                 "rate_limited", "max_files_one_address")),
        "week": {
            "from": week[0]["day"], "to": week[-1]["day"],
            "lookups": sum(r["lookups"] for r in week),
            "visitor_days": sum(r["visitors"] for r in week),
            "blocked": sum(r["blocked"] for r in week),
            "rate_limited": sum(r["rate_limited"] for r in week),
            "prior_lookups": sum(r["lookups"] for r in prior),
            "days": [{"day": r["day"], "lookups": r["lookups"], "visitors": r["visitors"]} for r in week],
            "regions": sorted(([k, n] for k, n in regions.items()), key=lambda kv: -kv[1])[:12],
            "referers": sorted(([k, n] for k, n in refs.items()), key=lambda kv: -kv[1])[:6],
            "alerts": week_alerts,
        },
        "visits": {"week": vw, "prior": vp, "days": vdays,
                   "internal_requests": sum(r.get("internal_requests") or 0 for r in week)},
        "daily": daily,
        "health": h,
        "alerts": alerts,
        "thresholds": {"scrape_files": SCRAPE_FILES, "block_min": BLOCK_MIN, "block_factor": BLOCK_FACTOR,
                       "disk_pct": DISK_PCT, "cert_days": CERT_DAYS},
    }
    with open(BASE + "/stats_token") as f:
        token = f.read().strip()
    out_dir = WEB + "/stats"
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, ".tmp.json")
    with open(tmp, "w") as f:
        json.dump(summary, f, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, os.path.join(out_dir, token + ".json"))
    print("%s  summary for %s: %d lookups, %d visitors, %d alerts"
          % (summary["generated"], yday["day"], yday["lookups"], yday["visitors"], len(alerts)))


if __name__ == "__main__":
    main()
PY
chmod +x "$BASE/stats_report.py"

( crontab -l 2>/dev/null | grep -v stats_report.py; echo "40 0 * * * /usr/bin/python3 /root/seastate/stats_report.py >> /root/seastate/stats.log 2>&1" ) | crontab -

echo "=== stats.sh $(date -u) ==="
if python3 "$BASE/stats_report.py"; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -k "https://127.0.0.1/stats/$TOKEN.json" -H "Host: seastate-data.thrustm.com")
  [ "$code" = 200 ] || code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/stats/$TOKEN.json")
  echo "summary served locally: HTTP $code"
  echo
  echo "STATS READY. Copy this token into the ERPNext script (letters a to f and digits only):"
  echo
  echo "    $TOKEN"
  echo
else
  echo "STATS FAILED: the report script stopped with an error (see above)."
fi
