#!/usr/bin/env python3
"""Build the citable static pages for the Sea State Explorer.

Reads the deployed wave tiles (manifest.json + t_*.json, optionally
assets.json) and writes, under --out (default web/):

    locations/<slug>.html   one self-contained page per curated location
    locations/index.html    every location grouped by region
    sitemap.xml             home, methodology, locations index, every page
    llms.txt                the llms.txt summary for AI assistants
    robots.txt              crawl rules (bulk /data/ and /vendor/ excluded)

Every number on a page is computed exactly the way web/data.js computes
it for a click at the same point: same tile probe box, same haversine
snap to the nearest cell, same per-mille decode, same day-weighted month
combination (combineMonths), same interpolation (interpExceedance), same
wind summary and weather-window bin logic (windowsPerMonth). Nothing is
interpolated between cells; each page states the data point it used.

The curated LOCATIONS list is embedded below. Every location is checked
against the data at build time: the nearest wave cell must sit within
manifest.max_snap_km, otherwise the location is reported and skipped.
When web/coastline.js is present the distance to the Natural Earth 50m
coastline is checked too (a warning under COAST_MIN_KM, never a skip).

Re-run after EVERY data change, against the live data set, from the repo:

    python3 seastate/tools/build_pages.py
    python3 seastate/tools/build_pages.py --data /path/to/live/data --out seastate/web

Standard library only. No network. Never writes into the data folder.
"""
import argparse
import datetime
import html
import io
import json
import math
import os
import re
import sys
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATA = os.path.normpath(os.path.join(HERE, "..", "web", "data"))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "web"))
DEFAULT_BASE_URL = "https://seastate.thrustm.com/"

GENERATED_NOTE = "generated file, do not edit by hand"
SITE_NAME = "Sea State Explorer"
COMPANY = "Thrust Maritime"

# Mirrors data.js: MONTH_DAYS weights the wind month combination; the wave
# exceedance is weighted by samples (combine_months).
MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]

# Table columns (only those the manifest actually carries are used).
TABLE_THRESHOLDS = [1, 1.5, 2, 2.5, 3, 4]
HEADLINE_HS = 2.0          # the headline number: % of time Hs above this
WINDOW_HS = 2.0            # weather-window line: spells below this ...
WINDOW_HOURS = 24          # ... lasting at least this long
COAST_MIN_KM = 20          # curation rule for the list; warning only
ASSET_MAX_KM = 400         # mirrors app.js nearestAsset(..., 400)

# Mirrors DEFAULTS in web/app.js. Keep the two in step by hand.
DISCLAIMER = ("These are long term climatological statistics and not a forecast. They are likely to "
              "underestimate extremes, especially close to coastlines, in sheltered or shallow water and in "
              "tropical cyclone conditions. The data is free for everyone to use, but it is not warranted by "
              "Thrust Maritime: use it at your own risk.")
TERMS = ("Free to use for planning purposes. "
         "Automated bulk extraction of the tool's data tiles is not permitted; the underlying "
         "open datasets are available from the original providers credited below and on the "
         "How it works page.")

# Fallback only: the live CTA is read from web/index.html at build time.
CTA_URL_FALLBACK = "https://www.thrustm.com"
CTA_HTML_FALLBACK = (
    '<h2>Planning a subsea lift?</h2>\n'
    '<p>Weather windows decide when a lift can go. Thrust Maritime provides specialist lifting\n'
    'solutions for subsea operations.</p>\n'
    '<p><a href="https://www.thrustm.com" target="_blank" rel="noopener">Talk to us at thrustm.com</a></p>')

FAVICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
           "%3Crect width='32' height='32' rx='6' fill='%2314304a'/%3E%3Cpath d='M4 20c3-4 6-4 8 0s6 4 8 0 "
           "6-4 8 0' stroke='%239ec5f4' stroke-width='2.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")

# Curated offshore working areas: (name, lat, lon, region, slug).
# Positions are the named field / platform / zone, anchored on the
# assets overlay where a record exists. Each sits at least 20 km from
# the Natural Earth coastline so it lands on an open-water wave cell.
LOCATIONS = [
    ("Ekofisk", 56.55, 3.21, "North Sea", "ekofisk"),
    ("Forties", 57.73, 0.92, "North Sea", "forties"),
    ("Statfjord", 61.25, 1.85, "North Sea", "statfjord"),
    ("Sleipner", 58.37, 1.91, "North Sea", "sleipner"),
    ("Troll", 60.64, 3.72, "North Sea", "troll"),
    ("Johan Sverdrup", 58.84, 2.55, "North Sea", "johan-sverdrup"),
    ("Dogger Bank wind farm zone", 54.75, 2.00, "North Sea", "dogger-bank"),
    ("Leman", 53.07, 2.22, "North Sea", "leman"),
    ("Tyra", 55.72, 4.78, "North Sea", "tyra"),
    ("Gemini wind farm", 54.03, 5.96, "North Sea", "gemini-wind-farm"),
    ("Clair", 60.68, -2.56, "West of Shetland", "clair"),
    ("Morecambe Bay gas fields", 53.90, -3.62, "Irish Sea", "morecambe-bay"),
    ("Corrib", 54.33, -11.06, "Atlantic Ireland", "corrib"),
    ("Heidrun", 65.31, 7.30, "Norwegian Sea", "heidrun"),
    ("Ormen Lange", 63.50, 5.38, "Norwegian Sea", "ormen-lange"),
    ("Aasta Hansteen", 67.05, 7.05, "Norwegian Sea", "aasta-hansteen"),
    ("Goliat", 71.30, 22.26, "Barents Sea", "goliat"),
    ("Johan Castberg", 72.45, 20.15, "Barents Sea", "johan-castberg"),
    ("Prirazlomnoye", 69.47, 56.63, "Barents Sea", "prirazlomnoye"),
    ("Arkona Basin wind farms", 54.83, 14.07, "Baltic Sea", "arkona-basin"),
    ("Zohr", 32.36, 32.86, "Mediterranean", "zohr"),
    ("Leviathan", 33.00, 33.65, "Mediterranean", "leviathan"),
    ("Raven (West Nile Delta)", 31.74, 29.95, "Mediterranean", "raven-west-nile-delta"),
    ("Bouri", 34.01, 12.47, "Mediterranean", "bouri"),
    ("Barbara (Adriatic)", 44.05, 13.76, "Mediterranean", "barbara-adriatic"),
    ("Sakarya", 42.75, 31.26, "Black Sea", "sakarya"),
    ("Neptun Deep", 43.88, 30.72, "Black Sea", "neptun-deep"),
    ("Northern Red Sea off Hurghada", 27.00, 34.80, "Red Sea", "northern-red-sea-hurghada"),
    ("Marjan", 28.44, 49.67, "Persian Gulf", "marjan"),
    ("North Field and South Pars", 26.57, 51.85, "Persian Gulf", "north-field-south-pars"),
    ("Upper Zakum", 24.84, 53.66, "Persian Gulf", "upper-zakum"),
    ("Azeri-Chirag-Guneshli", 40.22, 51.10, "Caspian Sea", "azeri-chirag-guneshli"),
    ("Kashagan", 46.49, 50.14, "Caspian Sea", "kashagan"),
    ("Mars-Ursa", 28.17, -89.22, "Gulf of Mexico", "mars-ursa"),
    ("Thunder Horse", 28.19, -88.50, "Gulf of Mexico", "thunder-horse"),
    ("Perdido", 26.13, -94.90, "Gulf of Mexico", "perdido"),
    ("Louisiana shelf (Ship Shoal and South Timbalier)", 28.60, -90.40, "Gulf of Mexico", "louisiana-shelf"),
    ("Cantarell", 19.45, -92.15, "Gulf of Mexico", "cantarell"),
    ("Roncador", -21.94, -39.75, "Brazil", "roncador"),
    ("Tupi", -25.40, -42.84, "Brazil", "tupi"),
    ("Búzios", -24.66, -42.50, "Brazil", "buzios"),
    ("Sergipe deepwater", -11.50, -36.20, "Brazil", "sergipe-deepwater"),
    ("Liza (Stabroek)", 8.11, -56.93, "Guyana and Suriname", "liza-stabroek"),
    ("Block 58 Suriname", 7.45, -56.05, "Guyana and Suriname", "block-58-suriname"),
    ("Girassol and Dalia (Block 17)", -7.66, 11.75, "West Africa", "girassol-dalia"),
    ("Bonga", 4.59, 4.61, "West Africa", "bonga"),
    ("Akpo and Egina (OML 130)", 3.20, 6.63, "West Africa", "akpo-egina"),
    ("Sankofa and Jubilee area", 4.45, -2.52, "West Africa", "sankofa-jubilee"),
    ("Greater Tortue Ahmeyim", 16.12, -17.63, "West Africa", "greater-tortue-ahmeyim"),
    ("Sangomar", 13.74, -17.61, "West Africa", "sangomar"),
    ("Venus (Orange Basin)", -29.50, 13.65, "Southern Africa", "venus-orange-basin"),
    ("Brulpadda and Luiperd", -35.85, 22.90, "Southern Africa", "brulpadda-luiperd"),
    ("Coral South (Rovuma)", -10.90, 41.20, "East Africa", "coral-south"),
    ("Gorgon", -20.38, 114.86, "NW Shelf Australia", "gorgon"),
    ("Ichthys and Prelude", -13.91, 123.26, "NW Shelf Australia", "ichthys-prelude"),
    ("Scarborough", -19.88, 113.15, "NW Shelf Australia", "scarborough"),
    ("North Rankin and Goodwyn", -19.58, 116.13, "NW Shelf Australia", "north-rankin-goodwyn"),
    ("Bayu-Undan", -11.10, 126.50, "NW Shelf Australia", "bayu-undan"),
    ("Kingfish (Gippsland)", -38.60, 148.15, "Bass Strait", "kingfish-gippsland"),
    ("Thylacine (Otway)", -39.24, 142.90, "Bass Strait", "thylacine-otway"),
    # the newsletter's west and east points (23 Oct 26), at the spots clicked
    # so the nearest cell is the one quoted (39.00 S 142.80 E, 38.20 S 148.60 E)
    ("West Bass Strait (Otway Basin)", -39.01, 142.71, "Bass Strait", "west-bass-strait"),
    ("East Bass Strait (Gippsland Basin)", -38.28, 148.57, "Bass Strait", "east-bass-strait"),
    ("Kikeh and Gumusut-Kakap", 5.85, 114.35, "SE Asia", "kikeh-gumusut-kakap"),
    ("Tapis", 5.51, 104.99, "SE Asia", "tapis"),
    ("Bongkot", 7.83, 102.58, "SE Asia", "bongkot"),
    ("Bach Ho", 9.73, 107.97, "SE Asia", "bach-ho"),
    ("Kutei deepwater (Jangkrik and Merakes)", -1.50, 118.00, "SE Asia", "kutei-deepwater"),
    ("Malampaya", 11.64, 118.90, "SE Asia", "malampaya"),
    ("Yadana", 15.19, 94.64, "SE Asia", "yadana"),
    ("Bozhong 19-6 (Bohai)", 38.55, 119.07, "East Asia", "bozhong-19-6"),
    ("Pinghu (East China Sea)", 29.16, 124.90, "East Asia", "pinghu"),
    ("Liuhua 11-1", 20.82, 115.73, "East Asia", "liuhua-11-1"),
    ("Ulsan offshore (Donghae-1)", 35.40, 130.00, "East Asia", "ulsan-offshore"),
    ("Changhua wind farm zone", 24.10, 119.90, "East Asia", "changhua-wind-zone"),
    ("Mumbai High", 19.30, 71.30, "India", "mumbai-high"),
    ("KG-D6", 16.30, 82.60, "India", "kg-d6"),
    ("Hibernia", 46.75, -48.78, "East Coast Canada", "hibernia"),
    ("Bay du Nord (Flemish Pass)", 47.95, -46.44, "East Coast Canada", "bay-du-nord"),
    ("Beaufort Sea off Prudhoe Bay", 71.00, -149.00, "Alaska", "beaufort-sea-prudhoe-bay"),
    ("Chukchi Sea (Burger)", 71.30, -163.20, "Alaska", "chukchi-sea-burger"),
    ("North Aleutian Basin", 56.50, -161.50, "Alaska", "north-aleutian-basin"),
    ("Vineyard Wind", 40.95, -70.55, "US Atlantic", "vineyard-wind"),
    ("Empire Wind (New York Bight)", 40.35, -73.35, "US Atlantic", "empire-wind"),
    ("Coastal Virginia Offshore Wind", 36.90, -75.40, "US Atlantic", "coastal-virginia-offshore-wind"),
    ("Georges Bank", 41.50, -67.50, "US Atlantic", "georges-bank"),
    ("Columbus Basin (Trinidad)", 10.20, -60.30, "Caribbean", "columbus-basin-trinidad"),
    ("Maui (Taranaki)", -39.56, 173.42, "New Zealand", "maui-taranaki"),
]


