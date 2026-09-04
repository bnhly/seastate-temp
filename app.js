/* Sea State Explorer - application glue.
   Provider selection (real tiles if data/manifest.json exists, demo otherwise),
   month + limit controls, results rendering, PDF hand-off. */
(function () {
  "use strict";

  var DEFAULTS = {
    companyName: "Thrust Maritime",
    website: "https://www.thrustm.com",
    logoSrc: "assets/thrust-maritime-logo.png",
    dataBase: "data/",
    pdfLibSrc: "vendor/pdf-lib.min.js",
    bathySrc: "bathy.js",
    coastBase: "coast/",
    pdfDelivery: "download",   /* "inline" in the sandboxed preview build */
    limitDefault: 2,
    disclaimerLive: "Values are long term climatological estimates for open water derived from " +
      "reanalysis data. They are not forecasts, may underestimate extreme conditions including " +
      "tropical cyclones, and are unreliable close to coastlines and in sheltered or shallow " +
      "water. Not for design, navigation or operational decision making. No warranty is given.",
    disclaimerDemo: "DEMONSTRATION MODE: every number shown is synthetic, generated from a " +
      "simplified parametric model so the tool can be evaluated before the real dataset is " +
      "built. Do not use these values for anything.",
    termsNote: "Free to use for individual planning reference, and free to cite: " +
      "Thrust Maritime, Sea State Explorer, the location and the date you read it, with a " +
      "link to the result. Automated bulk extraction of the tool's data tiles is not " +
      "permitted; the underlying open datasets are available from the original providers " +
      "credited below, and the methodology page states every source and derivation."
  };

  var cfg = {};
  var k;
  for (k in DEFAULTS) cfg[k] = DEFAULTS[k];
  if (window.TM_CONFIG_OVERRIDES) {
    for (k in window.TM_CONFIG_OVERRIDES) cfg[k] = window.TM_CONFIG_OVERRIDES[k];
  }

  /* Cache busting. GitHub Pages sends a long max-age on static files, so a
     deploy is invisible to anyone who has the site cached until it expires.
     tools/stamp_build.py sets window.TM_BUILD on the deployed page and
     versions the script tags; these fetches carry the same stamp so data
     files turn over with the code. Undefined in local development, where the
     URL is left clean. */
  function vurl(u) {
    return window.TM_BUILD ? u + (u.indexOf("?") < 0 ? "?" : "&") + "v=" + window.TM_BUILD : u;
  }

  var D = window.TMData;
  var state = {
    provider: null,
    isDemo: true,
    selected: null,        /* {lat, lon} clicked */
    cellData: null,        /* provider query result */
    monthsOn: [true, true, true, true, true, true, true, true, true, true, true, true],
    limit: cfg.limitDefault,
    map: null,
    heatTimer: null,
    bathyPromise: null,
    bathyReady: false,
    bathyFailed: false,
    assetsData: null,
    assetsAttribution: "",
    depthExact: null,
    depthAttribution: "",
    lastDepth: null,
    lastNearest: null,
    curFetch: null,        /* {key, val} live currents tile lookup */
    curAttribution: "",
    cycFetch: null,        /* {key, val} live cyclone tile lookup */
    cycAttribution: "",
    cycR: null,            /* cyclone radius index; default = the widest ring */
    winThr: null,          /* weather-window controls (indices) */
    winDur: null,
    pendingWin: null,      /* {thr, dur} values from a shared link, applied
                              when the windows selects first populate */
    lastHash: null,        /* last share fragment this app wrote itself */
    lastExtremes: null,
    lastWind: null,
    lastWindows: null,
    lastCur: null,
    lastCyc: null,
    lastDiurnal: null,
    lastEnso: null,
    lastTpMode: null,
    lastDaylight: null
  };

  function $(id) { return document.getElementById(id); }

  function monthIdxList() {
    var out = [], i;
    for (i = 0; i < 12; i++) if (state.monthsOn[i]) out.push(i);
    return out;
  }

  function monthsLabel() {
    var sel = monthIdxList();
    if (sel.length === 12) return "across the whole year";
    if (sel.length === 0) return "(no months selected)";
    return "in " + sel.map(function (m) { return D.MONTH_NAMES[m]; }).join(", ");
  }

  /* ---------- UI wiring ---------- */

  function buildMonthChips() {
    var box = $("tm-months"), i, b;
    for (i = 0; i < 12; i++) {
      b = document.createElement("button");
      b.type = "button";
      b.textContent = D.MONTH_NAMES[i];
      b.setAttribute("aria-pressed", "true");
      (function (idx, btn) {
        btn.addEventListener("click", function () {
          state.monthsOn[idx] = !state.monthsOn[idx];
          btn.setAttribute("aria-pressed", state.monthsOn[idx] ? "true" : "false");
          onFilterChange();
        });
      })(i, b);
      box.appendChild(b);
    }
    $("tm-months-all").addEventListener("click", function () { setAllMonths(true); });
    $("tm-months-none").addEventListener("click", function () { setAllMonths(false); });
  }

  function setAllMonths(on) {
    var btns = $("tm-months").children, i;
    for (i = 0; i < 12; i++) {
      state.monthsOn[i] = on;
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    onFilterChange();
  }

  function onFilterChange() {
    scheduleHeat();
    renderResults();
  }

  function scheduleHeat() {
    clearTimeout(state.heatTimer);
    state.heatTimer = setTimeout(refreshHeat, 180);
  }

  function refreshHeat() {
    var on = $("tm-shade").checked;
    refreshLegend();
    if (!on) { state.map.setHeatField(null); return; }
    var sel = monthIdxList();
    if (!sel.length) { state.map.setHeatField(null); return; }
    state.provider.heatField(sel).then(function (fn) {
      state.map.setHeatField(fn);
    });
  }

  /* ---------- map layers: bathymetry + assets ---------- */

  function ensureBathy() {
    if (state.bathyPromise) return state.bathyPromise;
    state.bathyPromise = new Promise(function (resolve, reject) {
      if (window.TM_BATHY_ENC) { resolve(); return; }
      var s2 = document.createElement("script");
      s2.src = vurl(cfg.bathySrc);
      s2.onload = function () { resolve(); };
      s2.onerror = function () { reject(new Error("Depth data failed to load.")); };
      document.head.appendChild(s2);
    }).then(function () {
      state.bathyReady = true;
      return D.bathyLevels();
    });
    return state.bathyPromise;
  }

  /* High-detail coastline, TILED (web/coast/, built by build_coast_tiles.py).
     The old single 2.5 MB file stalled Chrome at the swap: one giant parse,
     one 412k-point Path2D, then full-world draws. Now the manifest loads
     once past the tile zoom threshold and only the tiles in view are
     fetched (a few at a time); the map draws them when the visible set is
     complete and within its vertex budget, else it stays on the 50m coast.
     On any failure the 50m coastline simply stays. */
  function ensureCoastHD() {
    if (state.coastMetaState === "failed") return;
    if (!state.coastMetaState) {
      state.coastMetaState = "loading";
      fetch(vurl(cfg.coastBase + "manifest.json")).then(function (r) {
        if (!r.ok) throw new Error("coast manifest " + r.status);
        return r.json();
      }).then(function (mf) {
        state.coastMetaState = "ready";
        state.map.setCoastMeta(mf);
        pumpCoastTiles();
      }).catch(function () { state.coastMetaState = "failed"; });
      return;
    }
    if (state.coastMetaState === "ready") pumpCoastTiles();
  }

  function pumpCoastTiles() {
    if (state.coastPump >= 4) return;
    var wanted = state.map.coastTilesWanted();
    if (!wanted.length) return;
    state.coastPump = (state.coastPump || 0) + 1;
    var id = wanted[0];
    state.map.markCoastTilePending(id);
    fetch(vurl(cfg.coastBase + id + ".json")).then(function (r) {
      if (!r.ok) throw new Error("coast tile " + r.status);
      return r.json();
    }).then(function (doc) {
      state.map.addCoastTile(id,
        D.decodeDeltaRings(doc.f || [], state.map.coastScale()),
        D.decodeDeltaRings(doc.s || [], state.map.coastScale()));
    }).catch(function () {
      /* leave it pending-failed; the 50m coast covers the gap */
    }).then(function () {
      state.coastPump -= 1;
      pumpCoastTiles();
    });
    pumpCoastTiles();
  }

  function loadAssetsData() {
    if (window.TM_ASSETS_DATA) return Promise.resolve(window.TM_ASSETS_DATA);
    if (cfg.dataBase === null) return Promise.reject(new Error("no data base"));
    return fetch(vurl(cfg.dataBase + "assets.json")).then(function (r) {
      if (!r.ok) throw new Error("assets " + r.status);
      return r.json();
    });
  }

  function assetsAreDemo() {
    var d = state.assetsData, i;
    if (!d) return false;
    for (i = 0; i < d.sources.length; i++) if (d.sources[i].id === "demo") return true;
    return false;
  }

  function refreshLegend() {
    var el = $("tm-legend");
    var parts = [];
    if ($("tm-shade").checked && monthIdxList().length) {
      parts.push('<span class="tm-lg-title">Mean H<sub>s</sub></span>' +
        '<span class="tm-lg-bar"></span>' +
        '<span class="tm-lg-scale"><span>0</span><span>6+ m</span></span>');
    }
    if ($("tm-contours").checked && state.bathyReady) {
      /* Only the contours actually crossing the view (Ben, 1 Sep 26). The
         fixed list named 1,000 m and 3,000 m on a shelf where neither line
         is anywhere on screen. */
      /* Natural Earth's three levels have fixed weights; the ETOPO ladder is
         chosen at run time, so anything not listed falls back to a plain
         hairline rather than vanishing. */
      var DSTYLE = { 200: "border-top-width:2px", 1000: "border-top-width:1px;opacity:.72",
                     3000: "border-top-width:1px;opacity:.45" };
      var inView = state.map ? state.map.depthsInView() : [200, 1000, 3000];
      var drows = "", di;
      for (di = 0; di < inView.length; di++) {
        drows += '<span class="tm-lg-row"><span class="tm-lg-line" style="' +
          (DSTYLE[inView[di]] || "border-top-width:1px") + '"></span>' +
          inView[di].toLocaleString() + ' m</span>';
      }
      var fine = state.map && state.map.fineContoursWanted() && state.map.fineContours;
      parts.push('<span class="tm-lg-title">Depth' + (fine ? " (ETOPO)" : "") + '</span>' + (drows ||
        '<span class="tm-lg-row tm-lg-none">none in view</span>'));
    }
    if (state.assetsData && $("tm-assets").checked) {
      var rows = '<span class="tm-lg-title">Assets' + (assetsAreDemo() ? " (demo)" : "") + '</span>' +
        '<span class="tm-lg-row"><span class="tm-lg-diamond"></span>Platform</span>' +
        '<span class="tm-lg-row"><span class="tm-lg-dot"></span>Field</span>';
      if (assetsHaveLng() && $("tm-f-lng").checked) {
        rows += '<span class="tm-lg-row"><span class="tm-lg-square"></span>LNG terminal</span>';
      }
      if (assetsHaveWells()) {
        var wellHint = (state.map && state.map.wellsVisible()) ? "" : " (zoom in)";
        rows += '<span class="tm-lg-row"><span class="tm-lg-dot" style="width:5px;height:5px"></span>Well' + wellHint + '</span>';
      }
      if (state.assetLines && state.assetLines.length && $("tm-f-pipes").checked) {
        var pipeHint = (state.map && state.map.pipesVisible()) ? "" : " (zoom in)";
        rows += '<span class="tm-lg-row"><span class="tm-lg-line" style="border-top-width:2px;border-top-color:#c2571f;opacity:.75"></span>Pipeline' + pipeHint + '</span>';
      }
      parts.push(rows);
    }
    if (state.cycTracksLoaded && $("tm-cyctracks").checked) {
      parts.push('<span class="tm-lg-title">Cyclone tracks' + (state.isDemo ? " (demo)" : "") + '</span>' +
        '<span class="tm-lg-row"><span class="tm-lg-line" style="border-top-width:2px;border-top-color:rgba(122,84,160,.65)"></span>Major (cat 3+)</span>' +
        '<span class="tm-lg-row"><span class="tm-lg-line" style="border-top-width:1px;border-top-color:rgba(122,84,160,.45)"></span>Weaker storms</span>');
    }
    el.hidden = parts.length === 0;
    el.innerHTML = parts.join('<span class="tm-lg-gap"></span>');
  }

  /* The one source list, shared by the page footer and the PDF so the two
     can never disagree about what fed a result. */
  function allSources() {
    /* The footer is the ONLY place sources are listed now (the data banner
       was removed 1 Sep 26), so it must be complete from first paint rather
       than filling in as layers load. Each layer's own file still supplies
       the authoritative wording once fetched; these are the same strings,
       stated up front. */
    var parts = [state.provider.meta.attribution,
      "Depth contours and depth bands: Natural Earth 1:10m bathymetry (public domain).",
      "Coastline: Wessel, P., and W. H. F. Smith, A Global Self-consistent, Hierarchical, " +
      "High-resolution Shoreline Database, J. Geophys. Res., 101, 8741-8743, 1996 (GSHHG, at " +
      "close zoom) and Natural Earth 1:50m land (public domain, at world scale)."];
    parts.push(state.depthAttribution ||
      "Water depths: ETOPO 2022 Global Relief Model, NOAA National Centers for " +
      "Environmental Information (public domain).");
    if (state.assetsAttribution) parts.push(state.assetsAttribution);
    if (state.cycAttribution) parts.push(state.cycAttribution);
    /* the currents layer's Copernicus Marine sentence was collected here
       but never printed (found 4 Sep 26 while building the sources table) */
    if (state.curAttribution) parts.push(state.curAttribution);
    return parts.join(" ");
  }

  /* Fine depth contours -------------------------------------------------
     Ben, 1 Sep 26: zooming in USED to show fewer contours, because Natural
     Earth only carries 200 / 1000 / 2000 / 3000 m, so a deep-water view had
     one line in it and a shelf view had none. These come from the 0.1 degree
     ETOPO tiles instead, with the level set chosen from the depths actually
     in view, so a shelf gets 20 m spacing and an abyssal plain gets 500. */
  var FINE_LADDERS = [
    /* maxDepth in view, levels to draw */
    [60,    [10, 20, 30, 40, 50]],
    [150,   [20, 50, 75, 100, 125, 150]],
    [400,   [50, 100, 150, 200, 300, 400]],
    [1200,  [100, 200, 400, 600, 800, 1000]],
    [3000,  [200, 500, 1000, 1500, 2000, 2500, 3000]],
    [99999, [500, 1000, 2000, 3000, 4000, 5000, 6000]]
  ];

  function fineLevelsFor(maxDepth) {
    var i;
    for (i = 0; i < FINE_LADDERS.length; i++) {
      if (maxDepth <= FINE_LADDERS[i][0]) return FINE_LADDERS[i][1];
    }
    return FINE_LADDERS[FINE_LADDERS.length - 1][1];
  }

  function refreshFineContours() {
    if (!state.map || !state.map.fineContoursWanted()) {
      if (state.fineKey) { state.fineKey = null; state.map.setFineContours(null); }
      return;
    }
    var b = state.map.viewBounds();
    /* Round the box so small mouse movements do not re-request the same
       thing; the contours are only redrawn when the view really moves. */
    var q = 0.25;
    var key = [Math.floor(b.lat0 / q), Math.ceil(b.lat1 / q),
               Math.floor(b.lon0 / q), Math.ceil(b.lon1 / q)].join(",");
    if (key === state.fineKey) return;
    state.fineKey = key;
    /* The depth at the selected point sets the ladder. state.depthExact is
       what the ETOPO lookup stores; with nothing selected yet, assume deep
       water so the first draw is not a mess of shelf contours. */
    var dm = (state.depthExact && state.depthExact.val && state.depthExact.val.m) || null;
    var lvl = fineLevelsFor(dm || 3000);
    D.contoursForBox(cfg.dataBase, b.lat0, b.lat1, b.lon0, b.lon1, lvl)
      .then(function (sets) {
        /* a later view may have won the race while the tiles were fetched */
        if (state.fineKey !== key) return;
        state.map.setFineContours(sets);
        /* the tiles land after the view has settled, so the legend has to be
           told separately; onView has already been and gone by now */
        state.depthsShown = state.map.depthsInView().join(",");
        refreshLegend();
      })
      .catch(function () {
        state.map.setFineContours(null);
        refreshLegend();
      });
  }

  /* Hs x Tp scatter ------------------------------------------------------
     The joint table for the cell arrives once per cell (its own optional
     tile set); month changes re-aggregate from the cached months without a
     refetch. Values are parts per thousand, the convention scatter tables
     are read in; counts stay behind them for the sample-size line. */
  function renderScatter() {
    var row = $("tm-rowj");
    var jd = state.jointFetch && state.jointFetch.key === state.jointKey ? state.jointFetch.val : null;
    var sel = monthIdxList();
    state.pdfScatter = null;
    if (!jd || !sel.length) { row.hidden = true; return; }
    var agg = D.jointAggregate(jd.months, sel, jd.hs.nb, jd.tp.nb);
    if (!agg.total) { row.hidden = true; return; }
    row.hidden = false;
    $("tm-scatter-title").textContent = "Wave height against peak period " + monthsLabel();

    var hsNb = jd.hs.nb, tpNb = jd.tp.nb, r, c;
    var pml = [], vmax = 0, top = 0;
    for (r = 0; r < hsNb; r++) {
      pml.push([]);
      for (c = 0; c < tpNb; c++) {
        var v = 1000 * agg.grid[r][c] / agg.total;
        pml[r].push(v);
        if (v > vmax) vmax = v;
        if (agg.grid[r][c] > 0 && r > top) top = r;
      }
    }

    var html = '<table class="tm-scatter"><thead><tr><th>H<sub>s</sub> \\ T<sub>p</sub></th>';
    for (c = 0; c < tpNb; c++) {
      html += "<th>" + (c === tpNb - 1 ? (jd.tp.t0 + c) + "+" : (jd.tp.t0 + c) + "\u2013" + (jd.tp.t0 + c + 1)) + " s</th>";
    }
    html += "<th class=\"tm-sc-tot\">all</th></tr></thead><tbody>";
    for (r = top; r >= 0; r--) {
      var lab = r === hsNb - 1
        ? (jd.hs.h0 + r * jd.hs.step).toFixed(1) + "+"
        : (jd.hs.h0 + r * jd.hs.step).toFixed(1) + "\u2013" + (jd.hs.h0 + (r + 1) * jd.hs.step).toFixed(1);
      html += "<tr><th>" + lab + " m</th>";
      var rowSum = 0;
      for (c = 0; c < tpNb; c++) {
        var vv = pml[r][c];
        rowSum += vv;
        if (agg.grid[r][c] === 0) {
          html += '<td class="tm-sc-zero">\u00b7</td>';
        } else {
          var shade = Math.pow(vv / vmax, 0.5) * 0.55;
          var txt = vv >= 1 ? String(Math.round(vv)) : "&lt;1";
          html += '<td class="tm-sc-heat" style="background:rgba(57,135,229,' +
            shade.toFixed(3) + ')">' + txt + "</td>";
        }
      }
      html += '<td class="tm-sc-tot">' + (rowSum >= 1 ? Math.round(rowSum) : "&lt;1") + "</td></tr>";
    }
    html += '<tr><th class="tm-sc-tot">all</th>';
    for (c = 0; c < tpNb; c++) {
      var cs = 0;
      for (r = 0; r < hsNb; r++) cs += pml[r][c];
      html += '<td class="tm-sc-tot">' + (cs >= 1 ? Math.round(cs) : (cs > 0 ? "&lt;1" : "\u00b7")) + "</td>";
    }
    html += '<td class="tm-sc-tot">1000</td></tr></tbody></table>';
    $("tm-scatter").innerHTML = html;
    $("tm-scatter-note").textContent =
      "Parts per thousand of the time each wave height and peak period pair occurs, from " +
      agg.total.toLocaleString() + " samples. " + jd.sourceLabel + ", " + jd.period +
      ", aggregated over a 1.0\u00b0 cell around the data point.";
    state.pdfScatter = { grid: agg.grid, total: agg.total, hs: jd.hs, tp: jd.tp,
                         top: top, sourceLabel: jd.sourceLabel, period: jd.period };
  }

  /* Sources table (Ben, 4 Sep 26): what the data is, who made it, how they
     collected or produced it, and what we do with it, one row per layer.
     The providers' licence sentences stay verbatim under the table because
     Copernicus and ECMWF require their exact wording; the table is the
     readable version, not a replacement. Rows for optional layers appear
     once that layer's file has loaded. */
  var OURS_WAVES = "Nearest grid cell, no interpolation. Share of time at or above each " +
    "height from 0.25 m bins per calendar month, months combined by their length in days, " +
    "extremes as the 99th and 99.9th percentile of the 3 hourly samples, calm spells " +
    "tracked per cell for the weather windows.";

  function sourceRows() {
    var m = state.provider.meta || {}, src = String(m.source || "").toUpperCase();
    var attr = String(m.attribution || "");
    var rows = [];
    if (src === "WAVERYS") {
      rows.push(["Waves: significant height, peak period, direction",
        "WAVERYS wave reanalysis, Mercator Ocean International via the Copernicus Marine Service (" + m.period + ")",
        "MFWAM wave model reanalysis on a 0.2 degree grid, forced by ERA5 winds and GLORYS currents, " +
        "assimilating satellite altimeter wave heights and Sentinel-1 SAR wave spectra. Buoys are used " +
        "to validate it, not assimilated.",
        OURS_WAVES]);
    } else if (src === "ERA5") {
      rows.push(["Waves: significant height, peak period, direction",
        "ERA5 reanalysis, ECMWF via the Copernicus Climate Change Service (" + m.period + ")",
        "Global wave model coupled to the ERA5 atmospheric reanalysis on a 0.5 degree grid, " +
        "assimilating satellite altimeter wave heights. Buoys are used to validate it, not assimilated.",
        OURS_WAVES]);
    } else {
      rows.push(["Waves", m.sourceLabel || "Demonstration data", "Synthetic climatology for the demonstration mode.", OURS_WAVES]);
    }
    if (src === "ERA5" || attr.indexOf("ERA5") >= 0) {
      rows.push(["Wind at 10 m",
        "ERA5 reanalysis, ECMWF via the Copernicus Climate Change Service",
        "Atmospheric reanalysis that assimilates satellite radiances and winds, radiosondes, aircraft, " +
        "ships, buoys and land stations; 3 hourly values on a 0.5 degree grid.",
        "Monthly mean and top decile, direction rose in 12 sectors of 30 degrees, daily cycle by 3 hour " +
        "slot of the local solar day, El Nino and La Nina split by NOAA ONI phase."]);
    }
    rows.push(["Water depth and contours",
      "ETOPO 2022 Global Relief Model, NOAA NCEI; Natural Earth 1:10m bathymetry for the world-scale contours",
      "Compiled bathymetry: ship soundings and multibeam surveys, gravity-derived depths from satellite " +
      "altimetry, coastal lidar; 15 arc second grid.",
      "Depth at the data point from a 0.1 degree block mean, fine contours chosen from the depths in view, " +
      "depth bands at world scale; the depth the current profile and the tidal bottom-metre figure use."]);
    rows.push(["Coastline",
      "GSHHG (Wessel and Smith, 1996) at close zoom, Natural Earth 1:50m land at world scale",
      "Digitised shorelines from the World Vector Shoreline and World Data Bank II, made hierarchical and self consistent.",
      "Map drawing at every zoom and the land test that cuts pipelines to their offshore runs."]);
    if (state.curAttribution) {
      rows.push(["Tidal streams",
        "Copernicus Marine global hourly merged surface currents, barotropic tidal component",
        "Global tide model solution constrained by satellite altimetry and tide gauges, hourly on a 1/12 degree grid.",
        "Harmonic analysis of 90 days with six constituents and nodal factors; springs and neaps from a 35 day " +
        "reconstruction; slack and turn statistics; surface and bottom-metre values through the 1/7 power " +
        "profile of DNVGL-RP-C205."]);
      rows.push(["Background currents",
        "GLORYS12 ocean reanalysis, Mercator Ocean International via the Copernicus Marine Service",
        "1/12 degree ocean model reanalysis assimilating satellite sea level and sea surface temperature, sea ice, " +
        "and in situ temperature and salinity profiles from Argo floats, moorings and ships; daily means at six depths.",
        "Median and top decile speed per month at the surface and at the deepest modelled level that is wet; " +
        "the circulation term of the combined current profile."]);
    }
    if (state.cycAttribution) {
      rows.push(["Tropical cyclones",
        "IBTrACS v04 best tracks, NOAA NCEI, satellite era",
        "Agency best tracks compiled from satellite imagery, aircraft reconnaissance, radar and surface " +
        "observations, with positions and winds every 6 hours.",
        "Storm months and storm days inside fixed rings of the point, the strongest category on record " +
        "inside each ring, and the track drawing on the map."]);
    }
    if (state.assetsAttribution) {
      rows.push(["Oil and gas assets",
        "Regulator registers (BSEE and BOEM, Norwegian Offshore Directorate, Geoscience Australia, ANP and " +
        "others), Global Energy Monitor trackers, OpenStreetMap",
        "Operator filings and surveyed positions held by the regulators; public records compiled by the " +
        "trackers; volunteer mapping from imagery and surveys in OpenStreetMap.",
        "Merged with regulator records winning, wells and platforms collapsed per 2 km cell, pipelines " +
        "deduplicated within their corridor and cut to offshore runs; the in-service filter reads each " +
        "register's own status words."]);
    }
    return rows;
  }

  function renderSourcesTable() {
    var box = $("tm-sources-table");
    if (!box) return;
    var rows = sourceRows(), tbl = document.createElement("table"), tr, th, td, i, j;
    tbl.className = "tm-src";
    tr = document.createElement("tr");
    ["Data", "Source", "How it is collected or produced", "How we use it"].forEach(function (hd) {
      th = document.createElement("th");
      th.textContent = hd;
      tr.appendChild(th);
    });
    tbl.appendChild(tr);
    for (i = 0; i < rows.length; i++) {
      tr = document.createElement("tr");
      for (j = 0; j < rows[i].length; j++) {
        td = document.createElement("td");
        td.textContent = rows[i][j];
        tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    box.innerHTML = "";
    box.appendChild(tbl);
  }

  function updateAttribution() {
    $("tm-attribution").textContent = allSources();
    renderSourcesTable();
  }

  function assetsHaveWells() {
    var d = state.assetsData, i;
    if (!d) return false;
    for (i = 0; i < d.assets.length; i++) if (d.assets[i].t === "well") return true;
    return false;
  }

  function assetsHaveLng() {
    var d = state.assetsData, i;
    if (!d) return false;
    for (i = 0; i < d.assets.length; i++) if (d.assets[i].t === "lng terminal") return true;
    return false;
  }

  /* Sticky answer bar. The values are written whenever the headline is, and
     visibility is driven by whether the hero headline is still on screen, so
     the bar only ever appears once the real one has scrolled away. */
  function setStickyAnswer(pct, txt) {
    var p = $("tm-sticky-pct"), t = $("tm-sticky-txt");
    if (!p || !t) return;
    p.textContent = pct;
    t.textContent = txt;
  }

  function initStickyAnswer() {
    var bar = $("tm-sticky"), head = $("tm-headline"), btn = $("tm-sticky-pdf");
    if (!bar || !head) return;
    if (btn) {
      btn.addEventListener("click", function () {
        var real = $("tm-pdf");
        if (real) real.click();
      });
    }
    /* No IntersectionObserver (old Safari) means no bar, which is a fair
       degradation: the page reads exactly as it did before. */
    if (!window.IntersectionObserver) return;
    new window.IntersectionObserver(function (entries) {
      var e = entries[0];
      var resultsUp = !$("tm-results").hidden;
      bar.hidden = !resultsUp || e.isIntersecting;
    }, { threshold: 0 }).observe(head);
  }

  function setBanner() {
    var el = $("tm-banner");
    /* In live mode the page carries no data banner: every source is listed
       once, at the foot of the page (Ben, 1 Sep 26). The DEMO banner stays -
       it warns that the numbers are synthetic, which is a safety notice, not
       a source listing. */
    if (state.isDemo) {
      el.hidden = false;
      el.className = "tm-banner";
      el.textContent = "Demonstration data. The numbers below are synthetic placeholders so you " +
        "can try the tool; the production version runs on ERA5 reanalysis statistics.";
    } else {
      el.hidden = true;
      el.textContent = "";
    }
    $("tm-disclaimer").textContent = (state.isDemo ? cfg.disclaimerDemo + " " : "") + cfg.disclaimerLive +
      " Asset positions and depth bands are indicative, never for navigation.";
    $("tm-terms").textContent = cfg.termsNote;
    updateAttribution();
  }

  /* ---------- selection + results ---------- */

  function onSelect(lat, lon) {
    /* a stale manual-entry echo would misdescribe the new point */
    $("tm-goto-msg").textContent = "";
    state.selected = { lat: lat, lon: lon };
    state.map.setSelection(lat, lon, null);
    $("tm-hint").textContent = "Loading statistics...";
    state.provider.query(lat, lon).then(function (res) {
      state.cellData = res;
      state.map.setSelection(lat, lon, { lat: res.cell.lat, lon: res.cell.lon, res: res.cell.res });
      $("tm-hint").style.display = "none";
      renderResults();
      var results = $("tm-results");
      if (results.dataset.scrolled !== "1") {
        results.dataset.scrolled = "1";
        results.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }).catch(function (err) {
      state.cellData = null;
      $("tm-hint").style.display = "";
      $("tm-hint").textContent = (err && err.message) ? err.message : "No data near that point.";
      $("tm-results").hidden = true;
      $("tm-side-results").hidden = true;
    });
  }

  function fmtLimitPct(lim) {
    var s2 = D.fmtPct(lim.p);
    if (lim.floor && s2.charAt(0) !== "<") s2 = "<" + s2;
    return s2.replace("<", "< ");
  }

  function limitValue() {
    var v = parseFloat($("tm-limit").value);
    if (isNaN(v) || v <= 0) v = cfg.limitDefault;
    return Math.min(15, Math.max(0.25, v));
  }

  /* Display cut: the threshold table and the curve's x axis stop at 6 m -
     operational planning stops well below that and the higher rows read
     <0.1% almost everywhere (Ben, 31 Aug 26). The DATA keeps every
     threshold: interpolation and extremes use the full arrays, and a user
     limit above 6 m extends the cut so its own row and marker stay
     visible. */
  var SHOW_HS_MAX = 6;

  function dispCut() {
    var t = state.provider.thresholds;
    var lim = Math.max(SHOW_HS_MAX, state.limit || 0);
    var n = 0;
    while (n < t.length && t[n] < lim - 0.001) n++;
    if (n < t.length) n++;   /* include the first threshold at or above the limit */
    return n;
  }

  function renderResults() {
    if (!state.cellData) return;
    state.limit = limitValue();
    var res = state.cellData;
    var sel = monthIdxList();
    var results = $("tm-results");
    results.hidden = false;
    $("tm-side-results").hidden = false;
    /* a new site changes which storms count as "near here" */
    if (state.applyTrackFilter) state.applyTrackFilter();

    var combined = D.combineMonths(res, sel, state.provider.thresholds);
    var lim = D.interpExceedance(state.provider.thresholds, combined.p, state.limit);

    /* location + basis lines */
    $("tm-loc").textContent = "Location " + D.fmtLatLon(state.selected.lat, state.selected.lon);
    var basis = "Data point " + D.fmtLatLon(res.cell.lat, res.cell.lon) +
      " (" + res.cell.res + "\u00B0 grid), " + res.distanceKm + " km from your click \u00B7 " +
      state.provider.meta.sourceLabel + ", " + state.provider.meta.period;
    if (combined.nTotal > 0) basis += " \u00B7 " + combined.nTotal.toLocaleString() + " samples";
    $("tm-basis").textContent = basis;

    /* depth + nearest asset context line: exact ETOPO depth when deployed,
       Natural Earth band as the fallback */
    var ctxParts = [];
    var cellKey = res.cell.lat + "," + res.cell.lon;
    var depthTxt = null;
    if (state.depthExact && state.depthExact.key === cellKey) {
      if (state.depthExact.val) {
        /* trim any trailing parenthetical so the inline mention does not nest
           brackets; the footer attribution keeps the full wording */
        var dsl = state.depthExact.val.sourceLabel.replace(/\s*\([^)]*\)\s*$/, "");
        depthTxt = "about " + state.depthExact.val.m.toLocaleString() + " m (" + dsl + ")";
      }
    } else if (cfg.dataBase !== null) {
      state.depthExact = { key: cellKey, val: null };
      D.depthExactAt(cfg.dataBase, res.cell.lat, res.cell.lon).then(function (v) {
        state.depthExact = { key: cellKey, val: v };
        if (v && v.attribution && !state.depthAttribution) {
          state.depthAttribution = v.attribution;
          updateAttribution();
        }
        if (v && state.cellData) renderResults();
      });
    }
    if (!depthTxt) {
      var band = D.depthBandAt(res.cell.lat, res.cell.lon);
      if (band) {
        depthTxt = (band.label.indexOf(" to ") > 0 ? "roughly " : "") + band.label +
          " (Natural Earth bathymetry)";
      } else if (!state.bathyFailed) {
        ensureBathy().then(function () {
          if (state.cellData) renderResults();
        }).catch(function () { state.bathyFailed = true; });
      }
    }
    state.lastDepth = depthTxt;
    if (depthTxt) ctxParts.push("Water depth at data point: " + depthTxt);
    state.lastNearest = null;
    if (state.assetsData) {
      var near = D.nearestAsset(state.assetsData.assets, res.cell.lat, res.cell.lon, 400);
      if (near) {
        state.lastNearest = near.asset.n + " (" + (near.asset.t || "asset") +
          (near.asset.d ? ", ~" + near.asset.d.toLocaleString() + " m water" : "") + "), " +
          near.km + " km away";
        ctxParts.push("Nearest mapped asset: " + state.lastNearest);
      }
    }
    $("tm-context").textContent = ctxParts.join("  \u00B7  ");

    /* prevailing conditions: typical peak period + modal wave direction.
       Hidden when the loaded tiles carry no period/direction fields. */
    var prevEl = $("tm-prevailing");
    var prev = D.prevailing(res, combined.usedMonths.length ? combined.usedMonths : sel);
    state.lastPrevailing = null;
    prevEl.hidden = true;
    if (prev && sel.length) {
      var bits = [];
      /* Mean Hs FIRST. The map has carried a "Mean Hs" colour scale from the
         start, but clicking a point never gave the number the scale is about
         (Ben, 1 Sep 26). It is the plainest fact about a site and it was the
         one thing missing. Sample-weighted across the selected months, so a
         part-month never counts as a whole one. */
      var mSum = 0, mN = 0, mi2, mm;
      for (mi2 = 0; mi2 < sel.length; mi2++) {
        mm = res.mean ? res.mean[sel[mi2]] : null;
        if (mm !== null && mm !== undefined && res.n[sel[mi2]] > 0) {
          mSum += mm * res.n[sel[mi2]];
          mN += res.n[sel[mi2]];
        }
      }
      state.lastMeanHs = mN ? mSum / mN : null;
      if (state.lastMeanHs !== null) {
        bits.push("mean significant wave height " + state.lastMeanHs.toFixed(1) + " m");
      }
      var dirIdx = bits.length;
      if (prev.dirName) {
        bits.push("waves most often from the " + prev.dirName +
          (prev.dirPct ? " (about " + Math.round(prev.dirPct) + "% of the time)" : ""));
      }
      if (prev.tp !== null) bits.push("typical peak period " + prev.tp.toFixed(1) + " s");
      if (bits.length) {
        state.lastPrevailing = bits.join(", ");
        prevEl.hidden = false;
        prevEl.innerHTML = "";
        prevEl.appendChild(document.createTextNode("Prevailing conditions " + monthsLabel() + ": "));
        /* The arrow shows which way the waves TRAVEL, so it belongs against
           the direction phrase. With mean Hs added in front of that phrase it
           was left stranded at the head of the sentence, pointing at a number
           it says nothing about. */
        var lead = bits.slice(0, dirIdx).join(", ");
        var rest = bits.slice(dirIdx).join(", ");
        if (lead) prevEl.appendChild(document.createTextNode(lead + (rest ? ", " : "")));
        if (rest && prev.dirDeg !== null) {
          var arrow = document.createElement("span");
          arrow.className = "tm-dir-arrow";
          arrow.textContent = "\u2192";
          /* dirDeg is where waves come FROM; the arrow shows travel direction */
          arrow.style.transform = "rotate(" + (prev.dirDeg + 90) + "deg)";
          prevEl.appendChild(arrow);
          prevEl.appendChild(document.createTextNode(" "));
        }
        prevEl.appendChild(document.createTextNode((rest || lead) + "."));
      }
    }

    /* extreme sea states: annual percentile levels + the statistically
       roughest calendar month. Site facts, independent of the selection. */
    var extEl = $("tm-extremes");
    var ext = D.extremesSummary(res, sel);
    state.lastExtremes = null;
    extEl.hidden = true;
    if (ext) {
      var eb = [];
      if (ext.allP99 !== null) {
        eb.push("1 sea state in 100 here is above " + ext.allP99.toFixed(1) + " m" +
          (ext.allP999 !== null ? " and 1 in 1000 above " + ext.allP999.toFixed(1) + " m" : "") +
          " (3 hour samples, all year)");
      }
      if (ext.roughMonth !== null) {
        eb.push("statistically the roughest month is " + D.MONTH_NAMES[ext.roughMonth] +
          ", when the top 1% of seas reach " + ext.roughP99.toFixed(1) + " m");
      }
      if (eb.length) {
        state.lastExtremes = "Extreme seas: " + eb.join("; ") + ".";
        extEl.hidden = false;
        extEl.textContent = state.lastExtremes;
      }
    }

    /* wind over the selected months */
    var windEl = $("tm-wind");
    var wndMonths = combined.usedMonths.length ? combined.usedMonths : sel;
    var wnd = D.windSummary(res, wndMonths);
    var wrose = sel.length ? D.aggregateRose(res.windRose, wndMonths) : null;
    state.lastWind = null;
    windEl.hidden = true;
    if (wnd && sel.length && (wnd.mean !== null || wnd.p90 !== null)) {
      var wb = [];
      if (wnd.mean !== null) {
        wb.push("typically " + wnd.mean.toFixed(1) + " m/s (" + Math.round(wnd.mean * 1.94384) + " kn)");
      }
      if (wnd.p90 !== null) {
        wb.push("top 10% above " + wnd.p90.toFixed(1) + " m/s (" + Math.round(wnd.p90 * 1.94384) + " kn)");
      }
      if (wrose) {
        wb.push("most often from the " + wrose.dirName + " (" + Math.round(wrose.dirPct) + "%)");
      }
      state.lastWind = "Wind (10 m) " + monthsLabel() + ": " + wb.join(", ") + ".";
      windEl.hidden = false;
      windEl.textContent = state.lastWind;
    }

    /* daylight: pure solar geometry at the clicked latitude */
    var dlEl = $("tm-daylight");
    state.lastDaylight = null;
    dlEl.hidden = true;
    if (sel.length) {
      var dl = D.daylightMonths(state.selected.lat);
      var loM = sel[0], hiM = sel[0], i5;
      for (i5 = 1; i5 < sel.length; i5++) {
        if (dl[sel[i5]].hours < dl[loM].hours) loM = sel[i5];
        if (dl[sel[i5]].hours > dl[hiM].hours) hiM = sel[i5];
      }
      var line;
      if (dl[hiM].hours >= 24 || dl[loM].hours <= 0) {
        line = "Daylight " + monthsLabel() + ": ranges from " + dl[loM].hours.toFixed(1) +
          " h (" + D.MONTH_NAMES[loM] + ") to " + dl[hiM].hours.toFixed(1) + " h (" +
          D.MONTH_NAMES[hiM] + "), including polar " +
          (dl[loM].hours <= 0 ? "night" : "day") + " conditions.";
      } else if (loM === hiM) {
        line = "Daylight in " + D.MONTH_NAMES[loM] + ": " + dl[loM].hours.toFixed(1) +
          " h, sun up about " + D.fmtSolarTime(dl[loM].rise) + " to " +
          D.fmtSolarTime(dl[loM].set) + " local solar time; " +
          (24 - dl[loM].hours).toFixed(1) + " h of darkness.";
      } else {
        line = "Daylight " + monthsLabel() + ": " + dl[hiM].hours.toFixed(1) + " h in " +
          D.MONTH_NAMES[hiM] + " (about " + D.fmtSolarTime(dl[hiM].rise) + " to " +
          D.fmtSolarTime(dl[hiM].set) + ") down to " + dl[loM].hours.toFixed(1) + " h in " +
          D.MONTH_NAMES[loM] + " (" + D.fmtSolarTime(dl[loM].rise) + " to " +
          D.fmtSolarTime(dl[loM].set) + "), local solar time.";
      }
      state.lastDaylight = line;
      dlEl.hidden = false;
      dlEl.textContent = line;
    }

    /* headline */
    var head = $("tm-headline");
    head.innerHTML = "";
    var big = document.createElement("span");
    big.className = "tm-big";
    var sub = document.createElement("span");
    sub.className = "tm-big-sub";
    if (lim.p === null || sel.length === 0) {
      big.textContent = "n/a";
      sub.textContent = sel.length === 0 ? "Select at least one month." : "No data for the selected months at this location.";
    } else {
      big.textContent = fmtLimitPct(lim);
      sub.textContent = "of the time, significant wave height exceeds " + state.limit +
        " m at this location " + monthsLabel() + ". That is roughly " +
        (lim.p * 0.3044).toFixed(lim.p * 0.3044 < 3 ? 1 : 0) + " days per month on average.";
    }
    head.appendChild(big);
    head.appendChild(sub);
    setStickyAnswer(big.textContent,
      (lim.p === null || sel.length === 0)
        ? sub.textContent
        : "H\u209b above " + state.limit + " m, " + monthsLabel().replace(/^Across/, "across") +
          "  \u00b7  " + D.fmtLatLon(state.selected.lat, state.selected.lon));

    /* charts */
    var nShow = dispCut();
    window.TMCharts.renderCurve($("tm-curve"), {
      thresholds: state.provider.thresholds.slice(0, nShow),
      p: combined.p.slice(0, nShow),
      limit: state.limit,
      interp: function (h) { return D.interpExceedance(state.provider.thresholds, combined.p, h); }
    });

    var monthly = [], m, one;
    for (m = 0; m < 12; m++) {
      if (res.n[m] > 0 && res.exc[m][0] !== null) {
        one = D.interpExceedance(state.provider.thresholds, res.exc[m], state.limit);
        monthly.push(one.p === null ? null : Math.round(one.p * 10) / 10);
      } else {
        monthly.push(null);
      }
    }
    $("tm-bars-title").textContent = "Time above " + state.limit + " m, by month";
    window.TMCharts.renderBars($("tm-bars"), {
      values: monthly,
      selected: state.monthsOn.slice(),
      limit: state.limit,
      monthNames: D.MONTH_NAMES
    });

    /* prevailing-conditions row: wave rose + typical peak period by month.
       Hidden entirely when the loaded data carries neither field. */
    var row2 = $("tm-row2");
    var hasTp = false, hasRose = !!(prev && prev.rose);
    if (res.tp) {
      for (m = 0; m < 12; m++) if (res.tp[m] !== null && res.tp[m] !== undefined) { hasTp = true; break; }
    }
    var tpAgg = sel.length ? D.tpHistAgg(res, sel) : null;
    state.lastTpMode = null;
    /* Cached for the PDF: the report redraws these figures, so it needs the
       same inputs the on-screen charts were given. */
    state.pdfRose = hasRose ? prev.rose : null;
    state.pdfVrose = wrose ? wrose.rose : null;
    state.pdfTpAgg = tpAgg;
    state.pdfTpMonths = tpAgg ? null : (res.tp || null);
    row2.hidden = !(hasTp || hasRose || wrose || tpAgg);
    row2.classList.toggle("tm-has-vrose", !!wrose);
    $("tm-vrose-fig").hidden = !wrose;
    if (!row2.hidden) {
      $("tm-rose-title").textContent = "Where waves come from " + monthsLabel();
      window.TMCharts.renderRose($("tm-rose"), {
        rose: hasRose ? prev.rose : null,
        names: function (deg) { return D.compassName ? D.compassName(deg) : deg + " deg"; }
      });
      if (wrose) {
        window.TMCharts.renderRose($("tm-vrose"), {
          rose: wrose.rose,
          what: "wind",
          names: function (deg) { return D.compassName ? D.compassName(deg) : deg + " deg"; }
        });
      }
      if (tpAgg) {
        /* the distribution replaced the monthly-median line (Ben, 30 Aug
           26): a median hides the sea/swell split, the histogram shows it.
           Old tile sets without the field fall back to the median chart. */
        $("tm-tp-title").textContent = "Peak period, % of time in each band " + monthsLabel();
        $("tm-tp-note").hidden = false;
        window.TMCharts.renderTpHist($("tm-tp"), tpAgg);
        var moLo = tpAgg.t0 + tpAgg.modeIdx * tpAgg.step;
        var moLbl = tpAgg.modeIdx === tpAgg.nb - 1 ? moLo + " s and longer" : moLo + "-" + (moLo + tpAgg.step) + " s";
        state.lastTpMode = "Peak period " + monthsLabel() + ": most often " + moLbl +
          " (" + Math.round(tpAgg.modePct) + "% of the time).";
      } else {
        $("tm-tp-title").textContent = "Typical peak period, by month";
        $("tm-tp-note").hidden = true;
        window.TMCharts.renderTpMonths($("tm-tp"), {
          values: res.tp || [null, null, null, null, null, null, null, null, null, null, null, null],
          selected: state.monthsOn.slice(),
          monthNames: D.MONTH_NAMES
        });
      }
    }

    /* holistic row: weather windows + current and tide. The currents value
       comes embedded in demo results, or from the optional cur/ tile set
       (fetched once per cell, re-render when it lands). */
    var curVal = null;
    /* joint Hs x Tp: one fetch per cell, re-render on arrival */
    state.jointKey = cellKey;
    if (!(state.jointFetch && state.jointFetch.key === cellKey) && cfg.dataBase !== null) {
      state.jointFetch = { key: cellKey, val: null };
      D.jointAt(cfg.dataBase, res.cell.lat, res.cell.lon).then(function (v) {
        if (state.jointFetch && state.jointFetch.key !== cellKey) return;
        state.jointFetch = { key: cellKey, val: v };
        renderScatter();
      });
    }
    renderScatter();

    if (res.cur) {
      curVal = res.cur;
    } else if (state.curFetch && state.curFetch.key === cellKey) {
      curVal = state.curFetch.val;
    } else if (cfg.dataBase !== null) {
      state.curFetch = { key: cellKey, val: null };
      D.curAt(cfg.dataBase, res.cell.lat, res.cell.lon).then(function (v) {
        state.curFetch = { key: cellKey, val: v };
        if (v && v.attribution && state.curAttribution !== v.attribution) {
          state.curAttribution = v.attribution;
          updateAttribution();
        }
        if (v && state.cellData) renderResults();
      });
    }
    var curSum = curVal ? D.curSummary(curVal, sel.length ? sel : monthIdxList()) : null;
    var haveWin = !!(res.windows && res.windows.runs);
    var row3 = $("tm-row3");
    row3.hidden = !(haveWin || curSum);
    $("tm-win-fig").hidden = !haveWin;
    $("tm-cur-fig").hidden = !curSum;
    row3.classList.toggle("tm-solo", !(haveWin && curSum));
    state.lastWindows = null;
    state.lastCur = null;
    if (haveWin) renderWindowsPanel(res, sel);
    if (curSum) {
      var siteDepth = (state.depthExact && state.depthExact.key === cellKey &&
        state.depthExact.val) ? state.depthExact.val.m : null;
      var wndCur = D.windSummary(res, sel.length ? sel : monthIdxList());
      renderCurPanel(curSum, siteDepth, wndCur ? wndCur.p90 : null);
    }

    /* tropical cyclone exposure: embedded in demo results, fetched from the
       optional cyc/ tile set on live data */
    var cycVal = null;
    if (res.cyc) {
      cycVal = res.cyc;
    } else if (state.cycFetch && state.cycFetch.key === cellKey) {
      cycVal = state.cycFetch.val;
    } else if (cfg.dataBase !== null) {
      state.cycFetch = { key: cellKey, val: null };
      D.cycAt(cfg.dataBase, res.cell.lat, res.cell.lon).then(function (v) {
        state.cycFetch = { key: cellKey, val: v };
        if (v && v.attribution && state.cycAttribution !== v.attribution) {
          state.cycAttribution = v.attribution;
          updateAttribution();
        }
        if (v && !v.none && state.cellData) renderResults();
      });
    }
    state.lastCyc = null;
    var row4 = $("tm-row4");
    row4.hidden = !(cycVal && !cycVal.none);
    if (!row4.hidden) renderCycPanel(cycVal, sel);

    /* El Nino / La Nina phase display: PARKED (Ben, 30 Aug 26). The
       three-column table read as homework; the datasets keep accumulating
       and shipping the phase fields on every build, so flipping SHOW_ENSO
       brings it straight back - ideally rebuilt as the scenario switch
       described in the README ("ENSO panel parked"). */
    state.lastEnso = null;
    if (SHOW_ENSO) {
      var ensoW = sel.length ? D.ensoSummary(res, sel, state.provider.thresholds, state.limit) : null;
      var ensoC = null;
      if (cycVal && !cycVal.none && cycVal.enso && sel.length) {
        var riE = Math.min(state.cycR === null ? cycVal.radii.length - 1 : state.cycR,
          cycVal.radii.length - 1);
        ensoC = D.cycEnsoSummary(cycVal, sel, riE);
      }
      renderEnsoPanel(ensoW, ensoC,
        (cycVal && !cycVal.none) ? cycVal.radii : null);
    } else {
      $("tm-rowe").hidden = true;
    }

    /* across the day: local-solar diurnal cycle of Hs and wind */
    var di = D.diurnalSummary(res, sel.length ? sel : monthIdxList());
    state.lastDiurnal = null;
    var rowd = $("tm-rowd");
    rowd.hidden = !di;
    if (di) renderDiurnalPanel(di, sel.length ? sel : monthIdxList());

    /* table */
    var tbl = $("tm-table");
    var html = "<thead><tr><th>H<sub>s</sub> threshold</th><th>% of time above</th><th>approx days per month</th></tr></thead><tbody>";
    var i, pv, cls;
    for (i = 0; i < nShow; i++) {
      pv = combined.p[i];
      cls = Math.abs(state.provider.thresholds[i] - state.limit) < 0.001 ? " class=\"tm-row-limit\"" : "";
      html += "<tr" + cls + "><td>" + state.provider.thresholds[i].toFixed(1) + " m</td>";
      if (pv === null) {
        html += "<td>no data</td><td>-</td>";
      } else {
        html += "<td>" + D.fmtPct(pv).replace("<", "&lt;") + "</td>" +
          "<td>" + (pv * 0.3044).toFixed(pv * 0.3044 < 3 ? 1 : 0) + "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody>";
    tbl.innerHTML = html;

    $("tm-pdf").disabled = (lim.p === null || sel.length === 0);
    state.lastCombined = combined;
    state.lastLimitP = lim;
    state.lastMonthly = monthly;
    writeUrlState();
  }

  /* ---------- weather-window + current/tide panels ---------- */

  function renderWindowsPanel(res, sel) {
    var w = res.windows;
    var selT = $("tm-win-thr"), selD = $("tm-win-dur"), i, o;
    if (!selT.options.length) {
      for (i = 0; i < w.thr.length; i++) {
        o = document.createElement("option");
        o.value = String(i);
        o.textContent = w.thr[i].toFixed(1) + " m";
        selT.appendChild(o);
      }
      for (i = 0; i < w.edges.length; i++) {
        o = document.createElement("option");
        o.value = String(i);
        o.textContent = w.edges[i] + " h";
        selD.appendChild(o);
      }
      /* defaults: threshold nearest the operational limit, 24 h duration */
      var bi = 0;
      for (i = 1; i < w.thr.length; i++) {
        if (Math.abs(w.thr[i] - state.limit) < Math.abs(w.thr[bi] - state.limit)) bi = i;
      }
      state.winThr = bi;
      var di = -1;
      for (i = 0; i < w.edges.length; i++) if (w.edges[i] === 24) di = i;
      state.winDur = di >= 0 ? di : 0;
      selT.value = String(state.winThr);
      selD.value = String(state.winDur);
    }
    if (state.winThr === null) state.winThr = 0;
    if (state.winDur === null) state.winDur = 0;
    if (state.pendingWin) {
      var pv = state.pendingWin;
      state.pendingWin = null;
      if (pv.thr !== null) {
        var bt = 0;
        for (i = 1; i < w.thr.length; i++) {
          if (Math.abs(w.thr[i] - pv.thr) < Math.abs(w.thr[bt] - pv.thr)) bt = i;
        }
        state.winThr = bt;
      }
      if (pv.dur !== null) {
        var bd = 0;
        for (i = 1; i < w.edges.length; i++) {
          if (Math.abs(w.edges[i] - pv.dur) < Math.abs(w.edges[bd] - pv.dur)) bd = i;
        }
        state.winDur = bd;
      }
      selT.value = String(state.winThr);
      selD.value = String(state.winDur);
    }
    var thr = w.thr[state.winThr], dur = w.edges[state.winDur];
    var vals = D.windowsPerMonth(res, state.winThr, state.winDur);
    state.pdfWindows = { values: vals, thr: thr, dur: dur };
    window.TMCharts.renderWindows($("tm-win"), {
      values: vals,
      selected: state.monthsOn.slice(),
      monthNames: D.MONTH_NAMES,
      thr: thr, dur: dur
    });
    var sum = 0, any = false;
    for (i = 0; i < sel.length; i++) {
      if (vals[sel[i]] !== null) { sum += vals[sel[i]]; any = true; }
    }
    var sumEl = $("tm-win-sum");
    if (any && sel.length) {
      var nTxt = sum >= 10 ? String(Math.round(sum)) : (Math.round(sum * 10) / 10).toString();
      /* the tracker cuts an unbroken calm every 240 h and counts each cut
         once, so a site that is calm nearly all the time shows about three
         spells a month by construction. Pair the count with the share of
         time below the limit and say the cut, or "38 spells" reads as
         weather at a site that has none. */
      var combW = D.combineMonths(res, sel, state.provider.thresholds);
      var aboveW = D.interpExceedance(state.provider.thresholds, combW.p, thr);
      var belowPct = (aboveW && aboveW.p !== null) ? 100 - aboveW.p : null;
      var belowTxt = belowPct === null ? ""
        : (belowPct >= 99.5
          ? " The sea is below " + thr + " m nearly all of the time in these months."
          : " The sea is below " + thr + " m about " + Math.round(belowPct) + "% of the time in these months.");
      state.lastWindows = "Weather windows " + monthsLabel() + ": a typical year gives about " +
        nTxt + " spell" + (sum === 1 ? "" : "s") + " of " + dur + " h or more below " + thr + " m." +
        belowTxt + " A calm running past 240 h is counted once per 240 h.";
      sumEl.textContent = state.lastWindows;
    } else {
      sumEl.textContent = "";
    }
  }

  function fmtSpeed(ms) {
    return ms.toFixed(2).replace(/0$/, "") + " m/s (" + (ms * 1.94384).toFixed(1) + " kn)";
  }

  /* Current profile through the water column, combined the way
     DNVGL-RP-C205 (August 2017 edition, seastate/DNVGL-RP-C205.pdf)
     describes it. Clause map, checked against the text on 3 Sep 26:
       4.1.3.3  total current = vector sum of wind generated, tidal and
                circulational currents (summed here as if aligned, the
                conservative reading)
       4.1.4.1  tidal current with depth as a power law
       4.1.4.2  wind generated current linear from z = -d0 to still water
       4.1.4.3  the combined profile, with d0 = 50 m and alpha typically 1/7
       4.1.4.4  v_wind(0) = k x U_1hour,10m, k = 0.015 to 0.03
     Implementation:
       tidal        v_t(z) = v_t(0) x ((d - z) / d)^(1/7). The surface value
                    is 8/7 x the modelled depth mean, because the 1/7 profile
                    averages to 7/8 of its surface value.
       wind         v_w(z) = k x U x (1 - z / d0) down to d0 = 50 m, zero
                    below; k = 0.03, the top of the range. U is the site's
                    P90 10 m wind over the selected months (3 hourly
                    reanalysis values sit close to hourly means).
       circulation  the GLORYS residual P90: surface value at z = 0, the
                    deepest modelled level's value at its depth, linear
                    between, held constant below.
     The modelled surface residual already holds the wind drift GLORYS
     resolves, so adding the code's wind term is conservative near the
     surface; the note under the table says so. */
  var DNV_K_WIND = 0.03, DNV_D0_WIND = 50, DNV_N001_WIND = 20;

  function curProfile(cs, depthM, windP90) {
    var t = cs.tide, b = cs.bg;
    var vt0 = (t && t.spring !== null) ? t.spring * 8 / 7 : null;
    var vw0 = (windP90 !== null && windP90 !== undefined) ? DNV_K_WIND * windP90 : null;
    var bs = (b && b.surfP90 !== null) ? b.surfP90 : null;
    var bd = (b && b.botP90 !== null && b.botDepth !== null && b.botDepth >= 1)
      ? { z: b.botDepth, v: b.botP90 } : null;
    if (vt0 === null && vw0 === null && bs === null) return null;
    var d = (depthM && depthM > 2) ? depthM : null;
    var zs = [0], cand = [5, 10, 25, 50, 100, 200], i, z, vt, vw, vc, tot, any, rows = [];
    if (d) {
      for (i = 0; i < cand.length; i++) if (cand[i] < d - 1) zs.push(cand[i]);
      zs.push(d - 1);
    }
    for (i = 0; i < zs.length; i++) {
      z = zs[i];
      vt = vt0 === null ? null : (d ? vt0 * Math.pow((d - z) / d, 1 / 7) : (z === 0 ? vt0 : null));
      vw = vw0 === null ? null : vw0 * Math.max(0, 1 - z / DNV_D0_WIND);
      vc = null;
      if (bs !== null) {
        if (bd && z >= bd.z) vc = bd.v;
        else if (bd) vc = bs + (bd.v - bs) * (z / bd.z);
        else vc = bs;
      }
      tot = 0; any = false;
      if (vt !== null) { tot += vt; any = true; }
      if (vw !== null) { tot += vw; any = true; }
      if (vc !== null) { tot += vc; any = true; }
      rows.push({ z: z, label: (d && i === zs.length - 1) ? "1 m above bed" : (z === 0 ? "Surface" : z + " m"),
                  vt: vt, vw: vw, vc: vc, tot: any ? tot : null });
    }
    return { rows: rows, vt0: vt0, vw0: vw0, windP90: windP90, d: d, hasBottom: !!bd, hasSurfBg: bs !== null };
  }

  function fmt2(v) { return v === null ? "\u2013" : v.toFixed(2); }

  function renderCurPanel(cs, depthM, windP90) {
    var box = $("tm-cur");
    box.innerHTML = "";
    var lines = [];
    if (cs.tide) {
      var t = cs.tide, chr;
      if (t.form === null) chr = null;
      else if (t.form < 0.25) chr = "semidiurnal: it peaks roughly every 6.2 hours";
      else if (t.form <= 1.5) chr = "mixed, mainly semidiurnal: peaks roughly every 6 hours, alternating stronger and weaker";
      else if (t.form <= 3) chr = "mixed, mainly diurnal: one strong and one weak peak most days";
      else chr = "diurnal: it peaks roughly every 12.4 hours";
      if (t.spring !== null) {
        /* the source statistic is the depth-mean (barotropic) stream, but
           people work at the surface or at the bed, so both are shown via
           the standard 1/7th power profile: surface = 8/7 x mean, bottom
           metre = surface x (1/depth)^(1/7) at the site depth */
        var sf = 8 / 7;
        var bf = (depthM && depthM > 2) ? sf * Math.pow(1 / depthM, 1 / 7) : null;
        lines.push("Tidal stream at the surface: typical peak about " + fmtSpeed(t.spring * sf) +
          " at springs, " + (t.neap !== null ? fmtSpeed(t.neap * sf) : "less") + " at neaps" +
          (chr ? ". The tide here is " + chr + "." : "."));
        lines.push(bf !== null
          ? "Near the seabed (bottom metre, at ~" + Math.round(depthM).toLocaleString() +
            " m depth): about " + fmtSpeed(t.spring * bf) + " at springs, " +
            (t.neap !== null ? fmtSpeed(t.neap * bf) : "less") + " at neaps."
          : "Near the seabed expect roughly two thirds of the surface stream.");
      }
      /* The emitted slack figure is the mean length of every run below
         the threshold in a 35 day reconstruction. That is a per-turn
         window only when neaps also clear the threshold; otherwise the
         runs merge into day-long neap lulls and the mean says nothing
         about a turn of the tide (it also hits the emitter's 999 cap).
         Gates use the surface-scaled speeds the reader is shown. */
      var sSpring = t.spring !== null ? t.spring * sf : null;
      var sNeap = t.neap !== null ? t.neap * sf : null;
      if (sSpring !== null && sSpring > 0.5) {
        if (t.slack50 === 0) {
          lines.push("The stream rotates rather than stopping: there is no true slack window at the turn of the tide.");
        } else if (sNeap !== null && sNeap > 0.5 && t.slack50 !== null && t.slack50 < 999) {
          lines.push("Around each turn of the tide the stream stays below 0.5 m/s (1 kn) for about " + Math.round(t.slack50) +
            " min" + (t.slack25 !== null && t.slack25 > 0 && t.slack25 < 999 ? " (below 0.25 m/s for about " + Math.round(t.slack25) + " min)" : "") + ".");
        } else if (sNeap !== null && sNeap <= 0.5) {
          lines.push("At neaps the stream stays below 0.5 m/s (1 kn) for long spells; slack windows around springs are short.");
        }
      } else if (sSpring !== null) {
        lines.push("The tidal stream rarely exceeds 0.5 m/s (1 kn) here even at peak.");
      }
      if (t.perDay !== null && t.perDay >= 1 && t.spring !== null && t.spring > 0.25) {
        lines.push("Expect about " + Math.round(t.perDay) + " slack periods per day.");
      }
    }
    if (cs.bg) {
      var b = cs.bg, bb = [];
      if (b.surfP50 !== null) {
        bb.push("typically " + fmtSpeed(b.surfP50) + " at the surface" +
          (b.surfP90 !== null ? ", top decile " + fmtSpeed(b.surfP90) : ""));
      }
      if (b.botP50 !== null && b.botDepth !== null && b.botDepth >= 1) {
        /* botDepth is the deepest model level that was wet (29 to 644 m),
           not the seabed; it can sit well above the bed, and beyond 644 m
           it always reads 644. Say which it is. */
        var deepLbl = (depthM && depthM > b.botDepth * 1.25)
          ? "at " + Math.round(b.botDepth) + " m depth (deepest modelled level; the bed is at ~" + Math.round(depthM).toLocaleString() + " m)"
          : "near the seabed (model level ~" + Math.round(b.botDepth) + " m)";
        bb.push(deepLbl + " typically " + fmtSpeed(b.botP50) +
          (b.botP90 !== null ? ", top decile " + fmtSpeed(b.botP90) : ""));
      }
      if (bb.length) {
        lines.push("Background (non tidal) current " + monthsLabel() + ": " + bb.join("; ") + ".");
      }
    }
    var i, p;
    for (i = 0; i < lines.length; i++) {
      p = document.createElement("p");
      p.textContent = lines[i];
      box.appendChild(p);
    }
    /* DNVGL-RP-C205 profile table; the PDF draws it as a table from
       state.lastCurProfile rather than as prose lines (seven extra lines
       pushed the report's last page into its footer, 3 Sep 26) */
    var prof = curProfile(cs, depthM, windP90), profLines = [];
    state.lastCurProfile = null;
    if (prof && prof.rows.length) {
      var parts = [];
      if (prof.vt0 !== null) parts.push("spring tide");
      if (prof.vw0 !== null) parts.push("P90 wind");
      if (prof.hasSurfBg) parts.push("P90 background");
      var head = "Through the water column (DNVGL-RP-C205 4.1.4.3 combination, " + parts.join(" + ") + "), m/s";
      var tbl = document.createElement("table"), tr, th, td, j, r, cols;
      tbl.className = "tm-prof";
      var cap = document.createElement("caption");
      cap.textContent = head;
      tbl.appendChild(cap);
      tr = document.createElement("tr");
      cols = ["Depth", "Tidal", "Wind-driven", "Background", "Combined"];
      for (j = 0; j < cols.length; j++) {
        th = document.createElement("th");
        th.textContent = cols[j];
        tr.appendChild(th);
      }
      tbl.appendChild(tr);
      for (i = 0; i < prof.rows.length; i++) {
        r = prof.rows[i];
        tr = document.createElement("tr");
        var cells = [r.label, fmt2(r.vt), fmt2(r.vw), fmt2(r.vc), fmt2(r.tot)];
        for (j = 0; j < cells.length; j++) {
          td = document.createElement("td");
          td.textContent = cells[j];
          tr.appendChild(td);
        }
        tbl.appendChild(tr);
      }
      box.appendChild(tbl);
      var nb = [];
      if (prof.vt0 !== null) {
        nb.push("Tidal: spring peak of the depth mean scaled to the surface (8/7) and taken down the power-law profile of 4.1.4.1 with the 1/7 exponent of 4.1.4.3" +
          (prof.d ? " at " + Math.round(prof.d).toLocaleString() + " m water depth" : " (surface only: water depth unknown here)") + ".");
      }
      if (prof.vw0 !== null) {
        nb.push("Wind-driven: 0.03 x the site's P90 10 m wind of " + prof.windP90.toFixed(1) +
          " m/s (4.1.4.4, k at the top of its 0.015 to 0.03 range), falling linearly to zero at d0 = 50 m (4.1.4.2 and 4.1.4.3); at the " + DNV_N001_WIND +
          " m/s design wind of DNV-ST-N001 11.12.2.3 the surface value would be " +
          (DNV_K_WIND * DNV_N001_WIND).toFixed(2) + " m/s.");
      }
      if (prof.hasSurfBg) {
        nb.push("Background: the modelled (GLORYS) residual P90" +
          (prof.hasBottom ? " at the surface and at the deepest modelled level, linear between and held below" : " at the surface, held through the column") +
          "; it already contains the wind drift the model resolves, so the combined column is conservative near the surface.");
      }
      nb.push("The code takes the vector sum (4.1.3.3); the components are summed here as if aligned. Climatological figures, not extreme-value design values.");
      p = document.createElement("p");
      p.className = "tm-prof-note";
      p.textContent = nb.join(" ");
      box.appendChild(p);
      state.lastCurProfile = {
        head: head,
        rows: prof.rows.map(function (rr) {
          return [rr.label, fmt2(rr.vt), fmt2(rr.vw), fmt2(rr.vc), fmt2(rr.tot)];
        }),
        cols: cols,
        note: "Tidal: 8/7 x the modelled depth mean on the 4.1.4.1 power law (exponent 1/7). " +
          (prof.vw0 !== null ? "Wind-driven: 0.03 x the P90 10 m wind of " + prof.windP90.toFixed(1) +
            " m/s (4.1.4.4), linear to zero at 50 m (4.1.4.3). " : "") +
          (prof.hasSurfBg ? "Background: modelled residual P90, surface to deepest level, held below; it already holds resolved wind drift. " : "") +
          "Summed as if aligned (the code takes the vector sum, 4.1.3.3). Climatology, not design values."
      };
    }
    state.lastCur = lines.length ? lines : null;
  }

  /* ---------- shareable URLs ----------
     Every result state gets a link that reproduces it: location, months,
     operational limit and the weather-window pickers, carried in the URL
     hash (#loc=57.00,3.00&m=5,6,7,8&h=1.5&wt=1.5&wd=24). The hash form
     survives static hosting, the Wix iframe and the single-file preview;
     ?loc=... query links are accepted on read too. */

  function buildShareString() {
    if (!state.selected) return null;
    var parts = ["loc=" + state.selected.lat.toFixed(2) + "," + state.selected.lon.toFixed(2)];
    var sel = monthIdxList();
    if (sel.length && sel.length < 12) {
      parts.push("m=" + sel.map(function (m) { return m + 1; }).join(","));
    }
    if (state.limit !== cfg.limitDefault) parts.push("h=" + state.limit);
    var res = state.cellData;
    if (res && res.windows && state.winThr !== null && state.winDur !== null) {
      parts.push("wt=" + res.windows.thr[state.winThr]);
      parts.push("wd=" + res.windows.edges[state.winDur]);
    }
    return parts.join("&");
  }

  function shareUrl() {
    var s = buildShareString();
    if (!s) return null;
    return window.location.origin === "null" || window.location.protocol === "file:"
      ? window.location.href.split("#")[0] + "#" + s
      : window.location.origin + window.location.pathname + "#" + s;
  }

  function writeUrlState() {
    var s = buildShareString();
    if (!s || s === state.lastHash) return;
    state.lastHash = s;
    try {
      window.history.replaceState(null, "", "#" + s);
    } catch (e) {
      /* very old browsers / odd embeds: the link button still works */
    }
  }

  function parseShareState() {
    var raw = window.location.hash ? window.location.hash.slice(1) : window.location.search.slice(1);
    if (!raw || raw.indexOf("loc=") < 0) return null;
    var kv = {}, parts = raw.split("&"), i, p;
    for (i = 0; i < parts.length; i++) {
      p = parts[i].split("=");
      if (p.length === 2) {
        try { kv[decodeURIComponent(p[0])] = decodeURIComponent(p[1]); }
        catch (e) { /* malformed percent-escape in a pasted link: skip that key */ }
      }
    }
    if (!kv.loc) return null;
    var ll = kv.loc.split(",");
    var lat = parseFloat(ll[0]), lon = parseFloat(ll[1]);
    if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    var out = { lat: lat, lon: lon, months: null, limit: null, wt: null, wd: null };
    if (kv.m) {
      var flags = [false, false, false, false, false, false, false, false, false, false, false, false];
      var any = false, ms = kv.m.split(","), mi, mv;
      for (mi = 0; mi < ms.length; mi++) {
        mv = parseInt(ms[mi], 10);
        if (mv >= 1 && mv <= 12) { flags[mv - 1] = true; any = true; }
      }
      if (any) out.months = flags;
    }
    if (kv.h) {
      var h = parseFloat(kv.h);
      if (!isNaN(h) && h > 0) out.limit = Math.min(15, Math.max(0.25, h));
    }
    if (kv.wt) { var wt = parseFloat(kv.wt); if (!isNaN(wt)) out.wt = wt; }
    if (kv.wd) { var wd = parseInt(kv.wd, 10); if (!isNaN(wd)) out.wd = wd; }
    return out;
  }

  function setMonths(flags) {
    var btns = $("tm-months").children, i;
    for (i = 0; i < 12; i++) {
      state.monthsOn[i] = !!flags[i];
      btns[i].setAttribute("aria-pressed", flags[i] ? "true" : "false");
    }
  }

  function applyShareState(st) {
    if (st.months) setMonths(st.months);
    if (st.limit !== null) $("tm-limit").value = String(st.limit);
    if (st.wt !== null || st.wd !== null) state.pendingWin = { thr: st.wt, dur: st.wd };
    scheduleHeat();
    var scale = Math.max(state.map.minScale || 3, state.map.cssW / 60);
    state.map.centreOn(st.lat, st.lon, scale);
    onSelect(st.lat, st.lon);
  }

  function copyShareLink() {
    var url = shareUrl();
    if (!url) return;
    var btn = $("tm-share");
    function done(ok) {
      var old = "Copy link to this result";
      btn.textContent = ok ? "Link copied" : "Copy failed: " + url;
      setTimeout(function () { btn.textContent = old; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
  }

  /* ---------- ENSO phase panel (parked; see renderResults) ---------- */

  var SHOW_ENSO = false;
  var ENSO_LABELS = ["El Niño", "Neutral", "La Niña"];

  function renderEnsoPanel(w, c, radii) {
    var row = $("tm-rowe");
    if (!w && !c) { row.hidden = true; return; }
    row.hidden = false;

    function tr(label, vals, fmt) {
      var best = -1, i, h;
      for (i = 0; i < 3; i++) {
        if (vals[i] !== null && (best < 0 || vals[i] > vals[best])) best = i;
      }
      h = "<tr><td>" + label + "</td>";
      for (i = 0; i < 3; i++) {
        h += "<td" + (i === best ? ' class="tm-enso-hi"' : "") + ">" +
          (vals[i] === null ? "-" : fmt(vals[i])) + "</td>";
      }
      return h + "</tr>";
    }

    var html = "<thead><tr><th></th><th>" + ENSO_LABELS.join("</th><th>") +
      "</th></tr></thead><tbody>";
    var radLabel = "";
    if (w) {
      html += tr("Time above " + state.limit + " m",
        [w[0].pct, w[1].pct, w[2].pct], function (v) { return v.toFixed(1) + "%"; });
      html += tr("Mean H<sub>s</sub>",
        [w[0].mean, w[1].mean, w[2].mean], function (v) { return v.toFixed(2) + " m"; });
    }
    if (c && radii) {
      var riE2 = Math.min(state.cycR === null ? radii.length - 1 : state.cycR, radii.length - 1);
      radLabel = radii[riE2].toLocaleString() + " nm";
      html += tr("Cyclone storm-days (within " + radLabel + ")",
        [c[0].days, c[1].days, c[2].days], function (v) { return String(v); });
    }
    var src = w || c;
    html += "<tr><td>Seasons in record</td><td>" + src[0].years + "</td><td>" +
      src[1].years + "</td><td>" + src[2].years + "</td></tr></tbody>";
    $("tm-enso-table").innerHTML = html;

    /* headline: name the rougher phase only when the gap is worth acting on */
    var sum = "";
    if (w && w[0].pct !== null && w[2].pct !== null) {
      var hi = w[2].pct >= w[0].pct ? 2 : 0, lo = 2 - hi;
      var rel = Math.round(100 * (w[hi].pct - w[lo].pct) / Math.max(w[lo].pct, 0.1));
      if (rel >= 10 && (w[hi].pct - w[lo].pct) >= 1) {
        sum = ENSO_LABELS[hi] + " months run rougher here " + monthsLabel() + ": " +
          w[hi].pct.toFixed(1) + "% of the time above " + state.limit + " m, against " +
          w[lo].pct.toFixed(1) + "% in " + ENSO_LABELS[lo] + " months.";
      } else {
        sum = "Little ENSO signal in the wave climate here " + monthsLabel() + ".";
      }
    }
    if (c && c[0].days !== null && c[2].days !== null && (c[0].days + c[2].days) > 0) {
      var chi = c[2].days >= c[0].days ? 2 : 0, clo = 2 - chi;
      sum += (sum ? " " : "") + "Cyclone exposure: " + c[chi].days +
        " storm-days across these months in a " + ENSO_LABELS[chi] + " year, against " +
        c[clo].days + " in " + ENSO_LABELS[clo] +
        (radLabel ? " (within " + radLabel + ")." : ".");
    }
    $("tm-enso-sum").textContent = sum;
    state.lastEnso = sum || null;
  }

  function renderCycPanel(cyc, sel) {
    state.cycData = cyc;          /* the track filter reads radii from here */
    var selR = $("tm-cyc-r"), i, o;
    if (!selR.options.length) {
      for (i = 0; i < cyc.radii.length; i++) {
        o = document.createElement("option");
        o.value = String(i);
        o.textContent = cyc.radii[i].toLocaleString() + " nm";
        selR.appendChild(o);
      }
      state.cycR = cyc.radii.length - 1;   /* the 1000 nm shutdown ring */
      selR.value = String(state.cycR);
    }
    if (state.cycR === null) state.cycR = cyc.radii.length - 1;
    var ri = Math.min(state.cycR, cyc.radii.length - 1);
    var s = D.cycSummary(cyc, sel.length ? sel : monthIdxList(), ri);
    var storms12 = cyc.storms.map(function (row) { return row[ri]; });
    state.pdfCyc = { days: s.perMonth, storms: storms12, radius: cyc.radii[ri] };
    window.TMCharts.renderCyc($("tm-cyc"), {
      days: s.perMonth,
      storms: storms12,
      selected: state.monthsOn.slice(),
      monthNames: D.MONTH_NAMES,
      radius: cyc.radii[ri]
    });
    var bits = [];
    if (s.any) {
      /* the per-month counts mark a storm once per month it is inside the
         ring, so a sum over several months counts a boundary-straddling
         storm in each: say storm-months unless the count is exact */
      var nS = s.storms >= 10 ? Math.round(s.storms) : (Math.round(s.storms * 10) / 10);
      bits.push("an average season brings " + nS +
        (s.exact ? " storm" + (s.storms === 1 ? "" : "s") : " storm-month" + (s.storms === 1 ? "" : "s")) +
        " inside " + cyc.radii[ri].toLocaleString() + " nm during these months (" +
        (Math.round(s.days * 10) / 10) + " storm-day" + (s.days === 1 ? "" : "s") +
        (s.exact ? "" : "; a storm spanning two months counts in each") + ")");
    } else {
      bits.push("no recorded storm inside " + cyc.radii[ri].toLocaleString() +
        " nm during these months");
    }
    if (s.category) {
      bits.push("strongest on record inside this ring: " + s.category +
        " (" + Math.round(s.wmax) + " kt)");
    }
    /* Outside the tropics IBTrACS is still tracking the SAME named storms,
       but by then they have gone post-tropical: the North Sea's 1.2 per
       season are recurving Atlantic hurricanes (Ophelia 2017, Katia 2011,
       Lorenzo 2019...). Calling those "tropical cyclones", and repeating
       the demob advice, would be wrong twice over - they arrive as ordinary
       deep lows whose seas are already inside the wave statistics above. */
    var cellLat = (state.cellData && state.cellData.cell) ? state.cellData.cell.lat : 0;
    var exLat = Math.abs(cellLat) > 35;
    state.lastCyc = (exLat ? "Tropical and ex-tropical cyclones "
                           : "Tropical cyclones ") + monthsLabel() + ": " +
      bits.join("; ") + ".";
    $("tm-cyc-sum").textContent = state.lastCyc;
    $("tm-cyc-note").textContent = exLat
      ? ("Named storms at tropical-storm strength or more, from best tracks "
         + "since 1980, counted for their whole life. At this latitude most "
         + "are POST-TROPICAL by the time they arrive: recurving hurricanes "
         + "that reach here as deep lows, whose seas are already counted in "
         + "the wave statistics above. Read this as how often the remains of "
         + "a named storm pass nearby, not as a demobilisation trigger.")
      : ("Named storms at tropical-storm strength or more, from best tracks "
         + "since 1980. Operations commonly begin securing and demobilising "
         + "when a cyclone is inside 1,000 nm, long before local seas respond, "
         + "so this downtime is additional to the wave statistics above.");
  }

  function diSlotLabel(s) {
    /* the emitter's slot s holds local solar times in [3s-1.5, 3s+1.5),
       i.e. centred on 3s:00, so the label names the centre hour */
    return ("0" + (s * 3)).slice(-2) + ":00";
  }

  function renderDiurnalPanel(di, sel) {
    /* shade the night hours: day-weighted mean daylight over the selection,
       symmetric about solar noon like the chart's own axis */
    var dl = D.daylightMonths(state.selected.lat), num = 0, den = 0, i;
    for (i = 0; i < sel.length; i++) {
      num += D.MONTH_DAYS[sel[i]] * dl[sel[i]].hours;
      den += D.MONTH_DAYS[sel[i]];
    }
    var hrs = den > 0 ? num / den : 12;
    state.pdfDiurnal = { hs: di.hs, wind: di.wind };
    window.TMCharts.renderDiurnal($("tm-di"), {
      hs: di.hs, wind: di.wind,
      nightRise: hrs >= 24 ? null : 12 - hrs / 2,
      nightSet: hrs >= 24 ? null : 12 + hrs / 2
    });
    var line;
    if (di.relRange < 0.06) {
      line = "Across the day " + monthsLabel() + ": no meaningful daily cycle at this " +
        "point; conditions hold around the clock.";
    } else {
      var calm = [], rough = [];
      if (di.hs && di.hs[di.calmSlot] !== null) calm.push(di.hs[di.calmSlot].toFixed(2) + " m");
      if (di.wind && di.wind[di.calmSlot] !== null) calm.push(di.wind[di.calmSlot].toFixed(1) + " m/s");
      if (di.hs && di.hs[di.roughSlot] !== null) rough.push(di.hs[di.roughSlot].toFixed(2) + " m");
      if (di.wind && di.wind[di.roughSlot] !== null) rough.push(di.wind[di.roughSlot].toFixed(1) + " m/s");
      line = "Across the day " + monthsLabel() + ": calmest around " + diSlotLabel(di.calmSlot) +
        " local (" + calm.join(", ") + "), roughest around " + diSlotLabel(di.roughSlot) +
        " (" + rough.join(", ") + ").";
    }
    state.lastDiurnal = line;
    $("tm-di-sum").textContent = line;
  }

  /* ---------- PDF ---------- */

  function buildPdf() {
    if (!state.cellData || !state.lastCombined) return;
    var btn = $("tm-pdf");
    btn.disabled = true;
    var oldLabel = btn.textContent;
    btn.textContent = "Building PDF...";
    var res = state.cellData;
    var sel = monthIdxList();
    var lim = state.lastLimitP;
    /* The PDF map was pinned at 60 degrees of longitude, which is a
       continental view: someone who had zoomed in to a field got a picture of
       half an ocean with their site as a dot. It now follows the view on
       screen, clamped so it is neither uselessly tight nor so wide the site
       disappears. Zoomed all the way in that is about 3 degrees; never
       having touched the zoom still gives the old 60. */
    var vb = state.map.viewBounds();
    var span = Math.max(1.5, Math.min(60, vb.lon1 - vb.lon0));
    var st = {
      cfg: cfg,
      meta: state.provider.meta,
      isDemo: state.isDemo,
      thresholds: state.provider.thresholds.slice(0, dispCut()),
      combined: state.lastCombined && Object.assign({}, state.lastCombined,
        { p: state.lastCombined.p.slice(0, dispCut()) }),
      monthlyAtLimit: state.lastMonthly,
      selectedFlags: state.monthsOn.slice(),
      months: sel,
      monthNames: D.MONTH_NAMES,
      limit: state.limit,
      latLonLabel: D.fmtLatLon(state.selected.lat, state.selected.lon),
      cellLabel: D.fmtLatLon(res.cell.lat, res.cell.lon) + " (" + res.cell.res + " deg grid), " +
        res.distanceKm + " km from the selected point",
      basisLabel: state.provider.meta.sourceLabel + ", " + state.provider.meta.period +
        (state.lastCombined.nTotal ? ", " + state.lastCombined.nTotal.toLocaleString() + " samples for the selected months" : ""),
      headlineBig: fmtLimitPct(lim),
      headlineSub: "of the time, significant wave height exceeds " + state.limit + " m at this location " +
        monthsLabel() + " (roughly " + (lim.p * 0.3044).toFixed(lim.p * 0.3044 < 3 ? 1 : 0) + " days per month).",
      depthLabel: state.lastDepth,
      nearestLabel: state.lastNearest ? state.lastNearest + (assetsAreDemo() ? " (DEMO asset)" : "") : null,
      meanHs: state.lastMeanHs === undefined ? null : state.lastMeanHs,
      prevailingLabel: state.lastPrevailing
        ? state.lastPrevailing.charAt(0).toUpperCase() + state.lastPrevailing.slice(1)
        : null,
      extremesLabel: state.lastExtremes,
      windLabel: state.lastWind,
      windowsLabel: state.lastWindows,
      curLines: state.lastCur,
      curProfile: state.lastCurProfile,
      cycLabel: state.lastCyc,
      diurnalLabel: state.lastDiurnal,
      ensoLabel: state.lastEnso,
      tpModeLabel: state.lastTpMode,
      daylightLabel: state.lastDaylight,
      /* Everything below drives the report's extra pages. The charts are
         redrawn from the same inputs the on-screen versions used; monthExc
         is the raw per-month exceedance matrix, which only the report
         tabulates. A null means that panel was not on screen, and the
         report skips it rather than inventing one. */
      rose: state.pdfRose || null,
      vrose: state.pdfVrose || null,
      tpAgg: state.pdfTpAgg || null,
      tpMonths: state.pdfTpMonths || null,
      windows: state.pdfWindows || null,
      cyc: state.pdfCyc || null,
      diurnal: state.pdfDiurnal || null,
      monthExc: res.exc,
      monthN: res.n,
      scatter: state.pdfScatter || null,
      allSources: allSources(),
      shareUrl: shareUrl(),
      assetsShown: !!(state.assetsData && $("tm-assets").checked),
      disclaimer: (state.isDemo ? cfg.disclaimerDemo + " " : "") + cfg.disclaimerLive,
      mapPng: state.map.snapshot(res.cell.lat, res.cell.lon, span, 420, 260)
    };
    window.TMReport.generate(st).then(function (bytes) {
      var ns = state.selected.lat >= 0 ? "N" : "S", ew = state.selected.lon >= 0 ? "E" : "W";
      var fname = "SeaState_" + Math.abs(state.selected.lat).toFixed(2) + ns + "_" +
        Math.abs(state.selected.lon).toFixed(2) + ew + ".pdf";
      window.TMReport.deliver(bytes, fname, cfg.pdfDelivery);
      btn.textContent = oldLabel;
      btn.disabled = false;
    }).catch(function (err) {
      btn.textContent = oldLabel;
      btn.disabled = false;
      alert("PDF failed: " + (err && err.message ? err.message : err));
    });
  }

  /* ---------- boot ---------- */

  function boot(provider, isDemo) {
    state.provider = provider;
    state.isDemo = isDemo;
    setBanner();
    initStickyAnswer();
    var link = $("tm-cta-link");
    link.href = cfg.website;
    link.textContent = "Talk to us at " + cfg.website.replace(/^https?:\/\//, "");
    /* Exposed for diagnosis on the live site, and so tests can ask the map
       where something is instead of guessing pixel coordinates. Read-only by
       convention: nothing in the app reads it back. */
    window.TM_MAP = null;
    state.map = new window.TMMap($("tm-map"), {
      onSelect: onSelect,
      onHover: function (ll) {
        var c = $("tm-coords");
        if (!ll) { c.hidden = true; return; }
        c.hidden = false;
        c.textContent = D.fmtLatLon(ll.lat, ll.lon);
      },
      onMeasure: function (mi) {
        var out = $("tm-measure-out");
        if (!mi) {
          out.hidden = true;
          out.innerHTML = "";
          return;
        }
        out.hidden = false;
        out.innerHTML = "<b>" + mi.label + "</b>" +
          '<span class="tm-meas-sub">' + Math.round(mi.bearing) + "\u00b0 true  \u00b7  " +
          D.fmtLatLon(mi.a.lat, mi.a.lon) + "  to  " + D.fmtLatLon(mi.b.lat, mi.b.lon) +
          (mi.fixed ? "" : "  \u00b7  click to fix") + "</span>";
      },
      onDragMode: function (mode) {
        $("tm-zoom-win").setAttribute("aria-pressed", mode === "zoomwin" ? "true" : "false");
        $("tm-measure").setAttribute("aria-pressed", mode === "measure" ? "true" : "false");
        /* The hint used to be HIDDEN in measure mode, which removed the only
           thing on screen telling you what to do with the tool you just
           armed. It now says what to do instead. */
        if (mode === "measure") {
          $("tm-hint").hidden = false;
          $("tm-hint").textContent = "Click two points to measure. Drag to pan. Escape to finish.";
        } else {
          $("tm-hint").hidden = false;
          $("tm-hint").textContent = "Click the map to choose a location";
        }
      },
      onView: function () {
        /* legend zoom hints track visibility flips only */
        var wv = state.map ? state.map.wellsVisible() : false;
        var pv = state.map ? state.map.pipesVisible() : false;
        var dv = (state.map && $("tm-contours").checked) ? state.map.depthsInView().join(",") : "";
        if (wv !== state.wellsShown || pv !== state.pipesShown || dv !== state.depthsShown) {
          state.wellsShown = wv;
          state.pipesShown = pv;
          state.depthsShown = dv;
          refreshLegend();
        }
        if (state.map && state.map.hdWanted()) ensureCoastHD();
        refreshFineContours();
      }
    });
    if (window.TM_PLACES) state.map.setPlaces(window.TM_PLACES);
    window.TM_MAP = state.map;
    $("tm-zoom-in").addEventListener("click", function () { state.map.zoomStep(2.0); });
    $("tm-zoom-out").addEventListener("click", function () { state.map.zoomStep(1 / 2.0); });
    $("tm-measure").addEventListener("click", function () {
      var on = $("tm-measure").getAttribute("aria-pressed") !== "true";
      if (on) state.map.setZoomWindowMode(false);   /* the two modes are exclusive */
      state.map.setMeasureMode(on);
    });
    $("tm-zoom-win").addEventListener("click", function () {
      if ($("tm-measure").getAttribute("aria-pressed") === "true") state.map.setMeasureMode(false);
      state.map.setZoomWindowMode($("tm-zoom-win").getAttribute("aria-pressed") !== "true");
    });
    buildMonthChips();
    $("tm-limit").addEventListener("change", renderResults);
    $("tm-limit").addEventListener("input", function () { clearTimeout(state.limTimer); state.limTimer = setTimeout(renderResults, 250); });

    $("tm-win-thr").addEventListener("change", function () {
      state.winThr = parseInt(this.value, 10) || 0;
      renderResults();
    });
    $("tm-win-dur").addEventListener("change", function () {
      state.winDur = parseInt(this.value, 10) || 0;
      renderResults();
    });
    $("tm-cyc-r").addEventListener("change", function () {
      state.cycR = parseInt(this.value, 10) || 0;
      renderResults();
      if (state.applyTrackFilter) state.applyTrackFilter();
    });
    $("tm-shade").addEventListener("change", refreshHeat);
    $("tm-pdf").addEventListener("click", buildPdf);

    $("tm-contours").addEventListener("change", function () {
      if (!$("tm-contours").checked) {
        state.map.setBathy(null, false);
        refreshLegend();
        return;
      }
      ensureBathy().then(function (levels) {
        state.map.setBathy(levels, $("tm-contours").checked);
        refreshLegend();
      }).catch(function () {
        state.bathyFailed = true;
        $("tm-contours").checked = false;
        refreshLegend();
      });
    });

    $("tm-assets").addEventListener("change", function () {
      state.map.setAssets(null, $("tm-assets").checked);
      refreshLegend();
    });

    /* historical cyclone tracks: an off-by-default map layer. Tracks load
       lazily on the first tick (demo: synthetic parabolas; live: the
       cyc/tracks.json emitted alongside the exposure tiles). */
    function ensureCycTracks() {
      if (state.cycTracksLoaded) return Promise.resolve(true);
      if (state.isDemo) {
        state.map.setCycTracks(D.demoCycTracks());
        state.cycTracksLoaded = true;
        return Promise.resolve(true);
      }
      return fetch(vurl(cfg.dataBase + "cyc/tracks.json")).then(function (r) {
        if (!r.ok) throw new Error("no cyc tracks");
        return r.json();
      }).then(function (doc) {
        var trks = D.decodeCycTracks(doc);
        if (!trks.length) return false;
        state.map.setCycTracks(trks);
        state.cycTracksLoaded = true;
        if (doc.attribution && state.cycAttribution !== doc.attribution) {
          state.cycAttribution = doc.attribution;
          updateAttribution();
        }
        return true;
      }).catch(function () { return false; });
    }

    /* Track filters. Forty-odd years of tracks at once is a smear (4,170 on
       the real set), and most of them never came near the site being looked
       at. The default filter is therefore the operational one: only storms
       that passed within the exposure ring chosen in the cyclone panel.
       Year range and a severe-only tick narrow it further. IBTrACS tracks
       carry no month, so months are deliberately not offered here. */
    function trackRadiusNm() {
      var cyc = state.cycData;
      if (!cyc || !cyc.radii || !cyc.radii.length) return 1000;
      var ri = (state.cycR === null || state.cycR === undefined)
        ? cyc.radii.length - 1 : Math.min(state.cycR, cyc.radii.length - 1);
      return cyc.radii[ri];
    }

    function trackNearNm(track, lat, lon) {
      var best = 1e9, i, p, dlat, dlon, d;
      var kx = Math.cos(lat * Math.PI / 180) * 60;
      for (i = 0; i < track.pts.length; i++) {
        p = track.pts[i];
        dlat = (p[0] - lat) * 60;
        dlon = p[1] - lon;
        while (dlon < -180) dlon += 360;
        while (dlon > 180) dlon -= 360;
        dlon *= kx;
        d = dlat * dlat + dlon * dlon;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    }

    function applyTrackFilter() {
      if (!state.cycTracksLoaded || !state.map) return;
      var ctl = $("tm-ct-ctl");
      var on = $("tm-cyctracks").checked;
      ctl.hidden = !on;
      if (!on) return;
      var cell = state.cellData && state.cellData.cell;
      var nearBox = $("tm-ct-near");
      $("tm-ct-near-lab").hidden = !cell;
      var near = !!cell && nearBox.checked;
      var radius = trackRadiusNm();
      var y0 = parseInt($("tm-ct-y0").value, 10);
      var y1 = parseInt($("tm-ct-y1").value, 10);
      if (isNaN(y0)) y0 = -9999;
      if (isNaN(y1)) y1 = 9999;
      var major = $("tm-ct-major").checked;
      var total = (state.map.cycTracksAll || []).length;
      var kept = state.map.setCycTrackFilter(function (t) {
        if (t.y < y0 || t.y > y1) return false;
        if (major && t.w < 96) return false;
        if (near && trackNearNm(t, cell.lat, cell.lon) > radius) return false;
        return true;
      });
      /* update only a text span: rebuilding the label's children moved the
         checkbox mid-interaction and swallowed the untick */
      $("tm-ct-near-r").textContent = radius.toLocaleString() + " nm";
      $("tm-ct-count").textContent =
        "showing " + kept.toLocaleString() + " of " + total.toLocaleString() + " storms" +
        (near ? " within " + radius.toLocaleString() + " nm" : "");
    }
    state.applyTrackFilter = applyTrackFilter;

    function seedTrackYears() {
      var all = state.map.cycTracksAll || [];
      if (!all.length || $("tm-ct-y0").value) return;
      var lo = 9999, hi = -9999, i;
      for (i = 0; i < all.length; i++) {
        if (all[i].y < lo) lo = all[i].y;
        if (all[i].y > hi) hi = all[i].y;
      }
      $("tm-ct-y0").value = String(lo);
      $("tm-ct-y1").value = String(hi);
      $("tm-ct-y0").min = $("tm-ct-y1").min = String(lo);
      $("tm-ct-y0").max = $("tm-ct-y1").max = String(hi);
    }

    ["tm-ct-near", "tm-ct-major"].forEach(function (id) {
      $(id).addEventListener("change", applyTrackFilter);
    });
    ["tm-ct-y0", "tm-ct-y1"].forEach(function (id) {
      $(id).addEventListener("change", applyTrackFilter);
      $(id).addEventListener("input", function () {
        clearTimeout(state.ctTimer);
        state.ctTimer = setTimeout(applyTrackFilter, 250);
      });
    });

    $("tm-cyctracks").addEventListener("change", function () {
      var box = this;
      if (box.checked && !state.cycTracksLoaded) {
        ensureCycTracks().then(function (ok) {
          if (!ok) box.checked = false;
          state.map.setCycTracksVisible(box.checked);
          seedTrackYears();
          applyTrackFilter();
          refreshLegend();
        });
        return;
      }
      state.map.setCycTracksVisible(box.checked);
      seedTrackYears();
      applyTrackFilter();
      refreshLegend();
    });

    if (state.isDemo) {
      $("tm-cyctracks-label").hidden = false;
    } else if (cfg.dataBase !== null) {
      D.cycManifest(cfg.dataBase).then(function (mf) {
        if (mf && mf.tracks) $("tm-cyctracks-label").hidden = false;
      });
    }

    /* asset market filters (type / in-service / water depth / free text).
       Applied to the drawn layer and hover only; the nearest-asset context
       line stays on the full set. Depth limits hide assets with no known
       depth by design.

       "In service only" (DEFAULT ON) hides wells that were drilled but never
       put to work: the registers are dominated by wildcats, appraisals and
       plugged holes. A well counts as in service when its status says
       producing / injecting / development / completed / operating /
       suspended / shut-in; abandoned, plugged, junked, dry and
       exploration-purpose wells do not, and neither does a well whose
       register carries no usable status (untick the box to see everything). */
    var WELL_INACTIVE_RX = /abandon|plug|p&a|paa|junk|dry|cancel|wildcat|apprais|explor|soil|stratigraphic/;
    var WELL_ACTIVE_RX = /produc|inject|develop|operat|online|in service|active|completed|suspend|shut|drill/;

    function wellInService(a) {
      var s = (a.s || "").toLowerCase();
      if (WELL_INACTIVE_RX.test(s)) return false;
      return WELL_ACTIVE_RX.test(s);
    }

    function applyAssetFilter() {
      var wantW = $("tm-f-wells").checked, wantP = $("tm-f-plats").checked, wantF = $("tm-f-fields").checked;
      var wantL = $("tm-f-lng").checked;
      var activeOnly = $("tm-f-active").checked;
      var dmin = parseFloat($("tm-f-dmin").value), dmax = parseFloat($("tm-f-dmax").value);
      var txt = $("tm-f-text").value.trim().toLowerCase();
      var useDepth = !isNaN(dmin) || !isNaN(dmax);
      var all = wantW && wantP && wantF && wantL && !activeOnly && !useDepth && !txt;
      function fn(a) {
        var isW = a.t === "well", isP = (a.t || "").indexOf("platform") >= 0;
        var isL = a.t === "lng terminal";
        if (isW && !wantW) return false;
        if (isP && !wantP) return false;
        if (isL && !wantL) return false;
        if (!isW && !isP && !isL && !wantF) return false;
        if (isW && activeOnly && !wellInService(a)) return false;
        if (useDepth) {
          if (!a.d) return false;
          if (!isNaN(dmin) && a.d < dmin) return false;
          if (!isNaN(dmax) && a.d > dmax) return false;
        }
        if (txt) {
          var hay = (a.n + " " + (a.s || "") + " " + (a.o || "")).toLowerCase();
          if (hay.indexOf(txt) < 0) return false;
        }
        return true;
      }
      state.map.setAssetFilter(all ? null : fn);
      var el = $("tm-f-count");
      if (all) { el.textContent = ""; return; }
      var n2 = 0, i2, list = state.assetsData.assets;
      for (i2 = 0; i2 < list.length; i2++) if (fn(list[i2])) n2++;
      el.textContent = n2.toLocaleString() + " of " + list.length.toLocaleString() + " match";
    }

    var fltIds = ["tm-f-wells", "tm-f-active", "tm-f-plats", "tm-f-fields", "tm-f-lng", "tm-f-dmin", "tm-f-dmax", "tm-f-text"];
    for (var fi = 0; fi < fltIds.length; fi++) {
      $(fltIds[fi]).addEventListener("input", function () {
        clearTimeout(state.fltTimer);
        state.fltTimer = setTimeout(applyAssetFilter, 200);
      });
    }

    $("tm-f-pipes").addEventListener("change", function () {
      state.map.setLinesVisible(this.checked);
      refreshLegend();
    });

    loadAssetsData().then(function (d) {
      if (!d || d.format !== 1 || !d.assets || !d.assets.length) return;
      state.assetsData = d;
      $("tm-assets-toggle").hidden = false;
      $("tm-asset-filters").hidden = false;
      state.map.setAssets(d.assets, $("tm-assets").checked);
      applyAssetFilter();   /* the in-service default is ON, so filter at load */
      if (d.lines && d.lines.length) {
        state.assetLines = D.decodeAssetLines(d.lines);
        state.map.setAssetLines(state.assetLines);
        $("tm-f-pipes-label").hidden = false;
      }
      if (assetsHaveLng()) $("tm-f-lng-label").hidden = false;
      var att = [], i;
      for (i = 0; i < d.sources.length; i++) {
        if (d.sources[i].attribution && att.indexOf(d.sources[i].attribution) < 0) {
          att.push(d.sources[i].attribution);
        }
      }
      state.assetsAttribution = att.join(" ");
      updateAttribution();
      refreshLegend();
      if (state.cellData) renderResults();
    }).catch(function () { /* no assets file deployed: layer stays hidden */ });

    /* warm the depth data so the first click can state a depth band */
    setTimeout(function () { ensureBathy().catch(function () { state.bathyFailed = true; }); }, 2500);

    refreshHeat();

    /* manual position entry: parse, run the exact same path as a map click,
       then echo the interpretation in the OTHER notation so a misread is
       visible (typed decimal -> shown DDM, and vice versa) */
    function goToPosition() {
      var msg = $("tm-goto-msg");
      var r = D.parseLatLon($("tm-goto-in").value);
      if (r.error) {
        msg.className = "tm-goto-msg tm-goto-err";
        msg.textContent = r.error;
        return;
      }
      var scale = Math.max(state.map.minScale || 3, state.map.cssW / 60);
      state.map.centreOn(r.lat, r.lon, scale);
      onSelect(r.lat, r.lon);
      msg.className = "tm-goto-msg";
      msg.textContent = "Read as " + D.fmtDDM(r.lat, r.lon) + " = " +
        r.lat.toFixed(4) + ", " + r.lon.toFixed(4) + " decimal, WGS84";
    }
    $("tm-goto-btn").addEventListener("click", goToPosition);
    $("tm-goto-in").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); goToPosition(); }
    });

    /* shared links: apply an inbound #loc=... (or ?loc=...) state, follow
       hash edits in an open tab, and wire the copy button */
    $("tm-share").addEventListener("click", copyShareLink);
    window.addEventListener("hashchange", function () {
      var frag = window.location.hash.slice(1);
      if (frag === state.lastHash) return;   /* our own replaceState echo */
      var st = parseShareState();
      if (st) applyShareState(st);
    });
    var st0 = parseShareState();
    if (st0) applyShareState(st0);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var useDemo = function () { boot(new D.DemoProvider(), true); };
    if (cfg.dataBase === null) { useDemo(); return; }
    var tp;
    try {
      tp = new D.TileProvider(cfg.dataBase);
      /* two-argument then: only a FAILED manifest load falls back to the
         demo; an exception inside boot() itself surfaces in the console
         instead of silently booting a second, synthetic app on top */
      tp.ready.then(function () { boot(tp, tp.meta.source === "DEMO"); }, useDemo);
    } catch (e) {
      useDemo();
    }
  });
})();
