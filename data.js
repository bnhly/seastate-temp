/* Sea State Explorer - data layer.
   Two providers behind one interface:
     DemoProvider  - parametric synthetic climatology, no data files, clearly labelled DEMO.
     TileProvider  - production path: reads data/manifest.json + tile files written by
                     tools/build_dataset_era5.py (ERA5 derived statistics).
   A provider exposes:
     ready        -> Promise resolving when usable (rejects if data missing)
     meta         -> {source, sourceLabel, period, attribution}
     thresholds   -> array of Hs thresholds (m)
     query(lat, lon) -> Promise of {cell:{lat,lon,res}, distanceKm, exc, mean, n}
                        exc[m][ti] = % of time Hs > threshold ti in calendar month m (0..11),
                        null where no data (e.g. seasonal ice). mean[m] metres or null.
                        n[m] = sample count.
     heatField(months) -> Promise of fn(lat, lon) -> mean Hs (m) or null, for map shading.
*/
(function () {
  "use strict";

  /* Decode delta-encoded polyline sets (flat int arrays [x0, y0, dx1, dy1,
     ...] with coords x100): the coastline (coastline.js, TM_COAST_ENC) and the
     country borders (borders.js, TM_BORDERS_ENC). Everything downstream (map
     drawing, land mask) reads the decoded window.TM_COAST / TM_BORDERS. */
  /* scale = ints per degree in the encoding; 100 for the embedded 50m
     coastline and borders, 1000 for the finer HD coastline (which stamps
     TM_COAST_HD_SCALE beside its data). */
  function decodeDeltaRings(enc, scale) {
    var sc = scale || 100;
    var decoded = [], ri, flatR, ptsR, xx, yy, kk;
    for (ri = 0; ri < enc.length; ri++) {
      flatR = enc[ri];
      ptsR = [];
      xx = 0; yy = 0;
      for (kk = 0; kk < flatR.length; kk += 2) {
        xx += flatR[kk]; yy += flatR[kk + 1];
        ptsR.push([xx / sc, yy / sc]);
      }
      decoded.push(ptsR);
    }
    return decoded;
  }
  if (window.TM_COAST_ENC && !window.TM_COAST) {
    window.TM_COAST = decodeDeltaRings(window.TM_COAST_ENC);
    window.TM_COAST_ENC = null;
  }
  if (window.TM_BORDERS_ENC && !window.TM_BORDERS) {
    window.TM_BORDERS = decodeDeltaRings(window.TM_BORDERS_ENC);
    window.TM_BORDERS_ENC = null;
  }

  var MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var THRESHOLDS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10];

  /* ---------- generic helpers ---------- */

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, d2r = Math.PI / 180;
    var dLat = (lat2 - lat1) * d2r, dLon = (lon2 - lon1) * d2r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function wrapLon(lon) {
    while (lon < -180) lon += 360;
    while (lon >= 180) lon -= 360;
    return lon;
  }

  function smoothstep(a, b, x) {
    var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function gammafn(x) {
    var C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammafn(1 - x));
    x -= 1;
    var a = C[0], t = x + 7.5, i;
    for (i = 1; i < 9; i++) a += C[i] / (x + i);
    return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
  }

  /* ---------- 1 deg land mask from the embedded coastline (scanline fill) ---------- */

  var MASK_RES = 1, MASK_NLON = 360, MASK_NLAT = 180;
  var landMask = null;

  function buildLandMask() {
    if (landMask) return landMask;
    var rings = window.TM_COAST || [];
    landMask = new Uint8Array(MASK_NLON * MASK_NLAT);
    var i, j, r, e, y, xs, ring, a, b, t, x, k, x1, x2, j1, j2;
    for (i = 0; i < MASK_NLAT; i++) {
      y = -89.5 + i;
      xs = [];
      for (r = 0; r < rings.length; r++) {
        ring = rings[r];
        for (e = 0; e < ring.length - 1; e++) {
          a = ring[e]; b = ring[e + 1];
          if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
            t = (y - a[1]) / (b[1] - a[1]);
            xs.push(a[0] + t * (b[0] - a[0]));
          }
        }
      }
      xs.sort(function (p, q) { return p - q; });
      for (k = 0; k + 1 < xs.length; k += 2) {
        x1 = xs[k]; x2 = xs[k + 1];
        j1 = Math.ceil(x1 + 179.5 + 1e-9);
        j2 = Math.floor(x2 + 179.5 - 1e-9);
        for (j = Math.max(0, j1); j <= Math.min(MASK_NLON - 1, j2); j++) {
          landMask[i * MASK_NLON + j] = 1;
        }
      }
    }
    return landMask;
  }

  function maskCell(lat, lon) {
    var i = Math.max(0, Math.min(MASK_NLAT - 1, Math.round(lat + 89.5)));
    var j = Math.max(0, Math.min(MASK_NLON - 1, Math.round(wrapLon(lon) + 179.5)));
    return { i: i, j: j, lat: i - 89.5, lon: j - 179.5 };
  }

  function isLand(lat, lon) {
    var m = buildLandMask(), c = maskCell(lat, lon);
    return m[c.i * MASK_NLON + c.j] === 1;
  }

  /* Nearest ocean 1-deg cell centre to a clicked point (spiral search). */
  function nearestOceanCell(lat, lon) {
    var m = buildLandMask(), c = maskCell(lat, lon);
    if (m[c.i * MASK_NLON + c.j] === 0) return { lat: c.lat, lon: c.lon, km: haversineKm(lat, lon, c.lat, c.lon) };
    var r, di, dj, i2, j2, best = null, km, foundAt = -1;
    for (r = 1; r <= 40; r++) {
      for (di = -r; di <= r; di++) {
        for (dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          i2 = c.i + di;
          if (i2 < 0 || i2 >= MASK_NLAT) continue;
          j2 = ((c.j + dj) % MASK_NLON + MASK_NLON) % MASK_NLON;
          if (m[i2 * MASK_NLON + j2] === 1) continue;
          km = haversineKm(lat, lon, i2 - 89.5, j2 - 179.5);
          if (!best || km < best.km) best = { lat: i2 - 89.5, lon: j2 - 179.5, km: km };
        }
      }
      if (best && foundAt < 0) foundAt = r;
      if (foundAt > 0 && r >= foundAt + 1) break; /* one extra ring, square ring vs true distance */
    }
    return best;
  }

  /* ---------- synthetic demo climatology (parametric, plausible, NOT real data) ---------- */

  var DEMO_BASINS = [
    /* latMin, latMax, lonMin, lonMax, factor */
    [23, 30.5, 46.5, 57, 0.38],    /* Persian Gulf */
    [12, 30, 32, 44, 0.5],         /* Red Sea */
    [40, 47.5, 26.5, 42, 0.5],     /* Black Sea */
    [53, 66, 9, 31, 0.42],         /* Baltic */
    [30, 46, -6, 36.5, 0.55],      /* Mediterranean */
    [50, 61, -4, 9, 0.85],         /* North Sea */
    [54, 66, -100, -75, 0.5],      /* Hudson Bay */
    [17.5, 31, -98, -80.5, 0.72],  /* Gulf of Mexico */
    [8, 22, -89, -59, 0.8],        /* Caribbean */
    [33, 52, 127, 142.5, 0.7],     /* Sea of Japan */
    [23, 41, 117, 127, 0.68],      /* Yellow / East China Sea */
    [-11, 9, 94, 131, 0.6]         /* SE Asian seas */
  ];

  function demoMeanHs(lat, lon, m) {
    var alat = Math.abs(lat), base, phase, wN, wS, seas, mons, k, b, mean;
    if (lat <= 0) {
      base = 1.6 + 1.5 * smoothstep(18, 42, alat) + 1.3 * smoothstep(42, 58, alat);
    } else {
      base = 1.6 + 0.9 * smoothstep(18, 42, alat) + 0.5 * smoothstep(42, 60, alat);
    }
    base *= 1 - 0.45 * smoothstep(66, 78, alat);          /* ice edge taper */
    phase = Math.cos(2 * Math.PI * (m - 0.25) / 12);      /* +1 mid January */
    wN = smoothstep(12, 32, lat);
    wS = smoothstep(12, 32, -lat);
    seas = wN * 0.38 * base * phase - wS * 0.20 * base * phase;
    mean = base + seas;
    mons = Math.exp(-Math.pow((m - 6) / 1.6, 2));         /* peak July */
    if (lat > 4 && lat < 23 && lon > 52 && lon < 75) mean += 1.3 * mons;   /* Arabian Sea SW monsoon */
    if (lat > 4 && lat < 21 && lon > 79 && lon < 95) mean += 0.8 * mons;   /* Bay of Bengal */
    if (lat > 4 && lat < 23 && lon > 104 && lon < 121) mean += 0.55 * Math.max(0, phase); /* SCS NE monsoon */
    for (k = 0; k < DEMO_BASINS.length; k++) {
      b = DEMO_BASINS[k];
      if (lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]) {
        /* feather the factor toward the box edge (2.5 deg) so the smooth
           shading does not show the box as a hard rectangle at sea */
        var edge = Math.min(lat - b[0], b[1] - lat, lon - b[2], b[3] - lon);
        var fth = smoothstep(0, 2.5, edge);
        mean *= 1 + (b[4] - 1) * fth;
        break;
      }
    }
    mean *= 0.88 + 0.12 * smoothstep(2, 9, alat);         /* doldrums dip */
    return Math.max(0.35, Math.min(7, mean));
  }

  function demoShape(lat) {
    var k = 2.25 - 0.55 * smoothstep(22, 45, Math.abs(lat));
    return Math.max(1.55, Math.min(2.35, k));
  }

  function demoCell(latc, lonc) {
    var exc = [], mean = [], n = [], m, ti, mn, k, lam, p, row;
    k = demoShape(latc);
    for (m = 0; m < 12; m++) {
      mn = demoMeanHs(latc, lonc, m);
      lam = mn / gammafn(1 + 1 / k);
      row = [];
      for (ti = 0; ti < THRESHOLDS.length; ti++) {
        p = 100 * Math.exp(-Math.pow(THRESHOLDS[ti] / lam, k));
        row.push(Math.round(p * 10) / 10);
      }
      exc.push(row);
      mean.push(Math.round(mn * 100) / 100);
      n.push(Math.round(46 * 8 * MONTH_DAYS[m]));
    }
    return { exc: exc, mean: mean, n: n };
  }

  /* Weather-window duration classes shared with the pipeline
     (tools/build_dataset_era5.py P_THR / P_EDGES_H). */
  var WIN_THR = [1.0, 1.5, 2.0, 2.5, 3.0];
  var WIN_EDGES = [6, 12, 24, 48, 72, 120];

  /* Synthetic extremes / wind / weather windows for one demo cell, derived
     from the same Weibull parameters as the exceedance table so the numbers
     hang together. */
  function demoHolistic(latc, lonc, d) {
    var k = demoShape(latc), m, lam, i, t, f, L, R, hrs, bins, b, lo, hi;
    var ext = { p99: [], p999: [], p99All: null, p999All: null };
    var wind = { mean: [], p90: [] };
    var runs = [];
    var lams = [];
    for (m = 0; m < 12; m++) {
      lam = d.mean[m] / gammafn(1 + 1 / k);
      lams.push(lam);
      ext.p99.push(Math.round(lam * Math.pow(Math.log(100), 1 / k) * 10) / 10);
      ext.p999.push(Math.round(lam * Math.pow(Math.log(1000), 1 / k) * 10) / 10);
      var wmn = 3.2 + 2.1 * d.mean[m];
      wind.mean.push(Math.round(wmn * 10) / 10);
      wind.p90.push(Math.round(wmn * 1.45 * 10) / 10);
      var row = [];
      for (t = 0; t < WIN_THR.length; t++) {
        f = 1 - Math.exp(-Math.pow(WIN_THR[t] / lam, k));   /* fraction of time calm */
        L = Math.min(240, 12 + 150 * f * f * f);            /* mean calm-spell length, h */
        hrs = f * 24 * MONTH_DAYS[m];                        /* calm hours in the month */
        R = hrs / L;                                         /* completed spells per year in this month */
        bins = [];
        for (b = 0; b < WIN_EDGES.length + 1; b++) {
          lo = b === 0 ? 0 : WIN_EDGES[b - 1];
          hi = b < WIN_EDGES.length ? WIN_EDGES[b] : Infinity;
          bins.push(Math.round(R * (Math.exp(-lo / L) - (hi === Infinity ? 0 : Math.exp(-hi / L))) * 10) / 10);
        }
        row.push(bins);
      }
      runs.push(row);
    }
    /* pooled annual percentiles by bisection on the month mixture */
    function pooled(q) {
      var loH = 0, hiH = 30, mid, e, j, it;
      for (it = 0; it < 50; it++) {
        mid = (loH + hiH) / 2;
        e = 0;
        for (j = 0; j < 12; j++) e += MONTH_DAYS[j] / 365.25 * Math.exp(-Math.pow(mid / lams[j], k));
        if (e > q) loH = mid; else hiH = mid;
      }
      return Math.round(mid * 10) / 10;
    }
    ext.p99All = pooled(0.01);
    ext.p999All = pooled(0.001);
    return { ext: ext, wind: wind, windows: { thr: WIN_THR, edges: WIN_EDGES, runs: runs } };
  }

  /* Synthetic currents + tidal stream for demo mode. Shelf proxy: any land
     within the surrounding 3 deg of the 1 deg mask. */
  function demoCurrents(latc, lonc) {
    var shelf = false, di, dj;
    for (di = -3; di <= 3 && !shelf; di++) {
      for (dj = -3; dj <= 3; dj++) {
        if (isLand(latc + di, lonc + dj)) { shelf = true; break; }
      }
    }
    var wob = 0.5 + 0.5 * Math.sin(latc * 0.6 + lonc * 0.35);
    var ts = (shelf ? 0.55 + 0.55 * wob : 0.18 + 0.18 * wob);
    var diurnalBand = (lonc > 95 && lonc < 130 && latc > -12 && latc < 25) ||
      (lonc > -100 && lonc < -81 && latc > 17 && latc < 31);
    var tf = diurnalBand ? 1.9 : 0.25 + 0.5 * wob;
    var slack50 = null, slack25 = null;
    if (shelf) { slack25 = Math.round(18 + 20 * wob); slack50 = Math.round(38 + 30 * wob); }
    else { slack25 = 0; slack50 = 0; }   /* rotary stream: never truly still */
    if (ts <= 0.5) slack50 = null;        /* stream never reaches 0.5 m/s */
    if (ts <= 0.25) slack25 = null;
    var s5 = [], s9 = [], b5 = [], b9 = [], m5, seas;
    for (m5 = 0; m5 < 12; m5++) {
      seas = 1 + 0.18 * Math.cos(2 * Math.PI * (m5 - 0.5) / 12) * (latc >= 0 ? 1 : -1);
      s5.push(Math.round((0.12 + 0.16 * wob) * seas * 100) / 100);
      s9.push(Math.round((0.30 + 0.30 * wob) * seas * 100) / 100);
      b5.push(Math.round((0.05 + 0.07 * wob) * seas * 100) / 100);
      b9.push(Math.round((0.12 + 0.14 * wob) * seas * 100) / 100);
    }
    return {
      cell: { lat: latc, lon: lonc }, km: 0,
      bg: { surfP50: s5, surfP90: s9, botP50: b5, botP90: b9, botDepth: shelf ? 80 : 640 },
      tide: {
        spring: Math.round(ts * 100) / 100, neap: Math.round(ts * 55) / 100, form: tf,
        bearing: ((Math.round((latc + lonc) * 7) % 180) + 180) % 180,
        slack25: slack25, slack50: slack50,
        perDay: tf > 1.5 ? 1.9 : 3.9
      }
    };
  }

  function DemoProvider() {
    this.meta = {
      source: "DEMO",
      sourceLabel: "Demonstration data (synthetic)",
      period: "for layout evaluation only",
      attribution: "Demonstration mode: values are generated from a simplified parametric wave " +
        "climate model and are NOT real measurements or reanalysis. The production version is " +
        "built from the ERA5 reanalysis (see seastate/README.md)."
    };
    this.thresholds = THRESHOLDS;
    this.ready = Promise.resolve(this);
  }

  /* Plausible demo direction: westerlies poleward of ~30, trades toward the
     equator (sector = 30 deg bin of the FROM direction). */
  function demoDirSector(lat) {
    if (lat > 38) return 9;   /* from W */
    if (lat > 27) return 8;   /* from WSW */
    if (lat > 6) return 2;    /* NE trades: from ENE */
    if (lat > -6) return 3;   /* from E */
    if (lat > -27) return 4;  /* SE trades: from ESE */
    return 9;                 /* southern westerlies */
  }

  DemoProvider.prototype.query = function (lat, lon) {
    var cell = nearestOceanCell(lat, lon);
    if (!cell) return Promise.reject(new Error("No sea within range of that point."));
    var d = demoCell(cell.lat, cell.lon);
    var tpArr = [], dsArr = [], dpArr = [], roseArr = [], m2, s2, dist, wsum2, row2;
    var SPREAD = [1.0, 0.55, 0.28, 0.12, 0.05, 0.02, 0.01];   /* weight by sector distance */
    for (m2 = 0; m2 < 12; m2++) {
      tpArr.push(Math.round((2.6 + 3.4 * Math.sqrt(d.mean[m2])) * 10) / 10);
      var modal = demoDirSector(cell.lat);
      dsArr.push(modal);
      row2 = []; wsum2 = 0;
      for (s2 = 0; s2 < 12; s2++) {
        dist = Math.abs(s2 - modal);
        if (dist > 6) dist = 12 - dist;
        row2.push(SPREAD[dist]);
        wsum2 += SPREAD[dist];
      }
      for (s2 = 0; s2 < 12; s2++) row2[s2] = Math.round(100 * row2[s2] / wsum2);
      roseArr.push(row2);
      dpArr.push(row2[modal]);
    }
    var hol = demoHolistic(cell.lat, cell.lon, d);
    var wRose = [], mw, sw, wrow, wsum3;
    var WSPREAD = [1.0, 0.5, 0.2, 0.06, 0.02, 0.01, 0.005];
    for (mw = 0; mw < 12; mw++) {
      var wmodal = (demoDirSector(cell.lat) + 1) % 12;
      wrow = [];
      wsum3 = 0;
      for (sw = 0; sw < 12; sw++) {
        var wdist = Math.abs(sw - wmodal);
        if (wdist > 6) wdist = 12 - wdist;
        wrow.push(WSPREAD[wdist]);
        wsum3 += WSPREAD[wdist];
      }
      for (sw = 0; sw < 12; sw++) wrow[sw] = Math.round(100 * wrow[sw] / wsum3);
      wRose.push(wrow);
    }
    /* demo ENSO split: La Nina rougher, El Nino calmer everywhere (the real
       signal is regional and comes from the data; this is layout evaluation
       only). Sample counts mimic 12 / 19 / 14 seasons of 3 h records. */
    var dEnso = { n: [], mean: [], exc: [] };
    var ePmul = [0.85, 1.0, 1.2], eMmul = [0.93, 1.0, 1.08], eYrs = [12, 19, 14];
    var em, ep, ex, eN, eM, eE, eR, eV;
    for (em = 0; em < 12; em++) {
      eN = []; eM = []; eE = [];
      for (ep = 0; ep < 3; ep++) {
        eN.push(eYrs[ep] * 8 * 30);
        eM.push(d.mean[em] === null ? null : Math.round(d.mean[em] * eMmul[ep] * 100) / 100);
        eR = [];
        for (ex = 0; ex < d.exc[em].length; ex++) {
          eV = d.exc[em][ex];
          eR.push(eV === null ? null : Math.min(100, Math.round(eV * ePmul[ep] * 10) / 10));
        }
        eE.push(eR);
      }
      dEnso.n.push(eN);
      dEnso.mean.push(eM);
      dEnso.exc.push(eE);
    }
    /* demo peak-period distribution: bimodal on purpose (wind sea plus a
       long swell hump) so the histogram design is judged against the shape
       a real open-coast site produces */
    var dTp = [], tb, tc1, tw, tv2, tsum;
    var swellW = Math.abs(cell.lat) < 45 ? 0.35 : 0.15;
    for (em = 0; em < 12; em++) {
      tc1 = 4.5 + (d.mean[em] === null ? 1.5 : Math.min(d.mean[em], 4));
      tw = [];
      tsum = 0;
      for (tb = 0; tb < 14; tb++) {
        tv2 = (1 - swellW) * Math.exp(-Math.pow(tb + 2.5 - tc1, 2) / (2 * 1.4 * 1.4)) +
          swellW * Math.exp(-Math.pow(tb + 2.5 - 12.5, 2) / (2 * 1.6 * 1.6));
        tw.push(tv2);
        tsum += tv2;
      }
      for (tb = 0; tb < 14; tb++) tw[tb] = Math.round(1000 * tw[tb] / tsum) / 10;
      dTp.push(tw);
    }
    return Promise.resolve({
      cell: { lat: cell.lat, lon: cell.lon, res: MASK_RES },
      distanceKm: Math.round(cell.km),
      exc: d.exc, mean: d.mean, n: d.n,
      tp: tpArr, dirSect: dsArr, dirPct: dpArr, dirRose: roseArr,
      ext: hol.ext, wind: hol.wind, windows: hol.windows,
      cur: demoCurrents(cell.lat, cell.lon),
      cyc: demoCyclones(cell.lat, cell.lon),
      diurnal: demoDiurnal(cell.lat, cell.lon, d.mean),
      windRose: wRose,
      enso: dEnso,
      tpHist: dTp,
      tpHistMeta: { t0: 2, step: 1, nb: 14 }
    });
  };

  DemoProvider.prototype.heatField = function (months) {
    /* Continuous everywhere (including over land): the map paints land on
       top, and masking here at the 1 deg land mask left blocky pale notches
       along coasts. Only the polar cap returns null. */
    var wsum = 0, i;
    for (i = 0; i < months.length; i++) wsum += MONTH_DAYS[months[i]];
    return Promise.resolve(function (lat, lon) {
      if (Math.abs(lat) > 84) return null;
      var s = 0, k;
      for (k = 0; k < months.length; k++) s += MONTH_DAYS[months[k]] * demoMeanHs(lat, wrapLon(lon), months[k]);
      return wsum > 0 ? s / wsum : null;
    });
  };

  /* ---------- production tile provider ---------- */

  function TileProvider(base) {
    var self = this;
    this.base = base;
    this.manifest = null;
    this.tiles = {};
    this.meanhs = null;
    this.thresholds = THRESHOLDS;
    this.meta = null;
    this.ready = fetch(base + "manifest.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("manifest " + r.status);
        return r.json();
      })
      .then(function (mf) {
        if (mf.format !== 1) throw new Error("unsupported manifest format");
        self.manifest = mf;
        self.thresholds = mf.thresholds;
        self.meta = {
          source: mf.source,
          sourceLabel: mf.source_label || mf.source,
          period: mf.period,
          attribution: mf.attribution
        };
        return self;
      });
  }

  TileProvider.prototype.tileIdFor = function (latc, lonc) {
    var t = this.manifest.tile_deg;
    var tlat = Math.floor((latc + 90) / t) * t - 90;
    var tlon = Math.floor((wrapLon(lonc) + 180) / t) * t - 180;
    return "t_" + tlat + "_" + tlon;
  };

  TileProvider.prototype.loadTile = function (id) {
    var self = this;
    if (this.tiles[id]) return this.tiles[id];
    if (this.manifest.tiles.indexOf(id) < 0) {
      this.tiles[id] = Promise.resolve(null);
      return this.tiles[id];
    }
    this.tiles[id] = fetch(this.base + id + ".json")
      .then(function (r) { if (!r.ok) throw new Error("tile " + id + " " + r.status); return r.json(); })
      .catch(function () { return null; });
    return this.tiles[id];
  };

  TileProvider.prototype.query = function (lat, lon) {
    var self = this, mf = this.manifest, t = mf.tile_deg;
    lon = wrapLon(lon);
    /* tiles overlapping a search box around the click */
    var ids = {}, dlat, dlon, la, lo;
    for (dlat = -1; dlat <= 1; dlat++) {
      for (dlon = -1; dlon <= 1; dlon++) {
        la = Math.max(-89.9, Math.min(89.9, lat + dlat * t * 0.6));
        lo = lon + dlon * t * 0.6;
        ids[this.tileIdFor(la, lo)] = 1;
      }
    }
    var list = Object.keys(ids);
    return Promise.all(list.map(function (id) { return self.loadTile(id); })).then(function (tilesArr) {
      var best = null, ti, tile, c, km, res = mf.grid.res;
      for (ti = 0; ti < tilesArr.length; ti++) {
        tile = tilesArr[ti];
        if (!tile) continue;
        for (c = 0; c < tile.lat.length; c++) {
          km = haversineKm(lat, lon, tile.lat[c], tile.lon[c]);
          if (!best || km < best.km) best = { tile: tile, idx: c, km: km };
        }
      }
      if (!best || best.km > (mf.max_snap_km || 350)) {
        throw new Error("No data cell within range of that point.");
      }
      var T = mf.thresholds.length, exc = [], mean = [], n = [], m, k, row, v;
      var tpT = best.tile.tp ? best.tile.tp[best.idx] : null;
      var wdT = best.tile.wd ? best.tile.wd[best.idx] : null;
      var wpT = best.tile.wp ? best.tile.wp[best.idx] : null;
      var wrT = best.tile.wr ? best.tile.wr[best.idx] : null;
      var tpArr = tpT ? [] : null, dsArr = wdT ? [] : null, dpArr = wpT ? [] : null;
      var roseArr = wrT ? [] : null, s3, roseRow;
      /* optional holistic fields (older tile sets lack them) */
      var hxT = best.tile.hx ? best.tile.hx[best.idx] : null;
      var hxaT = best.tile.hxa ? best.tile.hxa[best.idx] : null;
      var wmT = best.tile.wm ? best.tile.wm[best.idx] : null;
      var w9T = best.tile.w9 ? best.tile.w9[best.idx] : null;
      var pwT = best.tile.pw ? best.tile.pw[best.idx] : null;
      var pMeta = mf.persist || { thresholds: [1.0, 1.5, 2.0, 2.5, 3.0], edges_h: [6, 12, 24, 48, 72, 120] };
      var PT = pMeta.thresholds.length, PB = pMeta.edges_h.length + 1;
      var ext = hxT ? { p99: [], p999: [], p99All: null, p999All: null } : null;
      if (ext && hxaT) {
        ext.p99All = hxaT[0] < 0 ? null : hxaT[0] / 10;
        ext.p999All = hxaT[1] < 0 ? null : hxaT[1] / 10;
      }
      var wind = (wmT || w9T) ? { mean: [], p90: [] } : null;
      var winRuns = pwT ? [] : null, t4, b4, binRow, thrRow;
      /* wind rose (spans built from 20 Aug 26 on; grafted on WAVERYS) */
      var vrT = best.tile.vr ? best.tile.vr[best.idx] : null;
      var windRoseArr = (vrT && vrT.length === 144) ? [] : null;
      /* peak-period distribution (tile sets built from 30 Aug 26 on):
         permille per 1 s bin, month-major */
      var thMeta = mf.tp_hist || null;
      var thT = best.tile.th ? best.tile.th[best.idx] : null;
      var tpHist = (thT && thMeta && thT.length === 12 * thMeta.nb) ? [] : null;
      var b6, thRow;
      /* ENSO phase split (spans built from 23 Aug 26 on; grafted on WAVERYS):
         per month x phase (el nino / neutral / la nina): samples, mean Hs,
         exceedance at the manifest thresholds */
      var pnT = best.tile.pn ? best.tile.pn[best.idx] : null;
      var pmT = best.tile.pm ? best.tile.pm[best.idx] : null;
      var peT = best.tile.pe ? best.tile.pe[best.idx] : null;
      var enso = (pnT && pnT.length === 36 && peT && peT.length === 36 * T)
        ? { n: [], mean: [], exc: [] } : null;
      var p5, x5, eRow, pRowN, pRowM, pRowE;
      /* diurnal cycle (local solar 3 h slots), spans built from 20 Aug 26 on */
      var dhT = best.tile.dh ? best.tile.dh[best.idx] : null;
      var dwT = best.tile.dw ? best.tile.dw[best.idx] : null;
      var diur = null, s4, dRow;
      if ((dhT && dhT.length === 96) || (dwT && dwT.length === 96)) {
        diur = { hs: (dhT && dhT.length === 96) ? [] : null,
                 wind: (dwT && dwT.length === 96) ? [] : null };
      }
      for (m = 0; m < 12; m++) {
        row = [];
        for (k = 0; k < T; k++) {
          v = best.tile.exc[best.idx][m * T + k];
          row.push(v < 0 ? null : v / 10);      /* permille -> % */
        }
        exc.push(row);
        v = best.tile.mean[best.idx][m];
        mean.push(v < 0 ? null : v / 10);        /* decimetres -> m */
        n.push(best.tile.n[best.idx][m]);
        if (tpArr) tpArr.push(tpT[m] < 0 ? null : tpT[m] / 10);   /* deciseconds -> s */
        if (dsArr) dsArr.push(wdT[m] < 0 ? null : wdT[m]);
        if (dpArr) dpArr.push(wpT[m] < 0 ? null : wpT[m]);
        if (roseArr) {
          if (wrT[m * 12] < 0) {
            roseArr.push(null);
          } else {
            roseRow = [];
            for (s3 = 0; s3 < 12; s3++) roseRow.push(wrT[m * 12 + s3]);
            roseArr.push(roseRow);
          }
        }
        if (ext) {
          ext.p99.push(hxT[m * 2] < 0 ? null : hxT[m * 2] / 10);
          ext.p999.push(hxT[m * 2 + 1] < 0 ? null : hxT[m * 2 + 1] / 10);
        }
        if (wind) {
          wind.mean.push(wmT && wmT[m] >= 0 ? wmT[m] / 10 : null);
          wind.p90.push(w9T && w9T[m] >= 0 ? w9T[m] / 10 : null);
        }
        if (windRoseArr) {
          if (vrT[m * 12] < 0) {
            windRoseArr.push(null);
          } else {
            roseRow = [];
            for (s3 = 0; s3 < 12; s3++) roseRow.push(vrT[m * 12 + s3]);
            windRoseArr.push(roseRow);
          }
        }
        if (tpHist) {
          if (thT[m * thMeta.nb] < 0) {
            tpHist.push(null);
          } else {
            thRow = [];
            for (b6 = 0; b6 < thMeta.nb; b6++) thRow.push(thT[m * thMeta.nb + b6] / 10);
            tpHist.push(thRow);
          }
        }
        if (enso) {
          pRowN = []; pRowM = []; pRowE = [];
          for (p5 = 0; p5 < 3; p5++) {
            pRowN.push(pnT[m * 3 + p5]);
            v = pmT[m * 3 + p5];
            pRowM.push(v < 0 ? null : v / 10);
            eRow = [];
            for (x5 = 0; x5 < T; x5++) {
              v = peT[(m * 3 + p5) * T + x5];
              eRow.push(v < 0 ? null : v / 10);
            }
            pRowE.push(eRow);
          }
          enso.n.push(pRowN);
          enso.mean.push(pRowM);
          enso.exc.push(pRowE);
        }
        if (diur && diur.hs) {
          dRow = [];
          for (s4 = 0; s4 < 8; s4++) {
            v = dhT[m * 8 + s4];
            dRow.push(v < 0 ? null : v / 10);
          }
          diur.hs.push(dRow);
        }
        if (diur && diur.wind) {
          dRow = [];
          for (s4 = 0; s4 < 8; s4++) {
            v = dwT[m * 8 + s4];
            dRow.push(v < 0 ? null : v / 10);
          }
          diur.wind.push(dRow);
        }
        if (winRuns) {
          if (pwT[m * PT * PB] < 0) {
            winRuns.push(null);
          } else {
            thrRow = [];
            for (t4 = 0; t4 < PT; t4++) {
              binRow = [];
              for (b4 = 0; b4 < PB; b4++) binRow.push(pwT[m * PT * PB + t4 * PB + b4] / 10);
              thrRow.push(binRow);
            }
            winRuns.push(thrRow);
          }
        }
      }
      return {
        cell: { lat: best.tile.lat[best.idx], lon: best.tile.lon[best.idx], res: res },
        distanceKm: Math.round(best.km),
        exc: exc, mean: mean, n: n,
        tp: tpArr, dirSect: dsArr, dirPct: dpArr, dirRose: roseArr,
        ext: ext, wind: wind,
        windows: winRuns ? { thr: pMeta.thresholds, edges: pMeta.edges_h, runs: winRuns } : null,
        diurnal: diur,
        windRose: windRoseArr,
        enso: enso,
        tpHist: tpHist,
        tpHistMeta: tpHist ? { t0: thMeta.t0, step: thMeta.step, nb: thMeta.nb } : null
      };
    });
  };

  TileProvider.prototype.heatField = function (months) {
    var self = this;
    var load = this.meanhs ? Promise.resolve(this.meanhs)
      : fetch(this.base + "meanhs.json").then(function (r) {
          if (!r.ok) throw new Error("meanhs " + r.status);
          return r.json();
        }).then(function (j) { self.meanhs = j; return j; });
    return load.then(function (g) {
      var wsum = 0, i;
      for (i = 0; i < months.length; i++) wsum += MONTH_DAYS[months[i]];
      return function (lat, lon) {
        var row = Math.round((lat - g.lat0) / g.res);
        var col = Math.round((wrapLon(lon) - g.lon0) / g.res);
        if (row < 0 || row >= g.nlat || col < 0 || col >= g.nlon) return null;
        var s = 0, used = 0, k, v;
        for (k = 0; k < months.length; k++) {
          v = g.mean[months[k]][row * g.nlon + col];
          if (v < 0) continue;
          s += MONTH_DAYS[months[k]] * v / 10;
          used += MONTH_DAYS[months[k]];
        }
        return used > 0 ? s / used : null;
      };
    }).catch(function () {
      /* no meanhs raster shipped: no shading rather than a broken map */
      return function () { return null; };
    });
  };

  /* ---------- bathymetry: decode + depth band lookup ----------
     web/bathy.js (lazy loaded) defines TM_BATHY_ENC: levels shallow to deep,
     rings delta-encoded as flat int arrays [x0, y0, dx1, dy1, ...] x100.
     Each level's rings enclose sea DEEPER than level.d metres. */

  var bathyCache = null;

  function bathyLevels() {
    if (bathyCache) return bathyCache;
    var enc = window.TM_BATHY_ENC;
    if (!enc) return null;
    bathyCache = enc.map(function (lv) {
      var rings = [], bboxes = [];
      var r, flat, pts, x, y, i, minx, maxx, miny, maxy;
      for (r = 0; r < lv.rings.length; r++) {
        flat = lv.rings[r];
        pts = [];
        x = 0; y = 0;
        minx = miny = Infinity; maxx = maxy = -Infinity;
        for (i = 0; i < flat.length; i += 2) {
          x += flat[i]; y += flat[i + 1];
          var px = x / 100, py = y / 100;
          pts.push([px, py]);
          if (px < minx) minx = px;
          if (px > maxx) maxx = px;
          if (py < miny) miny = py;
          if (py > maxy) maxy = py;
        }
        rings.push(pts);
        bboxes.push([minx, miny, maxx, maxy]);
      }
      return { d: lv.d, rings: rings, bboxes: bboxes };
    });
    return bathyCache;
  }

  function pipLevel(level, lat, lon) {
    var inside = false, r, ring, bb, i, a, b, x;
    for (r = 0; r < level.rings.length; r++) {
      bb = level.bboxes[r];
      /* ray runs toward +x: skip rings the ray cannot cross (lat outside the
         ring's band, or the whole ring left of the point) */
      if (lat < bb[1] || lat > bb[3] || lon > bb[2]) continue;
      ring = level.rings[r];
      for (i = 0; i < ring.length - 1; i++) {
        a = ring[i]; b = ring[i + 1];
        if ((a[1] <= lat && b[1] > lat) || (b[1] <= lat && a[1] > lat)) {
          x = a[0] + (lat - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
          if (x > lon) inside = !inside;
        }
      }
    }
    return inside;
  }

  function fmtMetres(d) {
    return d.toLocaleString() + " m";
  }

  /* Depth band at a point from the loaded contours. null until bathy.js loads. */
  function depthBandAt(lat, lon) {
    var lv = bathyLevels();
    if (!lv) return null;
    lon = wrapLon(lon);
    var i;
    for (i = lv.length - 1; i >= 0; i--) {
      if (pipLevel(lv[i], lat, lon)) {
        if (i === lv.length - 1) return { label: "deeper than " + fmtMetres(lv[i].d) };
        return { label: fmtMetres(lv[i].d) + " to " + fmtMetres(lv[i + 1].d) };
      }
    }
    return { label: "under " + fmtMetres(lv[0].d) };
  }

  /* ---------- exact depth tiles (web/data/depth/, written by grab_depth.py) ---------- */

  var depthStore = { manifestP: undefined, tiles: {} };

  function depthManifest(base) {
    if (!base) return Promise.resolve(null);
    if (depthStore.manifestP === undefined) {
      depthStore.manifestP = fetch(base + "depth/manifest.json").then(function (r) {
        if (!r.ok) throw new Error("no depth manifest");
        return r.json();
      }).then(function (mf) {
        return (mf && mf.format === 1) ? mf : null;
      }).catch(function () { return null; });
    }
    return depthStore.manifestP;
  }

  /* Exact water depth (m) at a point, or null (no data / on land). */
  function depthExactAt(base, lat, lon) {
    return depthManifest(base).then(function (mf) {
      if (!mf) return null;
      var t = mf.tile_deg;
      var lonW = wrapLon(lon);
      var latSW = Math.floor(lat / t) * t;
      var lonSW = Math.floor(lonW / t) * t;
      var tid = "d_" + latSW + "_" + lonSW;
      if (mf.tiles.indexOf(tid) < 0) return null;
      if (!depthStore.tiles[tid]) {
        depthStore.tiles[tid] = fetch(base + "depth/" + tid + ".json").then(function (r) {
          if (!r.ok) throw new Error("depth tile " + tid);
          return r.json();
        }).catch(function () { return null; });
      }
      return depthStore.tiles[tid].then(function (tile) {
        if (!tile) return null;
        var r2 = Math.min(tile.nlat - 1, Math.max(0, Math.floor((lat - tile.lat0) / tile.res)));
        var c2 = Math.min(tile.nlon - 1, Math.max(0, Math.floor((lonW - tile.lon0) / tile.res)));
        var v = tile.elev[r2 * tile.nlon + c2];
        return v < 0 ? { m: -v, sourceLabel: mf.source_label, attribution: mf.attribution } : null;
      });
    });
  }

  /* ---------- currents + tidal stream tiles (web/data/cur/, written by
     tools/build_currents_cmems.py). Optional dataset: everything returns null
     until it is deployed. All speeds SI (m/s) on this side of the reader. */

  var curStore = { manifestP: undefined, tiles: {} };

  function curManifest(base) {
    if (!base) return Promise.resolve(null);
    if (curStore.manifestP === undefined) {
      curStore.manifestP = fetch(base + "cur/manifest.json").then(function (r) {
        if (!r.ok) throw new Error("no currents manifest");
        return r.json();
      }).then(function (mf) {
        return (mf && mf.format === 1) ? mf : null;
      }).catch(function () { return null; });
    }
    return curStore.manifestP;
  }

  function curAt(base, lat, lon) {
    return curManifest(base).then(function (mf) {
      if (!mf) return null;
      var t = mf.tile_deg, lonW = wrapLon(lon);
      var ids = {}, dlat, dlon, la, lo;
      for (dlat = -1; dlat <= 1; dlat++) {
        for (dlon = -1; dlon <= 1; dlon++) {
          la = Math.max(-89.9, Math.min(89.9, lat + dlat * t * 0.6));
          lo = lonW + dlon * t * 0.6;
          var tlat = Math.floor((la + 90) / t) * t - 90;
          var tlon = Math.floor((wrapLon(lo) + 180) / t) * t - 180;
          ids["c_" + tlat + "_" + tlon] = 1;
        }
      }
      var list = Object.keys(ids).filter(function (id) { return mf.tiles.indexOf(id) >= 0; });
      list.forEach(function (id) {
        if (!curStore.tiles[id]) {
          curStore.tiles[id] = fetch(base + "cur/" + id + ".json")
            .then(function (r) { if (!r.ok) throw new Error("cur tile " + id); return r.json(); })
            .catch(function () { return null; });
        }
      });
      return Promise.all(list.map(function (id) { return curStore.tiles[id]; })).then(function (tilesArr) {
        var best = null, ti, tile, c, km;
        for (ti = 0; ti < tilesArr.length; ti++) {
          tile = tilesArr[ti];
          if (!tile) continue;
          for (c = 0; c < tile.lat.length; c++) {
            km = haversineKm(lat, lonW, tile.lat[c], tile.lon[c]);
            if (!best || km < best.km) best = { tile: tile, idx: c, km: km };
          }
        }
        if (!best || best.km > (mf.max_snap_km || 120)) return null;
        var tl = best.tile, ix = best.idx;
        function arr12(name) {
          if (!tl[name]) return null;
          var out = [], m, v;
          for (m = 0; m < 12; m++) {
            v = tl[name][ix][m];
            out.push(v < 0 ? null : v / 100);
          }
          return out;
        }
        function one(name, div) {
          if (!tl[name]) return null;
          var v = tl[name][ix];
          return v < 0 ? null : v / (div || 1);
        }
        var res = {
          cell: { lat: tl.lat[ix], lon: tl.lon[ix] }, km: Math.round(best.km),
          attribution: mf.attribution || null,
          bg: null, tide: null
        };
        if (tl.s5 || tl.b5) {
          res.bg = {
            surfP50: arr12("s5"), surfP90: arr12("s9"),
            botP50: arr12("b5"), botP90: arr12("b9"),
            botDepth: one("bd")
          };
        }
        if (tl.ts) {
          res.tide = {
            spring: one("ts", 100), neap: one("tn", 100), form: one("tf", 100),
            bearing: one("tb"), slack25: one("s25"), slack50: one("s50"),
            perDay: one("ns", 10)
          };
        }
        return res;
      });
    });
  }

  /* ---------- tropical cyclone exposure (web/data/cyc/, optional) ----------
     Written by tools/build_cyclones.py from IBTrACS best tracks. Per cell:
     storms per season and storm-days per month within fixed rings of the
     point (120/250/500/1000 nm) plus the strongest wind on record per ring. */

  var cycStore = { manifestP: undefined, tiles: {} };

  function cycManifest(base) {
    if (!base) return Promise.resolve(null);
    if (cycStore.manifestP === undefined) {
      cycStore.manifestP = fetch(base + "cyc/manifest.json").then(function (r) {
        if (!r.ok) throw new Error("no cyc manifest");
        return r.json();
      }).then(function (mf) {
        return (mf && mf.format === 1) ? mf : null;
      }).catch(function () { return null; });
    }
    return cycStore.manifestP;
  }

  function cycAt(base, lat, lon) {
    return cycManifest(base).then(function (mf) {
      if (!mf) return null;
      var t = mf.tile_deg, lonW = wrapLon(lon);
      var tlat = Math.floor((lat + 90) / t) * t - 90;
      var tlon = Math.floor((lonW + 180) / t) * t - 180;
      var ids = {}, dlat, dlon;
      for (dlat = -1; dlat <= 1; dlat++) {
        for (dlon = -1; dlon <= 1; dlon++) {
          var la2 = Math.max(-89.9, Math.min(89.9, lat + dlat * 0.9));
          var lo2 = wrapLon(lonW + dlon * 0.9);
          ids["cyc_" + (Math.floor((la2 + 90) / t) * t - 90) + "_" +
              (Math.floor((lo2 + 180) / t) * t - 180)] = 1;
        }
      }
      var list = Object.keys(ids).filter(function (id) { return mf.tiles.indexOf(id) >= 0; });
      list.forEach(function (id) {
        if (!cycStore.tiles[id]) {
          cycStore.tiles[id] = fetch(base + "cyc/" + id + ".json")
            .then(function (r) { if (!r.ok) throw new Error("cyc " + id); return r.json(); })
            .catch(function () { return null; });
        }
      });
      return Promise.all(list.map(function (id) { return cycStore.tiles[id]; })).then(function (arr) {
        var best = null, ti2, tile, c, km;
        for (ti2 = 0; ti2 < arr.length; ti2++) {
          tile = arr[ti2];
          if (!tile) continue;
          for (c = 0; c < tile.lat.length; c++) {
            km = haversineKm(lat, lonW, tile.lat[c], tile.lon[c]);
            if (!best || km < best.km) best = { tile: tile, idx: c, km: km };
          }
        }
        /* the cyc grid only holds exposed cells: a clear-water click simply
           finds nothing nearby, which IS the answer (no exposure) */
        if (!best || best.km > 170) return { none: true, radii: mf.radii_nm, attribution: mf.attribution };
        var NRr = mf.radii_nm.length, tl = best.tile, ix = best.idx;
        var storms = [], days = [], m, r, srow, drow;
        /* ENSO phase split of storm-days (datasets built from 23 Aug 26 on):
           [12][NRr][3] per-phase-year averages, null where the record holds
           no year of that phase for the month */
        var pdT = tl.pd ? tl.pd[ix] : null;
        var phDays = (pdT && pdT.length === 12 * NRr * 3 && mf.enso) ? [] : null;
        var p6, v6, prow, prr;
        for (m = 0; m < 12; m++) {
          srow = [];
          drow = [];
          for (r = 0; r < NRr; r++) {
            srow.push(tl.s[ix][m * NRr + r] / 100);
            drow.push(tl.d[ix][m * NRr + r] / 10);
          }
          storms.push(srow);
          days.push(drow);
          if (phDays) {
            prow = [];
            for (r = 0; r < NRr; r++) {
              prr = [];
              for (p6 = 0; p6 < 3; p6++) {
                v6 = pdT[m * NRr * 3 + r * 3 + p6];
                prr.push(v6 < 0 ? null : v6 / 10);
              }
              prow.push(prr);
            }
            phDays.push(prow);
          }
        }
        return {
          none: false, radii: mf.radii_nm, seasons: mf.seasons,
          attribution: mf.attribution,
          storms: storms, days: days,
          wmax: tl.w[ix].slice(),
          enso: phDays ? { days: phDays, ym: mf.enso.years_by_month } : null
        };
      });
    });
  }

  /* Phase-conditioned wave stats over the selected months: % of time above
     the given limit and mean Hs per ENSO phase, pooled by sample count so
     months weigh in by the data behind them. Returns null unless at least
     two phases carry data (a one-column comparison says nothing). */
  function ensoSummary(res, months, thresholds, limit) {
    if (!res.enso || !months.length) return null;
    var out = [], p, mi, m, n0, nSum, cSum, hSum, hN, mWith, pc;
    for (p = 0; p < 3; p++) {
      nSum = 0; cSum = 0; hSum = 0; hN = 0; mWith = 0;
      for (mi = 0; mi < months.length; mi++) {
        m = months[mi];
        n0 = res.enso.n[m][p];
        if (!n0) continue;
        mWith++;
        pc = interpExceedance(thresholds, res.enso.exc[m][p], limit);
        if (pc.p !== null) { cSum += pc.p * n0; nSum += n0; }
        if (res.enso.mean[m][p] !== null) { hSum += res.enso.mean[m][p] * n0; hN += n0; }
      }
      out.push({
        pct: nSum > 0 ? cSum / nSum : null,
        mean: hN > 0 ? hSum / hN : null,
        years: mWith ? Math.round((nSum || hN) / (8 * 30.4 * mWith)) : 0
      });
    }
    var withData = 0;
    for (p = 0; p < 3; p++) if (out[p].pct !== null) withData++;
    return withData >= 2 ? out : null;
  }

  /* Phase-conditioned cyclone storm-days over the selected months at one
     radius. days: sum of per-phase-year monthly averages; years: mean count
     of record years behind the phase across the selected months. */
  function cycEnsoSummary(cyc, months, ri) {
    if (!cyc || cyc.none || !cyc.enso || !months.length) return null;
    var out = [], p, mi, m, s, anyv, yrs, v;
    for (p = 0; p < 3; p++) {
      s = 0; anyv = false; yrs = 0;
      for (mi = 0; mi < months.length; mi++) {
        m = months[mi];
        v = cyc.enso.days[m][ri][p];
        if (v !== null) { s += v; anyv = true; }
        yrs += cyc.enso.ym[p][m];
      }
      out.push({ days: anyv ? Math.round(s * 10) / 10 : null,
                 years: Math.round(yrs / months.length) });
    }
    var withData = 0;
    for (p = 0; p < 3; p++) if (out[p].days !== null) withData++;
    return withData >= 2 ? out : null;
  }

  /* Saffir-Simpson wording for a best-track wind in knots. */
  function cycCategory(kt) {
    if (kt < 34) return null;
    if (kt < 64) return "tropical storm strength";
    if (kt < 83) return "Category 1";
    if (kt < 96) return "Category 2";
    if (kt < 113) return "Category 3";
    if (kt < 137) return "Category 4";
    return "Category 5";
  }

  /* Synthetic cyclone exposure for demo mode: basin boxes with a seasonal
     profile. Zero outside the belts, which hides the panel. */
  var DEMO_CYC_BASINS = [
    /* latMin latMax lonMin lonMax peakMonth(0-11) width strength */
    [8, 35, -100, -40, 8, 2.2, 1.0],     /* N Atlantic / GoM / Caribbean */
    [5, 25, -140, -95, 7, 2.0, 0.9],     /* E Pacific */
    [5, 32, 105, 170, 7.5, 3.0, 1.4],    /* W Pacific */
    [5, 22, 55, 95, 4, 1.2, 0.5],        /* N Indian early season */
    [5, 22, 55, 95, 10, 1.2, 0.6],       /* N Indian late season */
    [-25, -8, 35, 75, 0.5, 2.2, 0.8],    /* SW Indian */
    [-25, -8, 105, 160, 0.8, 2.2, 0.9],  /* Australia */
    [-25, -8, 160, 185, 1, 2.0, 0.6]     /* S Pacific (wraps) */
  ];
  var DEMO_CYC_RADII = [120, 250, 500, 1000];
  var DEMO_CYC_SCALE = [0.06, 0.18, 0.45, 1.0];

  function demoCyclones(lat, lon) {
    var lonN = wrapLon(lon), lon2 = lonN < 0 ? lonN + 360 : lonN;
    var per = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hit = false, b, k, m, d;
    for (k = 0; k < DEMO_CYC_BASINS.length; k++) {
      b = DEMO_CYC_BASINS[k];
      var inLon = (b[2] <= lonN && lonN <= b[3]) || (b[3] > 180 && lon2 >= b[2] && lon2 <= b[3]);
      if (lat < b[0] || lat > b[1] || !inLon) continue;
      hit = true;
      for (m = 0; m < 12; m++) {
        d = Math.abs(m - b[4]);
        if (d > 6) d = 12 - d;
        per[m] += b[6] * Math.exp(-(d * d) / (2 * b[5] * b[5]));
      }
    }
    if (!hit) return { none: true, radii: DEMO_CYC_RADII };
    var storms = [], days = [], wmax = [];
    for (m = 0; m < 12; m++) {
      var srow = [], drow = [];
      for (k = 0; k < 4; k++) {
        srow.push(Math.round(per[m] * DEMO_CYC_SCALE[k] * 100) / 100);
        drow.push(Math.round(per[m] * DEMO_CYC_SCALE[k] * (0.5 + 2.2 * DEMO_CYC_SCALE[k]) * 10) / 10);
      }
      storms.push(srow);
      days.push(drow);
    }
    var pk = Math.max.apply(null, per);
    for (k = 0; k < 4; k++) wmax.push(pk > 0.5 ? [95, 110, 125, 140][k] : [60, 70, 85, 100][k]);
    /* demo phase split: La Nina years busier, El Nino years quieter (the
       real signal is regional; this is layout evaluation only) */
    var phDays = [], ym = [[], [], []], pmul = [0.55, 1.0, 1.5];
    for (m = 0; m < 12; m++) {
      var prow = [];
      for (k = 0; k < 4; k++) {
        prow.push([Math.round(days[m][k] * pmul[0] * 10) / 10,
                   Math.round(days[m][k] * pmul[1] * 10) / 10,
                   Math.round(days[m][k] * pmul[2] * 10) / 10]);
      }
      phDays.push(prow);
      ym[0].push(12); ym[1].push(19); ym[2].push(14);
    }
    return { none: false, radii: DEMO_CYC_RADII, seasons: 45, storms: storms, days: days,
             wmax: wmax, enso: { days: phDays, ym: ym } };
  }

  /* Synthetic diurnal cycle for demo mode: sea-breeze shaped, real near
     coasts and in the tropics, near-flat in the open ocean. Slot s covers
     local solar 3s..3s+3 h; the shape bottoms at dawn (06) and peaks in the
     mid afternoon (15-18). */
  var DI_SHAPE = [-0.3, -0.8, -1.2, -0.4, 0.6, 1.2, 0.9, 0.1];

  function demoDiurnal(latc, lonc, meanArr) {
    var shelf = false, di, dj;
    for (di = -3; di <= 3 && !shelf; di++) {
      for (dj = -3; dj <= 3; dj++) {
        if (isLand(latc + di, lonc + dj)) { shelf = true; break; }
      }
    }
    var tropics = Math.abs(latc) < 25 ? 1.5 : 1.0;
    var ampH = (shelf ? 0.10 : 0.015) * tropics;
    var ampW = (shelf ? 0.22 : 0.04) * tropics;
    var hs = [], wind = [], m, s, hrow, wrow, wm;
    for (m = 0; m < 12; m++) {
      hrow = [];
      wrow = [];
      wm = 3.2 + 2.1 * meanArr[m];
      for (s = 0; s < 8; s++) {
        hrow.push(Math.round(meanArr[m] * (1 + ampH * DI_SHAPE[s]) * 100) / 100);
        wrow.push(Math.round(wm * (1 + ampW * DI_SHAPE[s]) * 10) / 10);
      }
      hs.push(hrow);
      wind.push(wrow);
    }
    return { hs: hs, wind: wind };
  }

  /* Day-weighted mean per local-solar slot over the selected months, plus
     the calm/rough slots and the relative range that decides whether the
     cycle is worth talking about. */
  function diurnalSummary(data, months) {
    if (!data.diurnal) return null;
    function agg(grid) {
      if (!grid) return null;
      var out = [], s, mi, m, num, den, allNull = true;
      for (s = 0; s < 8; s++) {
        num = 0;
        den = 0;
        for (mi = 0; mi < months.length; mi++) {
          m = months[mi];
          if (grid[m] && grid[m][s] !== null && grid[m][s] !== undefined) {
            num += MONTH_DAYS[m] * grid[m][s];
            den += MONTH_DAYS[m];
          }
        }
        out.push(den > 0 ? num / den : null);
        if (den > 0) allNull = false;
      }
      return allNull ? null : out;
    }
    var hs = agg(data.diurnal.hs);
    var wind = agg(data.diurnal.wind);
    if (!hs && !wind) return null;
    var ref = hs || wind, lo = -1, hi = -1, s, mean = 0, n = 0;
    for (s = 0; s < 8; s++) {
      if (ref[s] === null) continue;
      if (lo < 0 || ref[s] < ref[lo]) lo = s;
      if (hi < 0 || ref[s] > ref[hi]) hi = s;
      mean += ref[s];
      n++;
    }
    mean = n ? mean / n : 0;
    return {
      hs: hs, wind: wind, calmSlot: lo, roughSlot: hi,
      range: (lo >= 0 && hi >= 0) ? ref[hi] - ref[lo] : 0,
      relRange: mean > 0 && lo >= 0 ? (ref[hi] - ref[lo]) / mean : 0
    };
  }

  /* ---------- daylight (pure solar geometry, no dataset) ----------
     Mid-month sunrise/sunset and day length at a latitude, in LOCAL SOLAR
     time (solar noon = 12:00 by definition, so rise/set are symmetric about
     noon; clock time shifts with the zone and DST, which a global tool
     cannot know honestly). Standard declination approximation, +/- a few
     minutes, which is plenty for planning shifts. */

  var DAYS_BEFORE_M = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

  function daylightMonths(lat) {
    var out = [], m, N, decl, x, H, hours;
    for (m = 0; m < 12; m++) {
      N = DAYS_BEFORE_M[m] + 15;
      decl = -23.44 * Math.cos(2 * Math.PI / 365 * (N + 10));
      x = -Math.tan(lat * Math.PI / 180) * Math.tan(decl * Math.PI / 180);
      if (x <= -1) { hours = 24; }             /* polar day */
      else if (x >= 1) { hours = 0; }          /* polar night */
      else {
        H = Math.acos(x) * 180 / Math.PI;
        hours = 2 * H / 15;
      }
      out.push({
        hours: hours,
        rise: hours >= 24 ? null : (hours <= 0 ? null : 12 - hours / 2),
        set: hours >= 24 ? null : (hours <= 0 ? null : 12 + hours / 2)
      });
    }
    return out;
  }

  function fmtSolarTime(h) {
    var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    if (mm === 60) { hh += 1; mm = 0; }
    return ("0" + hh).slice(-2) + ":" + ("0" + mm).slice(-2);
  }

  /* Historical cyclone tracks (cyc/tracks.json): delta-encoded x100.
     -> [{n, y, w, pts: [[lat, lon], ...]}] */
  function decodeCycTracks(doc) {
    var out = [], i, tr, flat, pts, la, lo, k;
    for (i = 0; i < ((doc && doc.tracks) || []).length; i++) {
      tr = doc.tracks[i];
      flat = tr.e || [];
      pts = [];
      la = 0;
      lo = 0;
      for (k = 0; k + 1 < flat.length; k += 2) {
        la += flat[k];
        lo += flat[k + 1];
        pts.push([la / 100, lo / 100]);
      }
      if (pts.length >= 2) out.push({ n: tr.n, y: tr.y, w: tr.w, pts: pts });
    }
    return out;
  }

  /* Synthetic cyclone tracks for demo mode: parametric recurving parabolas
     seeded per basin, deterministic. Purely for layout evaluation. */
  function demoCycTracks() {
    var seeds = [
      /* lat0, lon0, dirW(+w -e), count, hemi */
      [12, -35, 1, 16, 1],      /* N Atlantic: form east, recurve NE */
      [10, -105, 1, 12, 1],     /* E Pacific */
      [8, 150, 1, 22, 1],       /* W Pacific */
      [-12, 90, -1, 8, -1],     /* SE Indian / Australia (drift west then SE) */
      [-12, 160, -1, 8, -1]     /* S Pacific */
    ];
    var out = [], si, k, t, s;
    for (si = 0; si < seeds.length; si++) {
      s = seeds[si];
      for (k = 0; k < s[3]; k++) {
        var jitter = ((si * 37 + k * 61) % 17) - 8;
        var la0 = s[0] + (k % 5) * 1.6, lo0 = s[1] + jitter;
        var pts = [], recurve = 10 + (k % 7) * 2.2, wmax = 45 + ((k * 29) % 95);
        for (t = 0; t < 26; t++) {
          var prog = t / 25;
          var la = la0 + s[4] * (prog * prog * 34 + prog * 4);
          var lo = lo0 - s[2] * (recurve * Math.sin(Math.PI * prog) - prog * prog * 30);
          pts.push([la, lo]);
        }
        out.push({ n: "Demo storm", y: 2000 + (k % 24), w: wmax, pts: pts });
      }
    }
    return out;
  }

  /* Day-weighted 12-sector rose aggregation over selected months (shared by
     the wave rose in prevailing() and the wind rose). roseByMonth[m] = [12]
     percents or null. */
  function aggregateRose(roseByMonth, months) {
    if (!roseByMonth) return null;
    var acc = [], den = 0, s, mi, m;
    for (s = 0; s < 12; s++) acc.push(0);
    for (mi = 0; mi < months.length; mi++) {
      m = months[mi];
      if (roseByMonth[m]) {
        for (s = 0; s < 12; s++) acc[s] += MONTH_DAYS[m] * roseByMonth[m][s];
        den += MONTH_DAYS[m];
      }
    }
    if (!den) return null;
    var tot = 0;
    for (s = 0; s < 12; s++) { acc[s] /= den; tot += acc[s]; }
    if (tot <= 0) return null;
    var best = 0;
    for (s = 0; s < 12; s++) {
      acc[s] = 100 * acc[s] / tot;
      if (acc[s] > acc[best]) best = s;
    }
    return { rose: acc, dirDeg: best * 30 + 15, dirName: compassName(best * 30 + 15),
             dirPct: acc[best] };
  }

  /* Day-weighted peak-period distribution over the selected months.
     -> {pct [nb], t0, step, nb, modeIdx, modePct} or null. */
  function tpHistAgg(res, months) {
    if (!res.tpHist || !res.tpHistMeta || !months.length) return null;
    var nb = res.tpHistMeta.nb, acc = [], den = 0, b, mi, m;
    for (b = 0; b < nb; b++) acc.push(0);
    for (mi = 0; mi < months.length; mi++) {
      m = months[mi];
      if (res.tpHist[m]) {
        for (b = 0; b < nb; b++) acc[b] += MONTH_DAYS[m] * res.tpHist[m][b];
        den += MONTH_DAYS[m];
      }
    }
    if (!den) return null;
    var tot = 0;
    for (b = 0; b < nb; b++) { acc[b] /= den; tot += acc[b]; }
    if (tot <= 0) return null;
    var best = 0;
    for (b = 0; b < nb; b++) {
      acc[b] = 100 * acc[b] / tot;
      if (acc[b] > acc[best]) best = b;
    }
    return { pct: acc, t0: res.tpHistMeta.t0, step: res.tpHistMeta.step, nb: nb,
             modeIdx: best, modePct: acc[best] };
  }

  /* Aggregate cyclone exposure over selected months at one radius index. */
  function cycSummary(cyc, months, ri) {
    if (!cyc || cyc.none) return null;
    var storms = 0, days = 0, i, m, any = false;
    for (i = 0; i < months.length; i++) {
      m = months[i];
      storms += cyc.storms[m][ri];
      days += cyc.days[m][ri];
      if (cyc.storms[m][ri] > 0 || cyc.days[m][ri] > 0) any = true;
    }
    return {
      storms: storms, days: days, any: any,
      wmax: cyc.wmax[ri],
      category: cycCategory(cyc.wmax[ri]),
      perMonth: cyc.days.map(function (row) { return row[ri]; })
    };
  }

  /* ---------- holistic aggregation over the selected months ---------- */

  /* Extremes summary: highest P99 among the selected months, the site's
     statistically roughest calendar month (all 12), and the pooled annual
     top 1% / 0.1% levels. Null when the data set lacks the fields. */
  function extremesSummary(data, months) {
    if (!data.ext) return null;
    var e = data.ext, selP99 = null, i, m, v, rough = -1;
    for (i = 0; i < months.length; i++) {
      v = e.p99[months[i]];
      if (v !== null && (selP99 === null || v > selP99)) selP99 = v;
    }
    for (m = 0; m < 12; m++) {
      v = e.p99[m];
      if (v !== null && (rough < 0 || v > e.p99[rough])) rough = m;
    }
    if (selP99 === null && rough < 0 && e.p99All === null) return null;
    return {
      selP99: selP99,
      roughMonth: rough >= 0 ? rough : null,
      roughP99: rough >= 0 ? e.p99[rough] : null,
      allP99: e.p99All, allP999: e.p999All
    };
  }

  /* Day-weighted wind speed summary over the selected months (m/s). */
  function windSummary(data, months) {
    if (!data.wind) return null;
    var num = 0, den = 0, num9 = 0, den9 = 0, i, m;
    for (i = 0; i < months.length; i++) {
      m = months[i];
      if (data.wind.mean && data.wind.mean[m] !== null) { num += MONTH_DAYS[m] * data.wind.mean[m]; den += MONTH_DAYS[m]; }
      if (data.wind.p90 && data.wind.p90[m] !== null) { num9 += MONTH_DAYS[m] * data.wind.p90[m]; den9 += MONTH_DAYS[m]; }
    }
    if (!den && !den9) return null;
    return { mean: den ? num / den : null, p90: den9 ? num9 / den9 : null };
  }

  /* Weather windows: spells with Hs below windows.thr[thrIdx] lasting at
     least windows.edges[edgeIdx] hours. Returns counts per calendar month
     (long-term average per year), null where no data. */
  function windowsPerMonth(data, thrIdx, edgeIdx) {
    if (!data.windows || !data.windows.runs) return null;
    var w = data.windows, out = [], m, b, s, bins;
    for (m = 0; m < 12; m++) {
      if (!w.runs[m] || !w.runs[m][thrIdx]) { out.push(null); continue; }
      bins = w.runs[m][thrIdx];
      s = 0;
      for (b = edgeIdx + 1; b < bins.length; b++) s += bins[b];
      out.push(Math.round(s * 10) / 10);
    }
    return out;
  }

  /* Day-weighted mean of the four background-current series over the
     selected months, plus the tide passthrough. */
  function curSummary(cur, months) {
    if (!cur) return null;
    function agg(arr) {
      if (!arr) return null;
      var num = 0, den = 0, i, m;
      for (i = 0; i < months.length; i++) {
        m = months[i];
        if (arr[m] !== null && arr[m] !== undefined) { num += MONTH_DAYS[m] * arr[m]; den += MONTH_DAYS[m]; }
      }
      return den > 0 ? num / den : null;
    }
    var out = { bg: null, tide: cur.tide || null, km: cur.km, attribution: cur.attribution || null };
    if (cur.bg) {
      out.bg = {
        surfP50: agg(cur.bg.surfP50), surfP90: agg(cur.bg.surfP90),
        botP50: agg(cur.bg.botP50), botP90: agg(cur.bg.botP90),
        botDepth: cur.bg.botDepth
      };
    }
    return (out.bg || out.tide) ? out : null;
  }

  /* Pipeline lines from assets.json: "e" is [lat0, lon0, dlat, dlon, ...]
     x10000. Returns [{n, s, c, o, src, pts: [[lat, lon], ...]}]. */
  function decodeAssetLines(lines) {
    var out = [], i, ln, flat, pts, la, lo, k;
    for (i = 0; i < (lines || []).length; i++) {
      ln = lines[i];
      flat = ln.e || [];
      pts = [];
      la = 0; lo = 0;
      for (k = 0; k + 1 < flat.length; k += 2) {
        la += flat[k]; lo += flat[k + 1];
        pts.push([la / 10000, lo / 10000]);
      }
      if (pts.length >= 2) out.push({ n: ln.n, s: ln.s, c: ln.c, o: ln.o, src: ln.src, pts: pts });
    }
    return out;
  }

  /* ---------- assets overlay helper ---------- */

  function nearestAsset(assets, lat, lon, maxKm) {
    var best = null, i, km;
    for (i = 0; i < assets.length; i++) {
      km = haversineKm(lat, lon, assets[i].la, assets[i].lo);
      if (!best || km < best.km) best = { asset: assets[i], km: km };
    }
    if (best) best.km = Math.round(best.km);
    return best && best.km <= maxKm ? best : null;
  }

  /* ---------- statistics helpers shared by UI + PDF ---------- */

  /* Combine calendar months, weighted by month length. Returns {p:[perThreshold], nTotal, months} */
  function combineMonths(data, months, thresholds) {
    var p = [], ti, m, num, den, v, nTotal = 0, usedMonths = [];
    for (m = 0; m < months.length; m++) {
      if (data.n[months[m]] > 0 && data.exc[months[m]][0] !== null) usedMonths.push(months[m]);
      nTotal += data.n[months[m]] || 0;
    }
    for (ti = 0; ti < thresholds.length; ti++) {
      num = 0; den = 0;
      for (m = 0; m < usedMonths.length; m++) {
        v = data.exc[usedMonths[m]][ti];
        if (v === null) continue;
        num += MONTH_DAYS[usedMonths[m]] * v;
        den += MONTH_DAYS[usedMonths[m]];
      }
      p.push(den > 0 ? num / den : null);
    }
    return { p: p, nTotal: nTotal, usedMonths: usedMonths };
  }

  var COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

  function compassName(deg) {
    return COMPASS16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  }

  /* Aggregate prevailing conditions over the selected months. Returns null
     when the provider carries no period/direction data (old tile sets).
     tp: day-weighted mean of the monthly typical (median) peak periods.
     Direction: the 30 deg sector (waves come FROM) winning the most
     day-weighted monthly votes; share: day-weighted mean modal share. */
  function prevailing(data, months) {
    if (!data.tp && !data.dirSect) return null;
    var tpNum = 0, tpDen = 0, sectW = [], shareNum = [], shareDen = [], i, mi, m, v;
    for (i = 0; i < 12; i++) { sectW.push(0); shareNum.push(0); shareDen.push(0); }
    for (mi = 0; mi < months.length; mi++) {
      m = months[mi];
      if (data.tp && data.tp[m] !== null && data.tp[m] !== undefined) {
        tpNum += MONTH_DAYS[m] * data.tp[m];
        tpDen += MONTH_DAYS[m];
      }
      if (data.dirSect && data.dirSect[m] !== null && data.dirSect[m] !== undefined) {
        v = data.dirSect[m];
        sectW[v] += MONTH_DAYS[m];
        shareNum[v] += MONTH_DAYS[m] * ((data.dirPct && data.dirPct[m]) || 0);
        shareDen[v] += MONTH_DAYS[m];
      }
    }
    var best = -1, bw = 0;
    for (i = 0; i < 12; i++) if (sectW[i] > bw) { bw = sectW[i]; best = i; }
    var out = { tp: tpDen > 0 ? tpNum / tpDen : null, dirDeg: null, dirName: null, dirPct: null, rose: null };
    if (best >= 0) {
      out.dirDeg = best * 30 + 15;
      out.dirName = compassName(out.dirDeg);
      out.dirPct = shareDen[best] > 0 ? shareNum[best] / shareDen[best] : null;
    }
    /* full 12-sector rose, day-weighted mean over months that carry one */
    if (data.dirRose) {
      var agg = aggregateRose(data.dirRose, months);
      if (agg) {
        out.rose = agg.rose;
        /* keep the headline consistent with the drawn rose */
        out.dirDeg = agg.dirDeg;
        out.dirName = agg.dirName;
        out.dirPct = agg.dirPct;
      }
    }
    return (out.tp === null && out.dirDeg === null) ? null : out;
  }

  /* Interpolated exceedance at an arbitrary Hs. Returns {p, floor} (floor: h beyond last threshold). */
  function interpExceedance(thresholds, p, h) {
    if (p[0] === null) return { p: null, floor: false };
    if (h <= 0) return { p: 100, floor: false };
    var pts = [[0, 100]], i;
    for (i = 0; i < thresholds.length; i++) if (p[i] !== null) pts.push([thresholds[i], p[i]]);
    var last = pts[pts.length - 1];
    if (h >= last[0]) return { p: last[1], floor: h > last[0] };
    for (i = 1; i < pts.length; i++) {
      if (h <= pts[i][0]) {
        var a = pts[i - 1], b = pts[i];
        var t = (h - a[0]) / (b[0] - a[0]);
        return { p: a[1] + t * (b[1] - a[1]), floor: false };
      }
    }
    return { p: last[1], floor: true };
  }

  function fmtPct(p) {
    if (p === null || p === undefined || isNaN(p)) return "no data";
    if (p < 0.05) return "<0.1%";
    if (p < 1) return p.toFixed(1) + "%";
    if (p < 10) return p.toFixed(1) + "%";
    return Math.round(p) + "%";
  }

  function fmtLatLon(lat, lon) {
    var ns = lat >= 0 ? "N" : "S", ew = lon >= 0 ? "E" : "W";
    return Math.abs(lat).toFixed(2) + "\u00B0 " + ns + ", " + Math.abs(lon).toFixed(2) + "\u00B0 " + ew;
  }

  /* Degrees + decimal minutes, the form charts and GPS units speak. Used to
     echo back what the manual position box understood. */
  function fmtDDM(lat, lon) {
    function one(v, latAxis) {
      var hemi = latAxis ? (v < 0 ? "S" : "N") : (v < 0 ? "W" : "E");
      var a = Math.abs(v), d = Math.floor(a);
      var m = Math.round((a - d) * 60 * 1000) / 1000;
      if (m >= 60) { d += 1; m -= 60; }
      return d + "\u00B0 " + m.toFixed(3) + "\u2032 " + hemi;
    }
    return one(lat, true) + ", " + one(lon, false);
  }

  /* Manual position entry. Reads the formats people actually hold: decimal
     degrees, degrees + decimal minutes (charts, GPS units) and full DMS,
     with hemisphere letters before or after each value, symbols or plain
     spaces between the parts, and the pair split by a comma or just spaces.
     Positions are WGS84 by definition (the GPS datum; every dataset here is
     served in it). Structure comes from the COUNT of numbers per side
     (1 = D, 2 = D M, 3 = D M S), never from the marks, so 56 30.25 N and
     56\u00B030.25'N read the same. Returns {lat, lon} or {error}. */
  function parseLatLon(text) {
    var HINT = 'Try "56 30.25 N, 3 12.5 E" or "-12.5, 130.8".';
    function bad(msg) { return { error: msg }; }
    if (!text || !String(text).trim()) return bad("Type a position first. " + HINT);
    var t = String(text).toUpperCase()
      .replace(/[\u00B0\u00BA\u02DA]/g, " ")        /* degree signs */
      .replace(/(\d)\s*D(?=[\s0-9.+-]|$)/g, "$1 ")  /* 56d30 letter-degree */
      .replace(/[\u2032\u2019\u00B4`']/g, " ")      /* minute marks */
      .replace(/[\u2033\u201D"]/g, " ");            /* second marks */

    /* tokens: numbers and NSEW letters; a letter "binds right" when glued
       to the next number (E3.2), which is what tells a prefix letter from a
       suffix one when there is no comma */
    function toks(str) {
      var re = /[+-]?\d+(?:\.\d+)?|[NSEW]/g, out = [], m2, isL;
      if (str.replace(re, " ").replace(/[\s]+/g, "").length) return null;
      while ((m2 = re.exec(str)) !== null) {
        isL = /^[NSEW]$/.test(m2[0]);
        out.push({ v: m2[0], L: isL, R: isL && /[0-9.+-]/.test(str.charAt(re.lastIndex)) });
      }
      return out;
    }

    /* one side -> signed decimal degrees + which axis its letter claims */
    function readHalf(list) {
      var nums = [], raw = [], hemi = null, i;
      for (i = 0; i < list.length; i++) {
        if (list[i].L) {
          if (hemi) return bad("More than one N/S/E/W letter on one value. " + HINT);
          hemi = list[i].v;
        } else { nums.push(parseFloat(list[i].v)); raw.push(list[i].v); }
      }
      if (!nums.length) return bad("Could not find both numbers. " + HINT);
      if (nums.length > 3) return bad("Too many numbers on one side; degrees, minutes and seconds is the most a value can carry. " + HINT);
      for (i = 1; i < nums.length; i++) {
        if (/^[+-]/.test(raw[i])) return bad("Only the degrees may carry a sign; use N/S/E/W or a leading minus. " + HINT);
      }
      for (i = 0; i < nums.length - 1; i++) {
        if (nums[i] % 1 !== 0) return bad("Only the last number of a value may have decimals (56.5, or 56 30.25, not 56.5 30). " + HINT);
      }
      if (nums.length > 1 && nums[1] >= 60) return bad("Minutes must be below 60.");
      if (nums.length > 2 && nums[2] >= 60) return bad("Seconds must be below 60.");
      var val = Math.abs(nums[0]) + (nums[1] || 0) / 60 + (nums[2] || 0) / 3600;
      if (/^-/.test(raw[0])) val = -val;
      if (hemi === "S" || hemi === "W") val = -Math.abs(val);
      if (hemi === "N" || hemi === "E") val = Math.abs(val);
      return { val: val, axis: hemi ? (hemi === "N" || hemi === "S" ? "lat" : "lon") : null };
    }

    var h1, h2, i, seps = t.split(/[,;\/]/);
    if (seps.length > 2) {
      return bad("Use one comma between latitude and longitude, and a decimal point (not a comma) inside numbers. " + HINT);
    }
    if (seps.length === 2) {
      h1 = toks(seps[0]); h2 = toks(seps[1]);
      if (!h1 || !h2) return bad("Could not read that. " + HINT);
    } else {
      var tk = toks(t);
      if (!tk) return bad("Could not read that. " + HINT);
      var li = [];
      for (i = 0; i < tk.length; i++) if (tk[i].L) li.push(i);
      if (li.length > 2) return bad("Too many N/S/E/W letters. " + HINT);
      if (li.length === 2) {
        /* cut somewhere between the letters, balancing the number counts */
        var best = li[0] + 1, bestDiff = 1e9, c, n1, n2, diff;
        for (c = li[0] + 1; c <= li[1]; c++) {
          n1 = 0; n2 = 0;
          for (i = 0; i < tk.length; i++) if (!tk[i].L) { if (i < c) n1++; else n2++; }
          diff = Math.abs(n1 - n2);
          if (diff < bestDiff) { bestDiff = diff; best = c; }
        }
        h1 = tk.slice(0, best); h2 = tk.slice(best);
      } else {
        var nNums = 0;
        for (i = 0; i < tk.length; i++) if (!tk[i].L) nNums++;
        if (!nNums || nNums % 2 !== 0) {
          return bad("Separate latitude and longitude with a comma. " + HINT);
        }
        var need = nNums / 2, got = 0, cut = 0;
        for (i = 0; i < tk.length; i++) {
          if (!tk[i].L) got++;
          if (got === need) {
            cut = i + 1;
            /* a suffix letter (56 30 N) travels with its value; a glued
               prefix letter (E3.2) starts the next one */
            if (tk[cut] && tk[cut].L && !tk[cut].R) cut++;
            break;
          }
        }
        h1 = tk.slice(0, cut); h2 = tk.slice(cut);
      }
    }

    var A = readHalf(h1);
    if (A.error) return A;
    var B = readHalf(h2);
    if (B.error) return B;
    if (A.axis && B.axis && A.axis === B.axis) {
      return bad("Both values carry the same axis letter (" + (A.axis === "lat" ? "N/S" : "E/W") + " twice). " + HINT);
    }
    var lat = A.val, lon = B.val;
    if (A.axis === "lon" || B.axis === "lat") { lat = B.val; lon = A.val; }
    if (Math.abs(lat) > 90) {
      return bad("Latitude must be between 90 S and 90 N" +
        (A.axis || B.axis ? "." : " - type latitude first, or add N/S and E/W letters."));
    }
    if (Math.abs(lon) > 360) return bad("Longitude is out of range.");
    return { lat: lat, lon: wrapLon(lon) };
  }

  window.TMData = {
    decodeDeltaRings: decodeDeltaRings,
    compassName: compassName,
    MONTH_DAYS: MONTH_DAYS,
    MONTH_NAMES: MONTH_NAMES,
    THRESHOLDS: THRESHOLDS,
    haversineKm: haversineKm,
    wrapLon: wrapLon,
    buildLandMask: buildLandMask,
    isLand: isLand,
    nearestOceanCell: nearestOceanCell,
    DemoProvider: DemoProvider,
    TileProvider: TileProvider,
    combineMonths: combineMonths,
    prevailing: prevailing,
    extremesSummary: extremesSummary,
    windSummary: windSummary,
    windowsPerMonth: windowsPerMonth,
    curAt: curAt,
    curSummary: curSummary,
    cycAt: cycAt,
    cycManifest: cycManifest,
    cycSummary: cycSummary,
    ensoSummary: ensoSummary,
    cycEnsoSummary: cycEnsoSummary,
    tpHistAgg: tpHistAgg,
    cycCategory: cycCategory,
    demoCyclones: demoCyclones,
    diurnalSummary: diurnalSummary,
    daylightMonths: daylightMonths,
    fmtSolarTime: fmtSolarTime,
    aggregateRose: aggregateRose,
    decodeCycTracks: decodeCycTracks,
    demoCycTracks: demoCycTracks,
    interpExceedance: interpExceedance,
    fmtPct: fmtPct,
    fmtLatLon: fmtLatLon,
    fmtDDM: fmtDDM,
    parseLatLon: parseLatLon,
    bathyLevels: bathyLevels,
    depthBandAt: depthBandAt,
    depthManifest: depthManifest,
    depthExactAt: depthExactAt,
    nearestAsset: nearestAsset,
    decodeAssetLines: decodeAssetLines
  };
})();