# How each region reads in prose ("lies in the North Sea", "lies off Brazil").
# Regions missing here fall back to "in <region>".
REGION_PHRASE = {
    "North Sea": "in the North Sea",
    "West of Shetland": "west of Shetland",
    "Irish Sea": "in the Irish Sea",
    "Atlantic Ireland": "off the west coast of Ireland",
    "Norwegian Sea": "in the Norwegian Sea",
    "Barents Sea": "in the Barents Sea",
    "Baltic Sea": "in the Baltic Sea",
    "Mediterranean": "in the Mediterranean",
    "Black Sea": "in the Black Sea",
    "Red Sea": "in the Red Sea",
    "Persian Gulf": "in the Persian Gulf",
    "Caspian Sea": "in the Caspian Sea",
    "Gulf of Mexico": "in the Gulf of Mexico",
    "Brazil": "off Brazil",
    "Guyana and Suriname": "off Guyana and Suriname",
    "West Africa": "off West Africa",
    "Southern Africa": "off southern Africa",
    "East Africa": "off East Africa",
    "NW Shelf Australia": "on the North West Shelf of Australia",
    "Bass Strait": "in Bass Strait",
    "SE Asia": "in South East Asia",
    "East Asia": "in East Asia",
    "India": "off India",
    "East Coast Canada": "off the east coast of Canada",
    "Alaska": "off Alaska",
    "US Atlantic": "off the US Atlantic coast",
    "Caribbean": "in the Caribbean",
    "New Zealand": "off New Zealand",
}


# ---------------------------------------------------------------- geometry

def haversine_km(lat1, lon1, lat2, lon2):
    """Same constants as data.js haversineKm (R = 6371)."""
    r = 6371.0
    d2r = math.pi / 180
    dlat = (lat2 - lat1) * d2r
    dlon = (lon2 - lon1) * d2r
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(lat1 * d2r) * math.cos(lat2 * d2r) * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def wrap_lon(lon):
    while lon < -180:
        lon += 360
    while lon >= 180:
        lon -= 360
    return lon


def js_round(x):
    """JavaScript Math.round: half rounds up. Python's round() is banker's."""
    return int(math.floor(x + 0.5))


def fmt_pct(p):
    """Mirrors data.js fmtPct."""
    if p is None or (isinstance(p, float) and math.isnan(p)):
        return "no data"
    if p < 0.05:
        return "<0.1%"
    if p < 10:
        return "%.1f%%" % p
    return "%d%%" % js_round(p)


def fmt_latlon(lat, lon):
    """Mirrors data.js fmtLatLon."""
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return "%.2f° %s, %.2f° %s" % (abs(lat), ns, abs(lon), ew)


# ---------------------------------------------------------------- tiles

class TileStore(object):
    """The wave tiles behind data.js TileProvider, read from disk."""

    def __init__(self, data_dir):
        self.data_dir = data_dir
        path = os.path.join(data_dir, "manifest.json")
        if not os.path.exists(path):
            raise SystemExit("no manifest.json in %s (pass --data)" % data_dir)
        self.mf = json.load(io.open(path, encoding="utf-8"))
        if self.mf.get("format") != 1:
            raise SystemExit("unsupported manifest format %r" % self.mf.get("format"))
        self.tiles = {}
        self.thresholds = self.mf["thresholds"]
        self.snap_km = self.mf.get("max_snap_km", 350)
        self.persist = self.mf.get("persist") or {"thresholds": [1.0, 1.5, 2.0, 2.5, 3.0],
                                                  "edges_h": [6, 12, 24, 48, 72, 120]}

    def tile_id_for(self, latc, lonc):
        t = self.mf["tile_deg"]
        tlat = int(math.floor((latc + 90) / t) * t - 90)
        tlon = int(math.floor((wrap_lon(lonc) + 180) / t) * t - 180)
        return "t_%d_%d" % (tlat, tlon)

    def load_tile(self, tid):
        if tid in self.tiles:
            return self.tiles[tid]
        if tid not in self.mf["tiles"]:
            self.tiles[tid] = None
            return None
        path = os.path.join(self.data_dir, tid + ".json")
        try:
            self.tiles[tid] = json.load(io.open(path, encoding="utf-8"))
        except (IOError, ValueError) as e:
            print("WARNING: tile %s listed in the manifest but unreadable: %s" % (tid, e))
            self.tiles[tid] = None
        return self.tiles[tid]

    def probe_ids(self, lat, lon):
        """The tile search box of data.js TileProvider.query, verbatim."""
        t = self.mf["tile_deg"]
        lon = wrap_lon(lon)
        d_lat = t * 0.6
        d_lon = min(2 * t, max(t * 0.6, self.snap_km / (111 * max(0.15, math.cos(lat * math.pi / 180)))))
        ids = []
        for k in (-1, 0, 1):
            la = max(-89.9, min(89.9, lat + k * d_lat))
            lo = lon - d_lon
            while lo <= lon + d_lon + 1e-9:
                tid = self.tile_id_for(la, lo)
                if tid not in ids:
                    ids.append(tid)
                lo += t * 0.5
            tid = self.tile_id_for(la, lon + d_lon)
            if tid not in ids:
                ids.append(tid)
        return ids

    def nearest_cell(self, lat, lon):
        """Nearest ocean cell by haversine, or None when nothing is in range."""
        lon = wrap_lon(lon)
        best = None
        for tid in self.probe_ids(lat, lon):
            tile = self.load_tile(tid)
            if not tile:
                continue
            nt = len(self.thresholds)
            for c in range(len(tile["lat"])):
                km = haversine_km(lat, lon, tile["lat"][c], tile["lon"][c])
                if best is not None and km >= best["km"]:
                    continue
                # data.js skips a cell with no valid month (high Arctic ice)
                if not any(tile["n"][c][m] > 0 and tile["exc"][c][m * nt] >= 0 for m in range(12)):
                    continue
                if True:
                    best = {"tile": tile, "idx": c, "km": km,
                            "lat": tile["lat"][c], "lon": tile["lon"][c]}
        if best is None or best["km"] > self.snap_km:
            return None
        return best

    def decode(self, best):
        """The per-cell decode of data.js TileProvider.query (the parts the
        pages use: exceedance, mean, samples, wind, weather windows)."""
        tile, idx = best["tile"], best["idx"]
        nt = len(self.thresholds)
        exc, mean, n = [], [], []
        wm = tile["wm"][idx] if tile.get("wm") else None
        w9 = tile["w9"][idx] if tile.get("w9") else None
        wq = tile["wq"][idx] if tile.get("wq") else None
        wqp = self.mf.get("wind_q")
        pw = tile["pw"][idx] if tile.get("pw") else None
        pt = len(self.persist["thresholds"])
        pb = len(self.persist["edges_h"]) + 1
        wind = {"mean": [], "p90": []} if (wm or w9) else None
        if wind is not None and wq and wqp and len(wq) == 12 * len(wqp):
            wind["q"], wind["qp"] = [], wqp
        runs = [] if pw else None
        for m in range(12):
            row = []
            for k in range(nt):
                v = tile["exc"][idx][m * nt + k]
                row.append(None if v < 0 else v / 10.0)      # permille -> %
            exc.append(row)
            v = tile["mean"][idx][m]
            mean.append(None if v < 0 else v / 10.0)          # decimetres -> m
            n.append(tile["n"][idx][m])
            if wind is not None:
                wind["mean"].append(wm[m] / 10.0 if (wm and wm[m] >= 0) else None)
                wind["p90"].append(w9[m] / 10.0 if (w9 and w9[m] >= 0) else None)
                if "q" in wind:
                    row = wq[m * len(wqp):(m + 1) * len(wqp)]
                    wind["q"].append(None if row[0] < 0 else [x / 10.0 for x in row])
            if runs is not None:
                if pw[m * pt * pb] < 0:
                    runs.append(None)
                else:
                    thr_rows = []
                    for t4 in range(pt):
                        bins = []
                        for b4 in range(pb):
                            bins.append(pw[m * pt * pb + t4 * pb + b4] / 10.0)
                        thr_rows.append(bins)
                    runs.append(thr_rows)
        return {
            "cell": {"lat": best["lat"], "lon": best["lon"], "res": self.mf["grid"]["res"]},
            "distanceKm": js_round(best["km"]),
            "exc": exc, "mean": mean, "n": n, "wind": wind,
            "windows": ({"thr": self.persist["thresholds"], "edges": self.persist["edges_h"], "runs": runs}
                        if runs is not None else None),
        }


# ---------------------------------------------------------------- statistics (mirror data.js)

def combine_months(data, months, thresholds):
    """data.js combineMonths: sample-weighted mean of the monthly exceedance."""
    used, n_total = [], 0
    for m in months:
        if data["n"][m] > 0 and data["exc"][m][0] is not None:
            used.append(m)
            n_total += data["n"][m]
    p = []
    for ti in range(len(thresholds)):
        num = den = 0.0
        for m in used:
            v = data["exc"][m][ti]
            if v is None:
                continue
            num += data["n"][m] * v
            den += data["n"][m]
        p.append(num / den if den > 0 else None)
    return {"p": p, "nTotal": n_total, "usedMonths": used}


def interp_exceedance(thresholds, p, h):
    """data.js interpExceedance: piecewise linear through (0, 100%)."""
    if p[0] is None:
        return {"p": None, "floor": False}
    if h <= 0:
        return {"p": 100.0, "floor": False}
    pts = [(0.0, 100.0)]
    for i in range(len(thresholds)):
        if p[i] is not None:
            pts.append((thresholds[i], p[i]))
    last = pts[-1]
    if h >= last[0]:
        return {"p": last[1], "floor": h > last[0]}
    for i in range(1, len(pts)):
        if h <= pts[i][0]:
            a, b = pts[i - 1], pts[i]
            t = (h - a[0]) / (b[0] - a[0])
            return {"p": a[1] + t * (b[1] - a[1]), "floor": False}
    return {"p": last[1], "floor": True}


def wind_quantile(data, months, prob):
    """data.js windQuantile: months' distribution points combined, solved."""
    w = data["wind"]
    qp = w["qp"]
    used = [m for m in months if w["q"][m]]
    if not used:
        return None

    def cdf(m, x):
        sp = w["q"][m]
        if x <= 0:
            return 0.0
        if x <= sp[0]:
            return qp[0] * x / max(sp[0], 1e-9)
        for k in range(1, len(sp)):
            if x <= sp[k]:
                return (qp[k - 1] + (x - sp[k - 1]) / (sp[k] - sp[k - 1]) * (qp[k] - qp[k - 1])
                        if sp[k] > sp[k - 1] else qp[k])
        top = sp[-1] * 1.1 + 0.5
        return 1.0 if x >= top else qp[-1] + (x - sp[-1]) / (top - sp[-1]) * (1 - qp[-1])

    def F(x):
        return sum(MONTH_DAYS[m] * cdf(m, x) for m in used) / sum(MONTH_DAYS[m] for m in used)

    lo, hi = 0.0, 80.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if F(mid) < prob:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def wind_summary(data, months):
    """data.js windSummary: day-weighted monthly means; the P90 from the
    combined distribution when the tiles carry it, else the monthly average."""
    if not data["wind"]:
        return None
    out = wind_summary_avg(data, months)
    if out is not None and "q" in data["wind"]:
        q90 = wind_quantile(data, months, 0.9)
        if q90 is not None:
            out["p90"] = q90
    return out


def wind_summary_avg(data, months):
    if not data["wind"]:
        return None
    num = den = num9 = den9 = 0.0
    for m in months:
        if data["wind"]["mean"][m] is not None:
            num += MONTH_DAYS[m] * data["wind"]["mean"][m]
            den += MONTH_DAYS[m]
        if data["wind"]["p90"][m] is not None:
            num9 += MONTH_DAYS[m] * data["wind"]["p90"][m]
            den9 += MONTH_DAYS[m]
    if not den and not den9:
        return None
    return {"mean": num / den if den else None, "p90": num9 / den9 if den9 else None}


WIN_BIN_MEAN_H = [3, 7.5, 16.5, 34.5, 58.5, 94.5, 180]


def window_periods_per_month(data, thr_idx, edge_idx, thresholds):
    """data.js windowPeriodsPerMonth: separate, non-overlapping periods of
    edges[edge_idx] hours below thr in a typical month (see the comment
    there for the estimate)."""
    w = data["windows"]
    if not w or not w["runs"]:
        return None
    D = w["edges"][edge_idx]
    thr = w["thr"][thr_idx]
    lows = [0] + list(w["edges"])
    out = []
    for m in range(12):
        runs = w["runs"][m]
        if not runs or thr_idx >= len(runs) or not data["n"][m]:
            out.append(None)
            continue
        ex = interp_exceedance(thresholds, data["exc"][m], thr)
        if ex["p"] is None:
            out.append(None)
            continue
        bins = runs[thr_idx]
        month_h = MONTH_DAYS[m] * 24
        calm_h = max(0.0, 100 - ex["p"]) / 100 * month_h
        short_h = long_n = lo = hi = 0.0
        for b in range(len(bins)):
            if b <= edge_idx:
                short_h += bins[b] * WIN_BIN_MEAN_H[b]
                continue
            long_n += bins[b]
            lo += bins[b] * lows[b]
            hi += bins[b] * (w["edges"][b] if b < len(w["edges"]) else 240)
        long_h = min(hi, max(lo, calm_h - short_h))
        top = bins[len(w["edges"])] if len(bins) > len(w["edges"]) else 0
        loss_n = long_n - top * (calm_h / month_h)
        v = long_h / D - loss_n * (D - 3) / (2.0 * D)
        floor_v = sum(bins[b] * (lows[b] // D) for b in range(edge_idx + 1, len(bins)))
        v = max(floor_v, min(v, long_h / D, month_h // D))
        out.append(js_round(max(0.0, v) * 10) / 10.0)
    return out


def windows_per_month(data, thr_idx, edge_idx):
    """data.js windowsPerMonth: spells below thr lasting at least edges[edge_idx]
    hours, per calendar month (long term average per year)."""
    if not data["windows"] or not data["windows"]["runs"]:
        return None
    out = []
    for m in range(12):
        runs = data["windows"]["runs"][m]
        if not runs or thr_idx >= len(runs):
            out.append(None)
            continue
        bins = runs[thr_idx]
        s = 0.0
        for b in range(edge_idx + 1, len(bins)):
            s += bins[b]
        out.append(js_round(s * 10) / 10.0)
    return out


def day_weighted_mean(values, months):
    num = den = 0.0
    for m in months:
        if values[m] is not None:
            num += MONTH_DAYS[m] * values[m]
            den += MONTH_DAYS[m]
    return num / den if den else None


# ---------------------------------------------------------------- optional context

def load_assets(data_dir):
    path = os.path.join(data_dir, "assets.json")
    if not os.path.exists(path):
        return None
    try:
        doc = json.load(io.open(path, encoding="utf-8"))
    except ValueError as e:
        print("WARNING: assets.json unreadable, skipping the nearest-asset line: %s" % e)
        return None
    out = []
    for a in doc.get("assets", []):
        name = (a.get("n") or "").strip()
        # "named": a real name, not the overlay's placeholder, and not a
        # well designation (the well layer would dominate every lookup).
        if not name or name.lower().startswith("unnamed") or a.get("t") == "well":
            continue
        # the register's own credit rides with the asset: a page that names
        # one owes its source the attribution (launch review, 23 Oct 26)
        srcs = doc.get("sources") or []
        si = a.get("src")
        a = dict(a)
        a["attr"] = (srcs[si].get("attribution") or "") if isinstance(si, int) and si < len(srcs) else ""
        out.append(a)
    return out


def nearest_named_asset(assets, lat, lon, max_km):
    """Mirrors data.js nearestAsset on the named subset; distance from the
    data point, like the app's context line."""
    best = None
    for a in assets:
        km = haversine_km(lat, lon, a["la"], a["lo"])
        if best is None or km < best["km"]:
            best = {"asset": a, "km": km}
    if best is None:
        return None
    best["km"] = js_round(best["km"])
    return best if best["km"] <= max_km else None


def load_coast(out_dir):
    """Decode web/coastline.js (delta-encoded rings x100) for the coast check."""
    path = os.path.join(out_dir, "coastline.js")
    if not os.path.exists(path):
        return None
    src = io.open(path, encoding="utf-8").read()
    m = re.search(r"window\.TM_COAST_ENC\s*=\s*(\[.*\]);", src, re.S)
    if not m:
        return None
    try:
        enc = json.loads(m.group(1))
    except ValueError:
        return None
    rings = []
    for flat in enc:
        pts, x, y = [], 0, 0
        for k in range(0, len(flat), 2):
            x += flat[k]
            y += flat[k + 1]
            pts.append((x / 100.0, y / 100.0))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        rings.append((pts, min(xs), max(xs), min(ys), max(ys)))
    return rings


def coast_km(rings, lat, lon):
    """Distance to the nearest coastline segment (local flat-earth metric,
    fine for a 20 km rule)."""
    best = 1e9
    pad = 4.0
    cl = math.cos(lat * math.pi / 180)
    for pts, x0, x1, y0, y1 in rings:
        if lon < x0 - pad or lon > x1 + pad or lat < y0 - pad or lat > y1 + pad:
            continue
        n = len(pts)
        for k in range(n):
            a = pts[k]
            b = pts[(k + 1) % n]
            if abs(a[1] - lat) > pad and abs(b[1] - lat) > pad:
                continue
            ax = (a[0] - lon) * cl * 111.32
            ay = (a[1] - lat) * 110.57
            bx = (b[0] - lon) * cl * 111.32
            by = (b[1] - lat) * 110.57
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            if l2 == 0:
                d = math.hypot(ax, ay)
            else:
                t = max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
                d = math.hypot(ax + t * dx, ay + t * dy)
            if d < best:
                best = d
    return best


def read_cta(out_dir):
    """The call to action, lifted from web/index.html so the pages never
    drift from it. Returns (inner_html, href)."""
    path = os.path.join(out_dir, "index.html")
    if not os.path.exists(path):
        # building into a scratch folder: read the explorer page in the repo
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "index.html")
    if os.path.exists(path):
        src = io.open(path, encoding="utf-8").read()
        m = re.search(r'<section class="tm-cta">(.*?)</section>', src, re.S)
        if m:
            inner = m.group(1).strip()
            href = re.search(r'<a[^>]*\bhref="([^"]+)"', inner)
            # the explorer's own link carries its UTM tags; keep the bare
            # site address here and tag each page's links itself
            base = html.unescape(href.group(1)).split("?")[0] if href else CTA_URL_FALLBACK
            return inner, base.rstrip("/") if base.count("/") == 3 else base
    print("NOTE: CTA not found in %s, using the embedded fallback" % path)
    return CTA_HTML_FALLBACK, CTA_URL_FALLBACK


# ---------------------------------------------------------------- per-location numbers

def compute(loc, store, assets):
    """Everything a page states, computed the way the app computes it."""
    name, lat, lon, region, slug = loc
    best = store.nearest_cell(lat, lon)
    if best is None:
        return None, "no wave cell within %s km" % store.snap_km
    data = store.decode(best)
    th = store.thresholds
    all_months = list(range(12))
    year = combine_months(data, all_months, th)
    if not year["usedMonths"]:
        return None, "cell has no wave statistics in any month"

    def at(h, p):
        return interp_exceedance(th, p, h)["p"]

    monthly = []
    for m in range(12):
        has = data["n"][m] > 0 and data["exc"][m][0] is not None
        row = {"month": MONTH_NAMES[m], "mean": data["mean"][m], "has": has, "pct": {}}
        for t in TABLE_THRESHOLDS:
            row["pct"][t] = at(t, data["exc"][m]) if has else None
        monthly.append(row)
    cols = [t for t in TABLE_THRESHOLDS if any(abs(t - x) < 1e-9 for x in th)]
    year_pct = dict((t, at(t, year["p"])) for t in cols)
    head = at(HEADLINE_HS, year["p"])
    if head is None:
        return None, "no exceedance statistics at %s m" % HEADLINE_HS

    with_mean = [m for m in year["usedMonths"] if data["mean"][m] is not None]
    rough = calm = None
    if with_mean:
        rough = max(with_mean, key=lambda m: data["mean"][m])
        calm = min(with_mean, key=lambda m: data["mean"][m])
    missing = [m for m in range(12) if m not in year["usedMonths"]]

    wind = None
    ws = wind_summary(data, year["usedMonths"])
    if ws and (ws["mean"] is not None or ws["p90"] is not None):
        means = data["wind"]["mean"]
        have = [m for m in range(12) if means[m] is not None]
        wind = {"mean": ws["mean"], "p90": ws["p90"], "monthly": means, "p90m": data["wind"]["p90"],
                "windiest": max(have, key=lambda m: means[m]) if have else None,
                "calmest": min(have, key=lambda m: means[m]) if have else None}

    windows = None
    w = data["windows"]
    if w:
        ti = [i for i, v in enumerate(w["thr"]) if abs(v - WINDOW_HS) < 1e-9]
        ei = [i for i, v in enumerate(w["edges"]) if abs(v - WINDOW_HOURS) < 1e-9]
        if ti and ei:
            per = window_periods_per_month(data, ti[0], ei[0], th)
            have_w = [m for m in range(12) if per and per[m] is not None]
            if have_w:
                low_m = min(have_w, key=lambda m: per[m] / MONTH_DAYS[m])
                windows = {"avg": sum(per[m] for m in have_w) / len(have_w), "months": len(have_w),
                           "low_m": low_m, "low": per[low_m]}
        else:
            print("NOTE: manifest.persist has no %s m / %s h bin, no weather-window line" %
                  (WINDOW_HS, WINDOW_HOURS))

    near = nearest_named_asset(assets, data["cell"]["lat"], data["cell"]["lon"], ASSET_MAX_KM) if assets else None

    return {
        "name": name, "lat": lat, "lon": lon, "region": region, "slug": slug,
        "cell": data["cell"], "distanceKm": data["distanceKm"], "nTotal": year["nTotal"],
        "monthly": monthly, "cols": cols, "year_pct": year_pct, "head": head,
        "year_mean": day_weighted_mean(data["mean"], year["usedMonths"]),
        "rough": rough, "calm": calm, "means": data["mean"], "missing": missing,
        "wind": wind, "windows": windows, "near": near,
    }, None


# ---------------------------------------------------------------- wording

def esc(s):
    return html.escape("%s" % s, quote=True)


def pct_words(p):
    """fmt_pct for prose: "about 36%", "under 0.1%"."""
    s = fmt_pct(p)
    if s == "no data":
        return s
    if s.startswith("<"):
        return "under " + s[1:]
    return "about " + s


def days_per_month(p):
    """Mirrors the app's headline: (p * 0.3044) days, 1 decimal under 3."""
    d = p * 0.3044
    return ("%.1f" % d) if d < 3 else ("%d" % js_round(d))


def month_range_words(ms):
    """"November to April" for a contiguous run (wrapping), else a list."""
    if not ms:
        return ""
    names = [MONTH_NAMES[m] for m in ms]
    if len(ms) == 1:
        return names[0]
    s = set(ms)
    for start in ms:
        run = [(start + i) % 12 for i in range(len(ms))]
        if all(r in s for r in run):
            return MONTH_NAMES[run[0]] + " to " + MONTH_NAMES[run[-1]]
    return ", ".join(names[:-1]) + " and " + names[-1]


def lead_paragraph(r):
    """The headline numbers in words. One paragraph, plain voice."""
    parts = []
    where = REGION_PHRASE.get(r["region"], "in " + r["region"])
    if r["region"].lower() in r["name"].lower():
        parts.append("%s is at %s." % (r["name"], fmt_latlon(r["lat"], r["lon"])))
    else:
        parts.append("%s lies %s at %s." % (r["name"], where, fmt_latlon(r["lat"], r["lon"])))
    span = "across the whole year" if not r["missing"] else "across the months with data"
    if r["head"] * 0.3044 < 0.05:
        days = "less than a day a month on average"
    else:
        days = "roughly %s days a month on average" % days_per_month(r["head"])
    parts.append("Significant wave height there exceeds %g m %s of the time %s, %s."
                 % (HEADLINE_HS, pct_words(r["head"]), span, days))
    if r["rough"] is not None and r["calm"] is not None and r["rough"] != r["calm"]:
        rm, cm = r["rough"], r["calm"]
        rp = r["monthly"][rm]["pct"].get(HEADLINE_HS)
        cp = r["monthly"][cm]["pct"].get(HEADLINE_HS)
        parts.append("The roughest month is %s, with a mean significant wave height of %.1f m and seas above %g m %s of the time; the calmest is %s, with a mean of %.1f m and %s of the time above %g m."
                     % (MONTH_NAMES[rm], r["means"][rm], HEADLINE_HS, pct_words(rp),
                        MONTH_NAMES[cm], r["means"][cm], pct_words(cp), HEADLINE_HS))
    if 4 in r["cols"] and r["year_pct"].get(4) is not None:
        parts.append("Waves above 4 m occur %s of the time." % pct_words(r["year_pct"][4]))
    if r["missing"]:
        parts.append("The source holds no wave statistics for %s at this cell, which usually means sea ice; the annual figures on this page cover the remaining months only."
                     % month_range_words(r["missing"]))
    return " ".join(parts)


def wind_line(r):
    w = r["wind"]
    if not w:
        return None
    bits = []
    if w["mean"] is not None:
        bits.append("typically %.1f m/s (%d kn)" % (w["mean"], js_round(w["mean"] * 1.94384)))
    if w["p90"] is not None:
        bits.append("top 10%% above %.1f m/s (%d kn)" % (w["p90"], js_round(w["p90"] * 1.94384)))
    s = "Wind at 10 m across the year: " + ", ".join(bits) + "."
    if w["windiest"] is not None and w["calmest"] is not None and w["windiest"] != w["calmest"]:
        s += " Monthly means run from %.1f m/s in %s to %.1f m/s in %s." % (
            w["monthly"][w["calmest"]], MONTH_NAMES[w["calmest"]],
            w["monthly"][w["windiest"]], MONTH_NAMES[w["windiest"]])
    return s


def windows_line(r):
    w = r["windows"]
    if not w:
        return None
    def n_txt(c):
        return ("%d" % js_round(c)) if c >= 10 else ("%g" % (js_round(c * 10) / 10.0))
    s = "Weather windows: a typical month fits about %s separate %d h periods with significant wave height below %g m" % (
        n_txt(w["avg"]), WINDOW_HOURS, WINDOW_HS)
    if w["months"] > 1 and w["low"] / MONTH_DAYS[w["low_m"]] * 30.4 < w["avg"] - 2:
        s += ", fewest in %s (about %s)" % (MONTH_NAMES[w["low_m"]], n_txt(w["low"]))
    s += "." if w["months"] == 12 else " (over the %d months with data)." % w["months"]
    s += " Periods do not overlap, so a 30 day month holds at most %d." % (30 * 24 // WINDOW_HOURS)
    return s


def basis_line(r, mf):
    src = (mf.get("source_label") or mf.get("source") or "").replace(" + ", " and ")
    s = "Data basis: %s, %s. Data point %s (%s° grid), %d km from the named position, %s samples. Values are for the nearest grid cell and are not interpolated." % (
        src, mf.get("period"), fmt_latlon(r["cell"]["lat"], r["cell"]["lon"]), r["cell"]["res"],
        r["distanceKm"], format(r["nTotal"], ","))
    return s


def asset_line(r):
    n = r["near"]
    if not n:
        return None
    a = n["asset"]
    kind = (a.get("t") or "asset").replace("lng terminal", "LNG terminal")
    kind = re.sub(r"^field \((.*)\)$", r"\1 field", kind)
    s = "Nearest mapped asset to the data point: %s, %s" % (a["n"], kind)
    if a.get("d"):
        s += ", about %s m water depth" % format(int(a["d"]), ",")
    s += ", %d km away." % n["km"]
    if a.get("attr"):
        s += " Source: %s" % a["attr"].split(": ", 1)[-1]
    return s


def cite_line(r, mf, base_url, date):
    src = (mf.get("source_label") or mf.get("source") or "").replace(" + ", " and ")
    return "%s, %s, %s, %s %s, page built %s, accessed [date], %slocations/%s.html" % (
        COMPANY, SITE_NAME, r["name"], src, mf.get("period"), date, base_url, r["slug"])


def temporal_coverage(period):
    years = re.findall(r"\b(\d{4})\b", period or "")
    if len(years) >= 2:
        return years[0] + "/" + years[-1]
    if len(years) == 1:
        return years[0]
    return period or ""


# ---------------------------------------------------------------- HTML

CSS = """
:root { --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --muted:#6b6964;
  --grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,0.10); --accent:#1f66b8; --accent-deep:#14304a; }
* { box-sizing: border-box; }
html, body { margin:0; padding:0; background:var(--page); color:var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size:15px; line-height:1.45; }
.tm-page { max-width: 900px; margin: 0 auto; padding: 18px 20px 40px; }
.tm-header { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; padding: 4px 2px 10px; }
.tm-brand-name { font-weight:700; letter-spacing:0.14em; color:var(--accent-deep); font-size:15px; text-decoration:none; }
.tm-brand-sep { width:1px; height:14px; background:var(--baseline); align-self:center; }
.tm-brand-tool { font-weight:600; font-size:19px; margin:0; }
.tm-brand-tool a { color:var(--ink); text-decoration:none; }
.tm-crumbs { font-size:12.5px; color:var(--muted); margin: 4px 0 14px; }
.tm-crumbs a { color:var(--muted); }
h1 { font-size: 26px; line-height:1.2; margin: 0 0 12px; }
h2 { font-size: 17px; margin: 22px 0 8px; }
p { max-width: 720px; }
.tm-lead { font-size: 16.5px; }
.tm-open { display:inline-block; margin: 6px 0 4px; padding: 10px 16px; background:var(--accent-deep);
  color:#fff; border-radius:8px; text-decoration:none; font-weight:600; }
.tm-open:hover { background:#1c4266; }
.tm-basis { color:var(--ink-2); font-size:13.5px; }
.tm-table-wrap { background:var(--surface); border:1px solid var(--border); border-radius:10px;
  padding:6px 12px; overflow-x:auto; margin: 8px 0 4px; }
table { width:100%; border-collapse:separate; border-spacing:0; font-size:13.5px; }
th { text-align:right; color:var(--ink-2); font-weight:600; padding:7px 10px; border-bottom:1px solid var(--grid); }
th:first-child, td:first-child { text-align:left; }
td { text-align:right; padding:5px 10px; border-bottom:1px solid var(--grid); font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom:none; }
tr.tm-year td { background:#eef4fc; font-weight:600; }
.tm-cta { margin-top:26px; padding:18px; background:var(--accent-deep); color:#e8eef4; border-radius:10px; }
.tm-cta h2 { margin:0 0 6px; font-size:17px; color:#fff; }
.tm-cta p { margin:4px 0; max-width:720px; }
.tm-cta a { color:#9ec5f4; font-weight:600; }
.tm-cta a.tm-li, .cta a.tm-li { display:inline-flex; align-items:center; gap:7px; margin-top:6px; padding:5px 13px; border:1px solid rgba(255,255,255,.5); border-radius:999px; color:#fff; text-decoration:none; font-weight:600; }
.tm-cta a.tm-li:hover, .cta a.tm-li:hover { background:rgba(255,255,255,.12); }
.tm-li svg { width:15px; height:15px; fill:currentColor; flex:none; }
.tm-cite { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:10px 14px;
  font-size:13.5px; word-break: break-word; }
.tm-footer { margin-top:18px; color:var(--muted); font-size:12px; }
.tm-footer p { margin:6px 0; max-width:900px; }
.tm-region { margin: 18px 0 4px; }
.tm-loclist { list-style:none; padding:0; margin:0 0 6px; }
.tm-loclist li { padding: 4px 0; border-bottom: 1px solid var(--grid); display:flex; justify-content:space-between; gap:12px; max-width:720px; }
.tm-loclist .tm-pct { color:var(--ink-2); font-variant-numeric: tabular-nums; white-space:nowrap; }
a { color: var(--accent); }
"""


def hit_tag():
    """The usage signal script (web/hit.js), versioned by its own content so
    a change to it is never served stale from a cached copy."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "hit.js")
    try:
        import hashlib
        v = hashlib.sha1(io.open(path, "rb").read()).hexdigest()[:10]
    except Exception:
        v = "1"
    return '<script src="../hit.js?v=%s" defer></script>\n' % v


def page_shell(title, description, canonical, jsonld, body):
    ld = "\n".join('<script type="application/ld+json">\n%s\n</script>' %
                   json.dumps(d, ensure_ascii=False, indent=1).replace("</", "<\\/") for d in jsonld)
    return ("<!DOCTYPE html>\n<!-- %s -->\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
            "<title>%s</title>\n<meta name=\"description\" content=\"%s\">\n"
            "<link rel=\"canonical\" href=\"%s\">\n"
            "<meta name=\"theme-color\" content=\"#14304a\">\n"
            "<meta property=\"og:type\" content=\"article\">\n<meta property=\"og:site_name\" content=\"%s\">\n"
            "<meta property=\"og:title\" content=\"%s\">\n<meta property=\"og:description\" content=\"%s\">\n"
            "<meta property=\"og:url\" content=\"%s\">\n"
            "<link rel=\"icon\" href=\"%s\">\n<style>%s</style>\n%s\n</head>\n<body>\n<div class=\"tm-page\">\n%s\n</div>\n%s</body>\n</html>\n"
            % (GENERATED_NOTE, esc(title), esc(description), esc(canonical), esc(COMPANY), esc(title),
               esc(description), esc(canonical), FAVICON, CSS, ld, body, hit_tag()))


def utm(base, content):
    """thrustm.com link tagged so Wix analytics can tell which page sent
    the visit (Ben, 23 Oct 26)."""
    if re.match(r"^https?://[^/]+$", base):
        base += "/"
    return base + ("&" if "?" in base else "?") + (
        "utm_source=seastate&utm_medium=referral&utm_campaign=sea_state_explorer&utm_content=" + content)


def cta_tagged(cta_html, cta_url, content):
    return re.sub(r'(<a[^>]*\bhref=")[^"]*(")', lambda m: m.group(1) + esc(utm(cta_url, content)) + m.group(2),
                  cta_html, count=1)


def header_html(home_rel, cta_url, content="location_logo"):
    return ('<header class="tm-header">\n<a class="tm-brand-name" href="%s" target="_blank" rel="noopener">THRUST MARITIME</a>\n'
            '<span class="tm-brand-sep"></span>\n<p class="tm-brand-tool"><a href="%s">%s</a></p>\n</header>'
            % (esc(utm(cta_url, content)), esc(home_rel), esc(SITE_NAME)))


def footer_html(mf, extra_attr=None):
    attrs = [mf.get("attribution") or ""]
    if extra_attr:
        attrs.append(extra_attr)
    return ('<footer class="tm-footer">\n<p>%s</p>\n<p>%s</p>\n<p>%s</p>\n</footer>'
            % (esc(DISCLAIMER), esc(TERMS), esc(" ".join(a for a in attrs if a))))


def location_page(r, mf, base_url, date, cta_html, cta_url):
    title = "Sea state at %s: wave height exceedance by month" % r["name"]
    src = (mf.get("source_label") or mf.get("source") or "").replace(" + ", " and ")
    canonical = "%slocations/%s.html" % (base_url, r["slug"])
    description = ("Monthly and annual percentage of time significant wave height exceeds %s m at %s, with mean wave height by month%s, from %s, %s. Free, from %s."
                   % (" to ".join(["%g" % r["cols"][0], "%g" % r["cols"][-1]]) if r["cols"] else "2",
                      r["name"] if r["region"].lower() in r["name"].lower() else "%s (%s)" % (r["name"], r["region"]),
                      ", wind and weather windows" if (r["wind"] or r["windows"]) else "", src, mf.get("period"), COMPANY))
    loc_param = "loc=%.2f,%.2f" % (r["lat"], r["lon"])

    # table
    th_cells = "".join("<th>%% above %g m</th>" % t for t in r["cols"])
    rows = []
    for row in r["monthly"]:
        cells = "<td>%s</td>" % (("%.1f" % row["mean"]) if row["mean"] is not None else "no data")
        for t in r["cols"]:
            cells += "<td>%s</td>" % esc(fmt_pct(row["pct"][t]) if row["has"] else "no data")
        rows.append("<tr><td>%s</td>%s</tr>" % (esc(row["month"]), cells))
    ycells = "<td>%s</td>" % (("%.1f" % r["year_mean"]) if r["year_mean"] is not None else "no data")
    for t in r["cols"]:
        ycells += "<td>%s</td>" % esc(fmt_pct(r["year_pct"][t]))
    rows.append('<tr class="tm-year"><td>%s</td>%s</tr>' % (
        "Year" if not r["missing"] else "Months with data", ycells))
    table = ('<div class="tm-table-wrap"><table>\n<thead><tr><th>Month</th><th>Mean H<sub>s</sub> (m)</th>%s</tr></thead>\n'
             '<tbody>\n%s\n</tbody></table></div>' % (th_cells, "\n".join(rows)))

    lines = []
    wl = wind_line(r)
    if wl:
        lines.append('<p class="tm-basis">%s</p>' % esc(wl))
    ol = windows_line(r)
    if ol:
        lines.append('<p class="tm-basis">%s</p>' % esc(ol))
    al = asset_line(r)
    if al:
        lines.append('<p class="tm-basis">%s</p>' % esc(al))

    jsonld = [{
        "@context": "https://schema.org",
        "@type": "Dataset",
        "name": title,
        "description": description,
        "url": canonical,
        "keywords": ["significant wave height", "wave height exceedance", "metocean statistics",
                     "weather windows", r["name"], r["region"]],
        "spatialCoverage": {"@type": "Place", "name": "%s, %s" % (r["name"], r["region"]),
                            "geo": {"@type": "GeoCoordinates", "latitude": r["lat"], "longitude": r["lon"]}},
        "temporalCoverage": temporal_coverage(mf.get("period")),
        "isBasedOn": {"@type": "Dataset", "name": src},
        "creator": {"@type": "Organization", "name": COMPANY, "url": cta_url},
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "creditText": mf.get("attribution") or "",
        "isAccessibleForFree": True,
        "variableMeasured": [
            "Percentage of time significant wave height exceeds %g m, by calendar month" % t for t in r["cols"]
        ] + ["Mean significant wave height by calendar month (m)"],
    }, {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": base_url},
            {"@type": "ListItem", "position": 2, "name": "Locations", "item": base_url + "locations/index.html"},
            {"@type": "ListItem", "position": 3, "name": r["name"], "item": canonical},
        ],
    }]

    body = "\n".join([
        header_html("../index.html", cta_url),
        '<nav class="tm-crumbs"><a href="../index.html">%s</a> &rsaquo; <a href="index.html">Locations</a> &rsaquo; %s</nav>' % (esc(SITE_NAME), esc(r["name"])),
        "<h1>%s</h1>" % esc(title),
        '<p class="tm-lead">%s</p>' % esc(lead_paragraph(r)),
        '<p><a class="tm-open" href="../index.html#%s">Open this location in the explorer</a></p>' % esc(loc_param),
        "<h2>Wave height by month</h2>",
        '<p class="tm-basis">Mean significant wave height and the percentage of time the significant wave height is above each level, by calendar month. The last row combines the months weighted by their length in days.</p>',
        table,
        "\n".join(lines),
        "<h2>Data basis</h2>",
        '<p class="tm-basis">%s</p>' % esc(basis_line(r, mf)),
        '<p class="tm-basis">%s</p>' % esc(mf.get("attribution") or ""),
        '<p class="tm-basis">How the numbers are made: <a href="../methodology.html">How it works</a>. Other locations: <a href="index.html">all location pages</a>.</p>',
        '<section class="tm-cta">\n%s\n</section>' % cta_tagged(cta_html, cta_url, "location_cta"),
        footer_html(mf),
    ])
    return page_shell(title, description, canonical, jsonld, body)


def index_page(results, mf, base_url, date, cta_html, cta_url):
    # wording that matches how people search (23 Oct 26): "historical",
    # "sea state data", "free"
    title = "Historical sea state by location"
    page_title = "Historical sea state by location: monthly wave statistics for %d offshore areas" % len(results)
    src = (mf.get("source_label") or mf.get("source") or "").replace(" + ", " and ")
    canonical = base_url + "locations/index.html"
    description = ("Free historical sea state data for %d named offshore working areas worldwide: wave height exceedance by month, from %s, %s. Each page states its data point."
                   % (len(results), src, mf.get("period")))
    regions = []
    for r in results:
        if r["region"] not in regions:
            regions.append(r["region"])
    groups = []
    for reg in regions:
        items = []
        for r in results:
            if r["region"] != reg:
                continue
            items.append('<li><a href="%s.html">%s</a><span class="tm-pct">%s above %g m over the year</span></li>'
                         % (esc(r["slug"]), esc(r["name"]), esc(fmt_pct(r["head"])), HEADLINE_HS))
        groups.append('<h2 class="tm-region">%s</h2>\n<ul class="tm-loclist">\n%s\n</ul>' % (esc(reg), "\n".join(items)))
    jsonld = [{
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": page_title,
        "description": description,
        "url": canonical,
        "isPartOf": {"@type": "WebSite", "name": SITE_NAME, "url": base_url},
        "creator": {"@type": "Organization", "name": COMPANY, "url": cta_url},
    }, {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": base_url},
            {"@type": "ListItem", "position": 2, "name": "Locations", "item": canonical},
        ],
    }]
    body = "\n".join([
        header_html("../index.html", cta_url, "locations_index_logo"),
        '<nav class="tm-crumbs"><a href="../index.html">%s</a> &rsaquo; Locations</nav>' % esc(SITE_NAME),
        "<h1>%s</h1>" % esc(title),
        '<p class="tm-lead">%d named offshore working areas, grouped by region. Each page gives the percentage of time significant wave height exceeds %s m by calendar month, the mean wave height, wind and weather windows where the data carries them, and the data point used. The figure beside each name is the share of the year with significant wave height above %g m.</p>'
        % (len(results), " to ".join(["%g" % TABLE_THRESHOLDS[0], "%g" % TABLE_THRESHOLDS[-1]]), HEADLINE_HS),
        '<p class="tm-basis">Data basis: %s, %s, %s° grid, nearest cell to each named position. For any other point use the <a href="../index.html">explorer</a>. How the numbers are made is on the <a href="../methodology.html">How it works</a> page.</p>'
        % (esc(src), esc(mf.get("period")), esc(mf["grid"]["res"])),
        "\n".join(groups),
        '<p class="tm-basis">Pages built %s.</p>' % esc(date),
        '<section class="tm-cta">\n%s\n</section>' % cta_tagged(cta_html, cta_url, "locations_index_cta"),
        footer_html(mf),
    ])
    return page_shell(page_title, description, canonical, jsonld, body)


def sitemap_xml(results, base_url, date):
    urls = [(base_url, None), (base_url + "methodology.html", None),
            (base_url + "locations/index.html", date)]
    for r in results:
        urls.append(("%slocations/%s.html" % (base_url, r["slug"]), date))
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<!-- %s -->" % GENERATED_NOTE,
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, lastmod in urls:
        lines.append("  <url>")
        lines.append("    <loc>%s</loc>" % esc(loc))
        if lastmod:
            lines.append("    <lastmod>%s</lastmod>" % lastmod)
        lines.append("  </url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def llms_txt(results, mf, base_url, date, cta_url):
    src = (mf.get("source_label") or mf.get("source") or "").replace(" + ", " and ")
    return "\n".join([
        "# %s" % SITE_NAME,
        "",
        "> Free web tool from %s giving long term wave, wind and weather window statistics for any offshore location, from %s, %s. Click a point at sea, pick months, read the percentage of time significant wave height exceeds each threshold." % (COMPANY, src, mf.get("period")),
        "",
        "<!-- %s -->" % GENERATED_NOTE,
        "",
        "## What it answers",
        "",
        "- How often significant wave height exceeds a given level at a location, by calendar month and across the year",
        "- Mean wave height by month, typical peak period and direction, wind speed (mean and top decile), extreme sea states, weather windows (separate working periods per month below a wave height limit), water depth, nearby oil and gas assets, tropical cyclone exposure",
        "- A one page PDF summary and a shareable link for every result",
        "",
        "## The data behind it",
        "",
        "- %s, %s, %s degree grid. Values are the nearest grid cell to the chosen point, never interpolated between cells; every result states the data point, the grid and its distance from the chosen point, and the PDF adds the sample count." % (src, mf.get("period"), mf["grid"]["res"]),
        "- Attribution: %s" % (mf.get("attribution") or ""),
        "- %s" % DISCLAIMER,
        "",
        "## Pages",
        "",
        "- [Locations index](%slocations/index.html): %d named offshore working areas, each with a monthly table, the headline numbers in words and the data basis" % (base_url, len(results)),
        "- [How it works](%smethodology.html): where the numbers come from, how to read them, and the data credits" % base_url,
        "- [Explorer](%s): any other point at sea; the URL fragment #loc=<lat>,<lon> reproduces a result" % base_url,
        "",
        "## Not for scraping",
        "",
        "- The tile files under /data/ are bulk inputs for the interactive map, excluded from crawling in robots.txt, and not for reuse. Automated bulk extraction is not permitted; the underlying open datasets are available from the original providers credited above.",
        "- Link to the location pages and the How it works page instead.",
        "",
        "## Contact",
        "",
        "- [%s](%s)" % (COMPANY, cta_url),
        "",
    ])


ROBOTS_BOTS = ["GPTBot", "ClaudeBot", "anthropic-ai", "PerplexityBot", "Google-Extended", "CCBot", "Applebot-Extended"]


def robots_txt(base_url):
    # the manifest stays open so a crawler rendering the explorer sees the
    # live data, not the demonstration mode it falls back to
    lines = ["# %s" % GENERATED_NOTE, "User-agent: *", "Allow: /", "Allow: /data/manifest.json", "Disallow: /data/", "Disallow: /hostdata/", "Disallow: /vendor/", ""]
    for bot in ROBOTS_BOTS:
        lines += ["User-agent: %s" % bot, "Allow: /", "Allow: /data/manifest.json", "Disallow: /data/", "Disallow: /hostdata/", "Disallow: /vendor/", ""]
    lines.append("Sitemap: %ssitemap.xml" % base_url)
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- self-check

VOID = set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
            "param", "source", "track", "wbr"])


class NestingCheck(HTMLParser):
    """html.parser never raises on its own; this tracks the tag stack so a
    stray or unclosed element is reported instead of shipped."""

    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        pass

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack or self.stack[-1] != tag:
            self.errors.append("unexpected </%s> at line %d (open: %s)" % (tag, self.getpos()[0], "/".join(self.stack[-3:])))
            if tag in self.stack:
                while self.stack and self.stack[-1] != tag:
                    self.stack.pop()
                self.stack.pop()
            return
        self.stack.pop()


def check_html(path):
    src = io.open(path, encoding="utf-8").read()
    p = NestingCheck()
    try:
        p.feed(src)
        p.close()
    except Exception as e:  # noqa: BLE001 - report, do not crash the build
        return ["parser exception: %s" % e]
    errs = list(p.errors)
    if p.stack:
        errs.append("unclosed: " + "/".join(p.stack))
    if "—" in src:
        errs.append("contains an em dash")
    body = src.replace("<!--", "").replace("-->", "")
    if " -- " in body:
        errs.append("contains a double dash")
    if GENERATED_NOTE not in src:
        errs.append("missing the generated-by comment")
    return errs


# ---------------------------------------------------------------- main

def write(path, text):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=DEFAULT_DATA, help="wave tile folder (manifest.json + t_*.json)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="site folder to write into (web/)")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL, help="absolute site URL for canonical links and the sitemap")
    ap.add_argument("--date", default=datetime.datetime.utcnow().strftime("%Y-%m-%d"),
                    help="build date stamped as the accessed date (default: today, UTC)")
    ap.add_argument("--sample", default="", help="comma separated slugs whose lead paragraph is printed")
    ap.add_argument("--dry-run", action="store_true", help="validate the locations, write nothing")
    ap.add_argument("--bundle", default="", help="seastate_location_data.json from web/harvest.html "
                    "(the cells the pages need, collected on the data host); used instead of --data "
                    "for the wave tiles, assets still come from --data")
    args = ap.parse_args()

    base_url = args.base_url if args.base_url.endswith("/") else args.base_url + "/"
    out_dir = os.path.abspath(args.out)
    data_dir = os.path.abspath(args.data)
    if os.path.abspath(os.path.join(out_dir, "data")) == data_dir:
        pass  # the usual layout; never written to
    print("data: %s\nout:  %s\nbase: %s\ndate: %s" % (data_dir, out_dir, base_url, args.date))

    if args.bundle:
        # unpack the harvested cells into a tile folder of the usual shape
        import tempfile
        b = json.load(io.open(args.bundle, encoding="utf-8"))
        tdir = tempfile.mkdtemp(prefix="seastate_bundle_")
        mf = dict(b["manifest"])
        mf["tiles"] = sorted(b["tiles"].keys())
        with io.open(os.path.join(tdir, "manifest.json"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps(mf))
        for tid, t in b["tiles"].items():
            with io.open(os.path.join(tdir, tid + ".json"), "w", encoding="utf-8") as fh:
                fh.write(json.dumps(t))
        print("bundle: %s, %d tiles, unpacked to %s" % (args.bundle, len(mf["tiles"]), tdir))
        store = TileStore(tdir)
    else:
        store = TileStore(data_dir)
    print("manifest: %s, %s, %s deg grid, snap %s km, %d tiles" % (
        store.mf.get("source_label"), store.mf.get("period"), store.mf["grid"]["res"], store.snap_km, len(store.mf["tiles"])))
    assets = load_assets(data_dir)
    print("assets: %s" % ("%d named non-well assets" % len(assets) if assets else "none (no nearest-asset lines)"))
    coast = load_coast(out_dir)
    print("coast check: %s" % ("on (%d rings)" % len(coast) if coast else "off (no coastline.js next to the site)"))
    cta_html, cta_url = read_cta(out_dir)

    slugs = [l[4] for l in LOCATIONS]
    dups = sorted(set(s for s in slugs if slugs.count(s) > 1))
    if dups:
        raise SystemExit("duplicate slugs: %s" % ", ".join(dups))
    for l in LOCATIONS:
        if not re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", l[4]):
            raise SystemExit("bad slug %r" % l[4])

    results, skipped = [], []
    for loc in LOCATIONS:
        name, lat, lon, region, slug = loc
        r, why = compute(loc, store, assets)
        if r is None:
            skipped.append((name, why))
            print("WARNING: skipped %s (%s): %s" % (name, region, why))
            continue
        flags = ""
        if coast:
            ck = coast_km(coast, lat, lon)
            if ck < COAST_MIN_KM:
                flags += "  WARNING: %.0f km from the coast (rule is %d km)" % (ck, COAST_MIN_KM)
        print("ok  %-32s cell %s  %3d km  n=%s  year>%gm %s%s" % (
            slug, fmt_latlon(r["cell"]["lat"], r["cell"]["lon"]), r["distanceKm"], format(r["nTotal"], ","),
            HEADLINE_HS, fmt_pct(r["head"]), flags))
        results.append(r)

    if args.dry_run:
        print("dry run: %d locations valid, %d skipped, nothing written" % (len(results), len(skipped)))
        return 0

    written = []
    loc_dir = os.path.join(out_dir, "locations")
    for r in results:
        path = os.path.join(loc_dir, r["slug"] + ".html")
        write(path, location_page(r, store.mf, base_url, args.date, cta_html, cta_url))
        written.append(path)
    path = os.path.join(loc_dir, "index.html")
    write(path, index_page(results, store.mf, base_url, args.date, cta_html, cta_url))
    written.append(path)
    write(os.path.join(out_dir, "sitemap.xml"), sitemap_xml(results, base_url, args.date))
    write(os.path.join(out_dir, "llms.txt"), llms_txt(results, store.mf, base_url, args.date, cta_url))
    write(os.path.join(out_dir, "robots.txt"), robots_txt(base_url))

    # stale pages from a location that was renamed or dropped
    keep = set(os.path.basename(p) for p in written)
    for fn in sorted(os.listdir(loc_dir)):
        if fn.endswith(".html") and fn not in keep:
            print("NOTE: %s is not in the current list and was left in place; delete it by hand if the location was dropped" % os.path.join(loc_dir, fn))

    bad = 0
    for p in written:
        errs = check_html(p)
        if errs:
            bad += 1
            print("HTML CHECK FAILED %s: %s" % (p, "; ".join(errs)))
    print("html check: %d pages parsed, %d with problems" % (len(written), bad))

    for slug in [s.strip() for s in args.sample.split(",") if s.strip()]:
        hit = [r for r in results if r["slug"] == slug]
        if not hit:
            print("sample %s: not built" % slug)
            continue
        print("\n[%s] %s\n%s" % (slug, hit[0]["name"], lead_paragraph(hit[0])))

    print("\nwrote %d location pages + locations/index.html, sitemap.xml, llms.txt, robots.txt under %s" % (len(results), out_dir))
    if skipped:
        print("SKIPPED %d location(s):" % len(skipped))
        for name, why in skipped:
            print("  - %s: %s" % (name, why))
    else:
        print("skipped: none")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
