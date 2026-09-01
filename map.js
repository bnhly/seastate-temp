/* Sea State Explorer - self contained canvas world map.
   Web-Mercator projection (conformal, like every nautical chart and web map),
   drag pan, wheel / pinch zoom, click to select.
   Land drawn from window.TM_COAST (Natural Earth 50m, embedded, public domain),
   swapping to the lazy-loaded 10m set once zoomed in.
   No external tiles, no network: works inside any iframe / offline / preview page. */
(function () {
  "use strict";

  var HEAT_RES = 0.5; /* deg per heat texel (matches the ERA5 grid) */
  var HEAT_MAX = 6; /* m at top of colour ramp */
  var HEAT_STOPS = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

  function hex2rgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  var HEAT_RGB = HEAT_STOPS.map(hex2rgb);

  function heatColor(v) {
    var t = Math.max(0, Math.min(1, v / HEAT_MAX));
    var x = t * (HEAT_RGB.length - 1);
    var i = Math.min(HEAT_RGB.length - 2, Math.floor(x));
    var f = x - i, a = HEAT_RGB[i], b = HEAT_RGB[i + 1];
    return [
      Math.round(a[0] + f * (b[0] - a[0])),
      Math.round(a[1] + f * (b[1] - a[1])),
      Math.round(a[2] + f * (b[2] - a[2]))
    ];
  }

  function wrapDelta(d) {
    while (d < -180) d += 360;
    while (d >= 180) d -= 360;
    return d;
  }

  /* Web-Mercator vertical, in "degree units" (dy/dlat = 1 at the equator) so
     view.scale keeps meaning px per degree of LONGITUDE everywhere. Conformal:
     local shapes are right at every latitude, which the plain equirectangular
     map was not (land looked stretched ~2x wide at North Sea latitudes). */
  var MERC_LAT_MAX = 85.05113;
  function mercY(lat) {
    var la = Math.max(-MERC_LAT_MAX, Math.min(MERC_LAT_MAX, lat));
    return (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360));
  }
  function invMercY(y) {
    return (360 / Math.PI) * Math.atan(Math.exp(y * Math.PI / 180)) - 90;
  }
  var MERC_Y_MAX = mercY(MERC_LAT_MAX);

  /* Squared distance from a point to a segment, plus the closest point on
     it. Squared because nothing here needs the root, and hover runs this
     over every segment of every candidate line on each mouse move. */
  function segDist2(mx, my, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((mx - x1) * dx + (my - y1) * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return { d2: (mx - cx) * (mx - cx) + (my - cy) * (my - cy), x: cx, y: cy };
  }


  /* ---------- measuring ------------------------------------------------
     Great-circle distance and initial bearing. The drawn line is straight in
     screen space, which on Mercator is a rhumb line rather than the great
     circle being measured; over the ranges this tool is for (confirming a
     position, spacing between two points on a field) the two are visually
     the same, and the number reported is the great circle. */
  function geoDist(a, b) {
    var R = 6371.0088, d2r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * d2r, dLon = (b.lon - a.lon) * d2r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function geoBearing(a, b) {
    var d2r = Math.PI / 180;
    var y = Math.sin((b.lon - a.lon) * d2r) * Math.cos(b.lat * d2r);
    var x = Math.cos(a.lat * d2r) * Math.sin(b.lat * d2r) -
      Math.sin(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.cos((b.lon - a.lon) * d2r);
    return (Math.atan2(y, x) / d2r + 360) % 360;
  }

  /* Nautical miles first: this is a marine tool and a mile is the unit the
     numbers get quoted in. Kilometres alongside, and metres when the two
     points are close enough that a mile reads as zero. */
  function measureLabel(km) {
    var nm = km / 1.852;
    if (km < 1) return Math.round(km * 1000) + " m  \u00b7  " + nm.toFixed(2) + " nm";
    if (km < 100) return km.toFixed(2) + " km  \u00b7  " + nm.toFixed(2) + " nm";
    return Math.round(km).toLocaleString() + " km  \u00b7  " + Math.round(nm).toLocaleString() + " nm";
  }

  /* ---------- hover callouts -------------------------------------------
     One box, three optional lines, used by every hover type so they cannot
     drift apart in style. Clamped to the canvas so a callout near an edge
     stays readable. */
  function drawTip(ctx, cssW, ax, ay, l1, l2, l3) {
    ctx.font = "600 12px system-ui, sans-serif";
    var w1 = ctx.measureText(l1 || "").width;
    ctx.font = "11px system-ui, sans-serif";
    var w2 = Math.max(l2 ? ctx.measureText(l2).width : 0, l3 ? ctx.measureText(l3).width : 0);
    var rows = 1 + (l2 ? 1 : 0) + (l3 ? 1 : 0);
    var bw = Math.max(w1, w2) + 18, bh = 10 + rows * 14;
    var bx = Math.min(cssW - bw - 6, Math.max(6, ax + 12));
    var by = Math.max(6, ay - bh - 10);
    ctx.fillStyle = "rgba(252, 252, 251, 0.97)";
    ctx.strokeStyle = "rgba(11, 11, 11, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6); else ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#0b0b0b";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(l1 || "", bx + 9, by + 16);
    ctx.fillStyle = "#52514e";
    ctx.font = "11px system-ui, sans-serif";
    if (l2) ctx.fillText(l2, bx + 9, by + 30);
    if (l3) ctx.fillText(l3, bx + 9, by + 44);
  }

  /* Registers vary in what they carry. GA/NOPTA pipelines mostly arrive with
     no name at all, so the heading falls back to the operator before the
     generic word, and a line with nothing but geometry says so plainly
     rather than showing an empty box. */
  function lineTipText(ln) {
    var named = ln.n && ln.n.toLowerCase() !== "pipeline";
    var head = named ? ln.n : (ln.o || "Pipeline");
    var bits = [];
    if (named && ln.o) bits.push(ln.o);
    if (ln.s) bits.push(ln.s);
    if (ln.c) bits.push(ln.c);
    var sub = bits.join(" \u00B7 ");
    return [head, "Pipeline" + (sub ? ", " + sub : ""),
            (!named && !ln.o && !ln.s) ? "No further detail in the register" : ""];
  }

  /* Saffir-Simpson from one-minute sustained wind, which is what IBTrACS
     max wind is reported as. Below 64 kt it is not a hurricane, so it is
     named by stage rather than given a category. */
  function cycCategory(kt) {
    if (!(kt > 0)) return "";
    if (kt >= 137) return "Category 5";
    if (kt >= 113) return "Category 4";
    if (kt >= 96) return "Category 3";
    if (kt >= 83) return "Category 2";
    if (kt >= 64) return "Category 1";
    if (kt >= 34) return "Tropical storm strength";
    return "Below tropical storm strength";
  }

  function trackTipText(tr) {
    var name = tr.n && String(tr.n).toUpperCase() !== "NOT_NAMED" ? tr.n : "Unnamed storm";
    var bits = [];
    /* IBTrACS names already carry the season ("Amy 1980"), so repeating it
       underneath reads as a mistake. */
    if (tr.y && name.indexOf(String(tr.y)) < 0) bits.push(String(tr.y));
    if (tr.y && name.indexOf(String(tr.y)) >= 0 && !bits.length) bits.push("season " + tr.y);
    var cat = cycCategory(tr.w);
    if (cat) bits.push(cat);
    return [name, bits.join(" \u00B7 "),
            tr.w ? "Peak " + Math.round(tr.w) + " kt (" + Math.round(tr.w * 1.852) + " km/h) over its life" : ""];
  }


  function TMMap(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts || {};
    this.view = { cLon: 15, cLat: 5, scale: 3 };
    this.selection = null;   /* {lat, lon} clicked point */
    this.cellRect = null;    /* {lat, lon, res} data cell */
    this.heatCanvas = null;
    this.bathyPaths = null;  /* [{d, path, alpha, w}] built by setBathy */
    this.bathyOn = false;
    this.assets = null;      /* [{n,t,s,c,la,lo}] */
    this.assetsOn = false;
    this.hoverAsset = null;
    this.dragMode = "pan";   /* "pan" | "zoomwin" (one-shot rubber-band zoom) */
    this.zoomDrag = null;    /* {x0, y0, x1, y1} while a zoom box is being drawn */
    this.landPath = this.buildLandPath();
    this.bordersPath = this.buildBordersPath();
    this.pointers = {};
    this.bindEvents();
    this.resize();
    var self = this;
    if (window.ResizeObserver) {
      new ResizeObserver(function () { self.resize(); }).observe(canvas.parentNode);
    } else {
      window.addEventListener("resize", function () { self.resize(); });
    }
  }

  /* All geographic Path2Ds are built in (lon, mercY) space and drawn with one
     linear transform per frame. */
  function pathFromRings(rings, close) {
    var p = new Path2D(), r, i, ring;
    for (r = 0; r < rings.length; r++) {
      ring = rings[r];
      p.moveTo(ring[0][0], mercY(ring[0][1]));
      for (i = 1; i < ring.length; i++) p.lineTo(ring[i][0], mercY(ring[i][1]));
      if (close) p.closePath();
    }
    return p;
  }

  TMMap.prototype.buildLandPath = function () {
    return pathFromRings(window.TM_COAST || [], true);
  };

  /* High-detail coastline, tiled (web/coast/). Only the DRAWN land swaps;
     the 50m set stays the data layer. Each tile holds one fill Path2D
     (rings clipped to the tile, seams butt invisibly) and one stroke
     Path2D (original coast only, so tile-edge cuts are never outlined).
     Tiles draw only when every visible manifest tile is loaded and the
     visible vertex total fits the budget; otherwise the 50m coast draws,
     which is also what active gestures always use. */
  TMMap.prototype.setCoastMeta = function (mf) {
    this.coastMeta = mf;
    this.coastTiles = {};
    this.coastPending = {};
    this.render();
  };

  TMMap.prototype.coastScale = function () {
    return (this.coastMeta && this.coastMeta.scale) || 1000;
  };

  TMMap.prototype.markCoastTilePending = function (id) {
    if (!this.coastPending) this.coastPending = {};
    this.coastPending[id] = true;
  };

  TMMap.prototype.addCoastTile = function (id, fillRings, strokeLines) {
    if (!this.coastTiles) this.coastTiles = {};
    this.coastTiles[id] = {
      fill: pathFromRings(fillRings, true),
      stroke: pathFromRings(strokeLines, false)
    };
    this.render();
  };

  TMMap.prototype.visibleCoastIds = function (view) {
    var v = view || this.view;
    var t = (this.coastMeta && this.coastMeta.tile_deg) || 15;
    var halfW = this.cssW / (2 * v.scale);
    var latTop = invMercY(mercY(v.cLat) + this.cssH / (2 * v.scale));
    var latBot = invMercY(mercY(v.cLat) - this.cssH / (2 * v.scale));
    var ids = [], seen = {}, ti, tj, lon0, lat0, id;
    var ti0 = Math.floor((v.cLon - halfW) / t), ti1 = Math.floor((v.cLon + halfW) / t);
    var tj0 = Math.floor(latBot / t), tj1 = Math.floor(latTop / t);
    for (ti = ti0; ti <= ti1; ti++) {
      lon0 = ((ti * t + 180) % 360 + 360) % 360 - 180;
      for (tj = tj0; tj <= tj1; tj++) {
        lat0 = tj * t;
        if (lat0 < -90 || lat0 >= 90) continue;
        id = "c_" + lat0 + "_" + lon0;
        if (!seen[id]) { seen[id] = true; ids.push(id); }
      }
    }
    return ids;
  };

  TMMap.prototype.coastTilesWanted = function () {
    if (!this.coastMeta || this.view.scale < HD_COAST_SCALE) return [];
    var ids = this.visibleCoastIds(), out = [], i, id;
    for (i = 0; i < ids.length; i++) {
      id = ids[i];
      if (this.coastMeta.tiles[id] !== undefined &&
          !this.coastTiles[id] && !(this.coastPending && this.coastPending[id])) {
        out.push(id);
      }
    }
    return out;
  };

  /* The loaded tiles covering this view, or null to draw the 50m coast. */
  TMMap.prototype.readyCoastTiles = function (view) {
    if (!this.coastMeta || view.scale < HD_COAST_SCALE) return null;
    var ids = this.visibleCoastIds(view), out = [], total = 0, i, id, npts;
    for (i = 0; i < ids.length; i++) {
      id = ids[i];
      npts = this.coastMeta.tiles[id];
      if (npts === undefined) continue;        /* open-ocean tile: no file */
      if (!this.coastTiles[id]) return null;   /* still loading: stay 50m */
      total += npts;
      out.push(this.coastTiles[id]);
    }
    if (!out.length || total > HD_PTS_BUDGET) return null;
    return out;
  };

  TMMap.prototype.hdWanted = function () {
    return this.view.scale >= HD_COAST_SCALE;
  };

  /* Country borders (polylines, never closed). null when borders.js is absent. */
  TMMap.prototype.buildBordersPath = function () {
    var lines = window.TM_BORDERS || [];
    return lines.length ? pathFromRings(lines, false) : null;
  };

  TMMap.prototype.resize = function () {
    var el = this.canvas, w = el.parentNode.clientWidth, h = el.parentNode.clientHeight;
    if (!w || !h) return;
    this.cssW = w; this.cssH = h;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(w * this.dpr);
    el.height = Math.round(h * this.dpr);
    this.minScale = w / 360;
    if (this.view.scale < this.minScale) this.view.scale = this.minScale;
    this.clampLat();
    this.render();
  };

  TMMap.prototype.clampLat = function () {
    var half = this.cssH / (2 * this.view.scale);
    if (half >= MERC_Y_MAX) { this.view.cLat = 0; return; }
    var y = mercY(this.view.cLat);
    if (y + half > MERC_Y_MAX) y = MERC_Y_MAX - half;
    if (y - half < -MERC_Y_MAX) y = -MERC_Y_MAX + half;
    this.view.cLat = invMercY(y);
  };

  /* Programmatic view move (shared links): centre on a point at a given
     px-per-degree-longitude scale. */
  TMMap.prototype.centreOn = function (lat, lon, scale) {
    if (scale) this.view.scale = Math.max(this.minScale || 0.001, Math.min(MAX_SCALE, scale));
    this.view.cLon = wrapDelta(lon);
    this.view.cLat = Math.max(-MERC_LAT_MAX, Math.min(MERC_LAT_MAX, lat));
    this.clampLat();
    this.render();
  };

  TMMap.prototype.lonToX = function (lon, view) {
    var v = view || this.view;
    return this.cssW / 2 + wrapDelta(lon - v.cLon) * v.scale;
  };
  TMMap.prototype.latToY = function (lat, view) {
    var v = view || this.view;
    return this.cssH / 2 - (mercY(lat) - mercY(v.cLat)) * v.scale;
  };
  TMMap.prototype.pointToLatLon = function (x, y) {
    var v = this.view;
    var lat = invMercY(mercY(v.cLat) + (this.cssH / 2 - y) / v.scale);
    var lon = v.cLon + (x - this.cssW / 2) / v.scale;
    return { lat: Math.max(-90, Math.min(90, lat)), lon: wrapDelta(lon) };
  };

  TMMap.prototype.setHeatField = function (fn) {
    if (!fn) { this.heatCanvas = null; this.render(); return; }
    var nlon = Math.round(360 / HEAT_RES), nlat = Math.round(180 / HEAT_RES);
    var vals = new Float32Array(nlon * nlat), row, col, lat, lon, v, i;
    for (row = 0; row < nlat; row++) {
      lat = 90 - HEAT_RES * (row + 0.5);
      for (col = 0; col < nlon; col++) {
        lon = -180 + HEAT_RES * (col + 0.5);
        v = fn(lat, lon);
        vals[row * nlon + col] = (v === null || v === undefined || isNaN(v)) ? NaN : v;
      }
    }
    /* Bleed values into empty texels (3 passes of 8-neighbour averaging,
       ~1.5 deg reach) so the shading runs under the drawn coastline instead
       of leaving pale notches where coastal cells have no data. Land texels
       are covered by the land fill; large no-data regions (polar ice) stay
       clear beyond the bleed rim. */
    var src = vals, out, pass, sum, cnt, dr, dc, rr, cc, vv;
    for (pass = 0; pass < 3; pass++) {
      out = new Float32Array(src);
      for (row = 0; row < nlat; row++) {
        for (col = 0; col < nlon; col++) {
          i = row * nlon + col;
          if (!isNaN(src[i])) continue;
          sum = 0; cnt = 0;
          for (dr = -1; dr <= 1; dr++) {
            rr = row + dr;
            if (rr < 0 || rr >= nlat) continue;
            for (dc = -1; dc <= 1; dc++) {
              cc = (col + dc + nlon) % nlon;
              vv = src[rr * nlon + cc];
              if (!isNaN(vv)) { sum += vv; cnt++; }
            }
          }
          if (cnt) out[i] = sum / cnt;
        }
      }
      src = out;
    }
    /* colormap into a MERCATOR-warped canvas (rows spaced in merc y, each row
       sampling its latitude's value row) so rendering stays one linear
       drawImage per frame */
    var nrows = 720;
    var cv = document.createElement("canvas");
    cv.width = nlon; cv.height = nrows;
    var cx = cv.getContext("2d");
    var img = cx.createImageData(nlon, nrows), c, o, orow, srow, lat2;
    for (orow = 0; orow < nrows; orow++) {
      lat2 = invMercY(MERC_Y_MAX - (orow + 0.5) / nrows * 2 * MERC_Y_MAX);
      srow = Math.max(0, Math.min(nlat - 1, Math.floor((90 - lat2) / HEAT_RES)));
      for (col = 0; col < nlon; col++) {
        v = src[srow * nlon + col];
        o = (orow * nlon + col) * 4;
        if (isNaN(v)) {
          img.data[o + 3] = 0;
        } else {
          c = heatColor(v);
          img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
          img.data[o + 3] = 235;
        }
      }
    }
    cx.putImageData(img, 0, 0);
    this.heatCanvas = cv;
    this.render();
  };

  /* Depth contour display: levels come from TMData.bathyLevels(). Only some
     depths are DRAWN (200 / 1000 / 3000); the rest serve the click lookup. */
  var BATHY_STYLE = { 200: { a: 0.55, w: 1.3 }, 1000: { a: 0.4, w: 1 }, 3000: { a: 0.26, w: 1 } };
  var WELL_MIN_SCALE = 8; /* px per degree below which well markers hide */
  var HD_COAST_SCALE = 16; /* px per degree past which coast tiles engage */
  var HD_PTS_BUDGET = 90000; /* max visible tile vertices before 50m wins */
  /* Pipelines used to hide below scale 4, but the map OPENS at scale 3, so
     they were invisible until you zoomed, which read as "the pipelines never
     arrived". Measured at the default view with 29,269 lines: 5.4 ms with
     them against 7.6 ms without, both inside one frame, so the threshold was
     not earning its place. Kept low rather than removed so a deliberate zoom
     right out does not draw a hairball. */
  var PIPE_MIN_SCALE = 1.6; /* px per degree below which pipelines hide */
  var MAX_SCALE = 2000;   /* px per degree: about 0.5 deg, or 50 km, across a
                             desktop view. Raised from 320 (Ben, 1 Sep 26) now
                             that the map carries real infrastructure: platform
                             and pipeline positions are precise and reward the
                             zoom even though the 0.5 deg wave cells and the
                             1:10m coastline behind them do not. */

  TMMap.prototype.setBathy = function (levels, show) {
    if (levels && !this.bathyPaths) {
      this.bathyPaths = [];
      var i, st;
      for (i = 0; i < levels.length; i++) {
        st = BATHY_STYLE[levels[i].d];
        if (!st) continue;
        this.bathyPaths.push({ d: levels[i].d, path: pathFromRings(levels[i].rings, false),
          alpha: st.a, w: st.w, rings: levels[i].rings, bboxes: levels[i].bboxes });
      }
    }
    this.bathyOn = !!show && !!this.bathyPaths;
    this.render();
  };

  TMMap.prototype.setPlaces = function (places) {
    this.places = places || null;
    this.render();
  };

  TMMap.prototype.setAssets = function (assets, show) {
    if (assets) this.assets = assets;
    this.assetsOn = !!show && !!(this.assets && this.assets.length);
    this.hoverAsset = null;
    this.render();
  };

  /* Predicate applied to every asset before drawing and hover (the market
     filter row). null = show everything. */
  TMMap.prototype.setAssetFilter = function (fn) {
    this.assetFilter = fn || null;
    this.hoverAsset = null;
    this.render();
  };

  /* Pipelines: decoded [{pts:[[lat,lon],...]}], one merc-space Path2D. */
  /* Bounding box per line, in lat/lon, computed once. Hover has to answer
     "which of 29,000 pipelines is under the cursor" on every mouse move; a
     box test rejects nearly all of them before any real distance maths. */
  function bboxLines(lines) {
    var out = [], i, k, pts, la0, la1, lo0, lo1;
    for (i = 0; i < (lines || []).length; i++) {
      pts = lines[i].pts;
      if (!pts || pts.length < 2) continue;
      la0 = la1 = pts[0][0]; lo0 = lo1 = pts[0][1];
      for (k = 1; k < pts.length; k++) {
        if (pts[k][0] < la0) la0 = pts[k][0];
        if (pts[k][0] > la1) la1 = pts[k][0];
        if (pts[k][1] < lo0) lo0 = pts[k][1];
        if (pts[k][1] > lo1) lo1 = pts[k][1];
      }
      out.push({ ln: lines[i], la0: la0, la1: la1, lo0: lo0, lo1: lo1 });
    }
    return out;
  }

  TMMap.prototype.setAssetLines = function (lines) {
    var p = new Path2D(), i, k, pts;
    for (i = 0; i < (lines || []).length; i++) {
      pts = lines[i].pts;
      p.moveTo(pts[0][1], mercY(pts[0][0]));
      for (k = 1; k < pts.length; k++) p.lineTo(pts[k][1], mercY(pts[k][0]));
    }
    this.assetLinesBox = bboxLines(lines);
    this.assetLinesPath = (lines && lines.length) ? p : null;
    this.linesOn = this.linesOn === undefined ? true : this.linesOn;
    this.render();
  };

  /* Nearest polyline within HIT_PX of the cursor, or null. Two stages: a
     lat/lon box test to throw out nearly everything, then a real
     point-to-segment distance in SCREEN space, because the tolerance the
     user feels is in pixels, not degrees. Returns the line and the point on
     it nearest the cursor, so the callout can anchor to the line itself. */
  var HIT_PX = 7;

  TMMap.prototype.hitLine = function (boxes, mx, my) {
    var self = this, i, b, k, pts, best = HIT_PX * HIT_PX, hit = null, at = null;
    /* the box test needs a degree padding equal to HIT_PX on screen */
    var padLon = (HIT_PX + 2) / this.view.scale;
    var c = this.pointToLatLon(mx, my);
    if (!c) return null;
    var padLat = padLon / Math.max(0.15, Math.cos(c.lat * Math.PI / 180));
    for (i = 0; i < boxes.length; i++) {
      b = boxes[i];
      if (c.lat < b.la0 - padLat || c.lat > b.la1 + padLat) continue;
      if (c.lon < b.lo0 - padLon || c.lon > b.lo1 + padLon) continue;
      pts = b.ln.pts;
      var px = self.lonToX(pts[0][1]), py = self.latToY(pts[0][0]), qx, qy;
      for (k = 1; k < pts.length; k++) {
        qx = self.lonToX(pts[k][1]); qy = self.latToY(pts[k][0]);
        var r = segDist2(mx, my, px, py, qx, qy);
        if (r.d2 < best) { best = r.d2; hit = b.ln; at = { x: r.x, y: r.y }; }
        px = qx; py = qy;
      }
    }
    return hit ? { ln: hit, at: at } : null;
  };

  /* The corners of the current view, in degrees. */
  TMMap.prototype.viewBounds = function () {
    var a = this.pointToLatLon(0, 0), b = this.pointToLatLon(this.cssW, this.cssH);
    var lonSpan = this.cssW / this.view.scale;
    return {
      lat0: Math.min(a.lat, b.lat), lat1: Math.max(a.lat, b.lat),
      lon0: this.view.cLon - lonSpan / 2, lon1: this.view.cLon + lonSpan / 2,
      whole: lonSpan >= 360
    };
  };

  /* Which drawn contour depths actually cross the current view. The legend
     used to list 200 / 1,000 / 3,000 m always, so on a shelf where only the
     200 m line exists it named two depths that were nowhere on screen.

     This tests ring VERTICES, not ring bounding boxes. A single 3,000 m ring
     spans 109 degrees of longitude, so its box overlaps almost any view and a
     box test answers "yes" everywhere, which is what the first attempt did.
     Boxes still serve as a cheap reject before the vertex scan, and the scan
     stops at the first vertex inside, so the common case is fast. */
  TMMap.prototype.depthsInView = function () {
    if (!this.bathyOn || !this.bathyPaths) return [];
    var v = this.viewBounds(), out = [], i, k, j, bb, lv, ring, halfW, hit;
    halfW = this.cssW / this.view.scale / 2;
    for (i = 0; i < this.bathyPaths.length; i++) {
      lv = this.bathyPaths[i];
      hit = false;
      for (k = 0; k < (lv.rings || []).length && !hit; k++) {
        bb = lv.bboxes[k];
        if (bb[3] < v.lat0 || bb[1] > v.lat1) continue;
        ring = lv.rings[k];
        for (j = 0; j < ring.length; j++) {
          /* rings are [lon, lat] */
          if (ring[j][1] < v.lat0 || ring[j][1] > v.lat1) continue;
          if (!v.whole && Math.abs(wrapDelta(ring[j][0] - this.view.cLon)) > halfW) continue;
          hit = true;
          break;
        }
      }
      if (hit) out.push(lv.d);
    }
    return out;
  };

  TMMap.prototype.setLinesVisible = function (on) {
    this.linesOn = !!on;
    this.render();
  };

  /* Historical cyclone tracks: two Path2Ds (below / at-or-above Cat 3) so
     forty years of tracks read as a density map with the majors standing
     out. tracks: [{w (max kt), pts: [[lat, lon], ...]}] */
  TMMap.prototype.setCycTracks = function (tracks) {
    this.cycTracksAll = tracks || [];
    this.buildCycPaths();
  };

  /* Forty-odd years of tracks drawn at once is a smear (4,170 of them on the
     real IBTrACS set), so the drawn set is filtered by the caller: keep(track)
     returns true for the ones to show. Returns how many were kept. */
  TMMap.prototype.setCycTrackFilter = function (keep) {
    this.cycKeep = keep || null;
    return this.buildCycPaths();
  };

  TMMap.prototype.buildCycPaths = function () {
    var tracks = this.cycTracksAll || [];
    var minor = new Path2D(), major = new Path2D(), i, k, pts, p, kept = 0, shown = [];
    for (i = 0; i < tracks.length; i++) {
      if (this.cycKeep && !this.cycKeep(tracks[i])) continue;
      pts = tracks[i].pts;
      if (!pts || pts.length < 2) continue;
      kept += 1;
      shown.push(tracks[i]);
      p = tracks[i].w >= 96 ? major : minor;
      p.moveTo(pts[0][1], mercY(pts[0][0]));
      for (k = 1; k < pts.length; k++) p.lineTo(pts[k][1], mercY(pts[k][0]));
    }
    /* Hit-test only what is actually drawn, so a filtered-out storm can
       never be labelled. Built from the same loop for that reason. */
    this.cycShownBox = bboxLines(shown);
    this.cycMinorPath = kept ? minor : null;
    this.cycMajorPath = kept ? major : null;
    this.render();
    return kept;
  };

  TMMap.prototype.setCycTracksVisible = function (on) {
    this.cycTracksOn = !!on;
    this.render();
  };

  TMMap.prototype.pipesVisible = function () {
    return this.view.scale >= PIPE_MIN_SCALE;
  };

  TMMap.prototype.setSelection = function (lat, lon, cellRect) {
    this.selection = (lat === null) ? null : { lat: lat, lon: lon };
    this.cellRect = cellRect || null;
    this.render();
  };

  TMMap.prototype.gratStep = function (scale) {
    var steps = [30, 15, 10, 5, 2, 1, 0.5, 0.25], i;
    for (i = steps.length - 1; i >= 0; i--) {
      if (steps[i] * scale >= 55) return steps[i];
    }
    return 30;
  };

  /* Renders coalesce onto animation frames: wheel and drag events arrive
     faster than the map can draw once the HD coastline is in, and drawing
     each one synchronously is what made fast zooming freeze. */
  TMMap.prototype.render = function () {
    if (this.rafPending) return;
    var self = this;
    this.rafPending = true;
    var raf = window.requestAnimationFrame || function (f) { setTimeout(f, 16); };
    raf(function () {
      self.rafPending = false;
      self.renderTo(self.ctx, self.cssW, self.cssH, self.dpr, self.view, true);
      if (self.opts.onView) self.opts.onView();
    });
  };

  /* Active gesture flag: while zooming or panning, renderTo draws the light
     50m coastline and skips nothing else; 180 ms after the last movement the
     HD coastline snaps back in. The 412k-point HD path is why a per-tick
     full draw could not keep up. */
  TMMap.prototype.touchInteract = function () {
    var self = this;
    this.interacting = true;
    clearTimeout(this.interactTimer);
    this.interactTimer = setTimeout(function () {
      self.interacting = false;
      self.render();
    }, 180);
  };

  TMMap.prototype.wellsVisible = function () {
    return this.view.scale >= WELL_MIN_SCALE;
  };

  TMMap.prototype.renderTo = function (ctx, cssW, cssH, dpr, view, withChrome) {
    if (!cssW || !cssH) return;
    var self = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#e6edf4";
    ctx.fillRect(0, 0, cssW, cssH);

    var shifts = [-360, 0, 360], s, shift, x0, y0;

    function lonToX(lon) { return cssW / 2 + wrapDelta(lon - view.cLon) * view.scale; }
    function latToY(lat) { return cssH / 2 - (mercY(lat) - mercY(view.cLat)) * view.scale; }

    /* heat layer (bilinear-smoothed; texels are pre-bled so the smoothing
       never blends toward transparent at the coast) */
    if (this.heatCanvas) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      for (s = 0; s < shifts.length; s++) {
        shift = shifts[s];
        x0 = cssW / 2 + ((-180 + shift) - view.cLon) * view.scale;
        y0 = latToY(90);
        if (x0 > cssW || x0 + 360 * view.scale < 0) continue;
        ctx.drawImage(this.heatCanvas, x0, y0, 360 * view.scale, 2 * MERC_Y_MAX * view.scale);
      }
    }

    /* depth contours (under land so coast-coincident segments stay hidden) */
    var bp;
    if (this.bathyOn && this.bathyPaths) {
      for (s = 0; s < shifts.length; s++) {
        shift = shifts[s];
        x0 = cssW / 2 + ((-180 + shift) - view.cLon) * view.scale;
        if (x0 > cssW || x0 + 360 * view.scale < 0) continue;
        ctx.setTransform(
          dpr * view.scale, 0, 0, -dpr * view.scale,
          dpr * (cssW / 2 + (shift - view.cLon) * view.scale),
          dpr * (cssH / 2 + mercY(view.cLat) * view.scale)
        );
        for (var b2 = 0; b2 < this.bathyPaths.length; b2++) {
          bp = this.bathyPaths[b2];
          ctx.strokeStyle = "rgba(58, 84, 110, " + bp.alpha + ")";
          ctx.lineWidth = bp.w / view.scale;
          ctx.stroke(bp.path);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* land */
    for (s = 0; s < shifts.length; s++) {
      shift = shifts[s];
      x0 = cssW / 2 + ((-180 + shift) - view.cLon) * view.scale;
      if (x0 > cssW || x0 + 360 * view.scale < 0) continue;
      ctx.setTransform(
        dpr * view.scale, 0, 0, -dpr * view.scale,
        dpr * (cssW / 2 + (shift - view.cLon) * view.scale),
        dpr * (cssH / 2 + mercY(view.cLat) * view.scale)
      );
      var hdTiles = (withChrome && this.interacting) ? null : this.readyCoastTiles(view);
      ctx.fillStyle = "#ddd8cb";
      ctx.lineJoin = "round";
      if (hdTiles) {
        for (var hi = 0; hi < hdTiles.length; hi++) ctx.fill(hdTiles[hi].fill);
        ctx.strokeStyle = "#b7b1a1";
        ctx.lineWidth = 1 / view.scale;
        for (hi = 0; hi < hdTiles.length; hi++) ctx.stroke(hdTiles[hi].stroke);
      } else {
        ctx.fill(this.landPath);
        ctx.strokeStyle = "#b7b1a1";
        ctx.lineWidth = 1 / view.scale;
        ctx.stroke(this.landPath);
      }
      if (this.bordersPath) {
        ctx.strokeStyle = "rgba(122, 112, 94, 0.45)";
        ctx.lineWidth = 0.9 / view.scale;
        ctx.stroke(this.bordersPath);
      }
      if (this.assetsOn && this.linesOn !== false && this.assetLinesPath &&
          view.scale >= PIPE_MIN_SCALE) {
        ctx.strokeStyle = "rgba(194, 87, 31, 0.7)";
        ctx.lineWidth = 1.4 / view.scale;
        ctx.stroke(this.assetLinesPath);
      }
      if (this.cycTracksOn && this.cycMinorPath) {
        ctx.strokeStyle = "rgba(122, 84, 160, 0.22)";
        ctx.lineWidth = 1.0 / view.scale;
        ctx.stroke(this.cycMinorPath);
        ctx.strokeStyle = "rgba(122, 84, 160, 0.5)";
        ctx.lineWidth = 1.3 / view.scale;
        ctx.stroke(this.cycMajorPath);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* graticule */
    var step = this.gratStep(view.scale), lat, lon, x, y;
    ctx.strokeStyle = "rgba(20, 40, 60, 0.10)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#898781";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    var latLbl;
    for (lat = -90 + step; lat < 90; lat += step) {
      y = latToY(lat);
      if (y < -2 || y > cssH + 2) continue;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
      if (withChrome) {
        latLbl = this.fmtDeg(lat, "N", "S");
        ctx.fillText(latLbl, 4, y - 2);
        /* right edge too: the legend hides the bottom-left labels */
        ctx.fillText(latLbl, cssW - 4 - ctx.measureText(latLbl).width, y - 2);
      }
    }
    var lonStart = Math.ceil((view.cLon - cssW / (2 * view.scale)) / step) * step;
    var lonEnd = view.cLon + cssW / (2 * view.scale);
    for (lon = lonStart; lon <= lonEnd; lon += step) {
      x = lonToX(lon);
      if (x < -2 || x > cssW + 2) continue;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
      if (withChrome) ctx.fillText(this.fmtDeg(wrapDelta(lon), "E", "W"), x + 3, cssH - 4);
    }

    /* place names (Natural Earth populated places, sorted by min_zoom).
       Gate each label on NE's own min_zoom against the web-map zoom this
       scale equals (z = log2(scale*360/256), +1 bias tuned by eye), so only
       bigger cities label zoomed out. Collision boxes in importance order
       keep the layer sparse; the loop stops at the first un-earned rank. */
    if (this.places) {
      var plZ = Math.log(view.scale * 360 / 256) / Math.LN2 + 1.0;
      if (plZ > 6) plZ += (plZ - 6) * 0.8;
      var plBoxes = [], pl, plX, plY, plW, plB, plHit, pj, pk;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      for (pj = 0; pj < this.places.length && plBoxes.length < 130; pj++) {
        pl = this.places[pj];
        if (pl[0] > plZ) break;
        plX = lonToX(pl[2]); plY = latToY(pl[1]);
        if (plX < -70 || plX > cssW + 20 || plY < -8 || plY > cssH + 8) continue;
        plW = ctx.measureText(pl[3]).width;
        plB = { x: plX - 4, y: plY - 8, w: plW + 12, h: 16 };
        plHit = false;
        for (pk = 0; pk < plBoxes.length; pk++) {
          if (plB.x < plBoxes[pk].x + plBoxes[pk].w && plBoxes[pk].x < plB.x + plB.w &&
              plB.y < plBoxes[pk].y + plBoxes[pk].h && plBoxes[pk].y < plB.y + plB.h) {
            plHit = true;
            break;
          }
        }
        if (plHit) continue;
        plBoxes.push(plB);
        ctx.fillStyle = "#7a705e";
        ctx.beginPath();
        ctx.arc(plX, plY, 1.8, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = "rgba(249, 249, 247, 0.85)";
        ctx.lineWidth = 2.5;
        ctx.strokeText(pl[3], plX + 5, plY);
        ctx.fillStyle = "#5f5b52";
        ctx.fillText(pl[3], plX + 5, plY);
      }
    }

    /* oil and gas assets: diamonds = platforms, circles = fields, small dots =
       wells (wells only past WELL_MIN_SCALE, they are far too dense zoomed out) */
    if (this.assetsOn && this.assets) {
      var ai, aa, ax, ay, isPlat, isWell;
      var showWells = view.scale >= WELL_MIN_SCALE;
      for (ai = 0; ai < this.assets.length; ai++) {
        aa = this.assets[ai];
        isWell = aa.t === "well";
        if (isWell && !showWells) continue;
        if (this.assetFilter && !this.assetFilter(aa)) continue;
        ax = lonToX(aa.lo); ay = latToY(aa.la);
        if (ax < -8 || ax > cssW + 8 || ay < -8 || ay > cssH + 8) continue;
        isPlat = (aa.t || "").indexOf("platform") >= 0;
        ctx.beginPath();
        if (isWell) {
          ctx.arc(ax, ay, 2.4, 0, 2 * Math.PI);
        } else if (isPlat) {
          ctx.moveTo(ax, ay - 4.5); ctx.lineTo(ax + 4.5, ay);
          ctx.lineTo(ax, ay + 4.5); ctx.lineTo(ax - 4.5, ay);
          ctx.closePath();
        } else {
          ctx.arc(ax, ay, 3.6, 0, 2 * Math.PI);
        }
        ctx.fillStyle = "#c2571f";
        ctx.strokeStyle = "rgba(252, 252, 251, 0.95)";
        ctx.lineWidth = isWell ? 1 : 1.4;
        ctx.fill();
        ctx.stroke();
      }
      /* hover highlight + label card (interactive view only) */
      if (withChrome && this.hoverAsset) {
        aa = this.hoverAsset;
        ax = lonToX(aa.lo); ay = latToY(aa.la);
        ctx.beginPath();
        ctx.arc(ax, ay, 8, 0, 2 * Math.PI);
        ctx.strokeStyle = "#c2571f";
        ctx.lineWidth = 2;
        ctx.stroke();
        var l3parts = [];
        if (aa.d) l3parts.push("~" + aa.d.toLocaleString() + " m water");
        if (aa.y) l3parts.push(String(aa.y));
        if (aa.o) l3parts.push(aa.o);
        drawTip(ctx, cssW, ax, ay, aa.n,
          (aa.t || "asset") + (aa.s ? ", " + aa.s : "") + (aa.c ? " \u00B7 " + aa.c : ""),
          l3parts.join(" \u00B7 "));
      }

      /* Pipeline under the cursor: highlight the line itself, then label it.
         Anchored at the nearest point ON the line rather than the cursor, so
         the callout points at what it describes. */
      if (withChrome && this.hoverLine) {
        var hl = this.hoverLine, hp = hl.pts, hk;
        ctx.beginPath();
        ctx.moveTo(lonToX(hp[0][1]), latToY(hp[0][0]));
        for (hk = 1; hk < hp.length; hk++) ctx.lineTo(lonToX(hp[hk][1]), latToY(hp[hk][0]));
        ctx.strokeStyle = "#c2571f";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        var lt = lineTipText(hl);
        drawTip(ctx, cssW, this.hoverLineAt.x, this.hoverLineAt.y, lt[0], lt[1], lt[2]);
      }

      /* Cyclone track under the cursor. */
      if (withChrome && this.hoverTrack) {
        var ht = this.hoverTrack, tp = ht.pts, tk;
        ctx.beginPath();
        ctx.moveTo(lonToX(tp[0][1]), latToY(tp[0][0]));
        for (tk = 1; tk < tp.length; tk++) ctx.lineTo(lonToX(tp[tk][1]), latToY(tp[tk][0]));
        ctx.strokeStyle = "#7a2f8f";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        var tt = trackTipText(ht);
        drawTip(ctx, cssW, this.hoverTrackAt.x, this.hoverTrackAt.y, tt[0], tt[1], tt[2]);
      }
    }

    /* measurement: the line, its ends, and the reading at the midpoint */
    if (withChrome && this.measure && this.measure.a && this.measure.b) {
      var ma = this.measure.a, mb = this.measure.b;
      var mx0 = lonToX(ma.lon), my0 = latToY(ma.lat);
      var mx1 = lonToX(mb.lon), my1 = latToY(mb.lat);
      ctx.save();
      /* a light halo under the line keeps it readable over dark shading */
      ctx.strokeStyle = "rgba(252, 252, 251, 0.9)";
      ctx.lineWidth = 4.5;
      ctx.beginPath(); ctx.moveTo(mx0, my0); ctx.lineTo(mx1, my1); ctx.stroke();
      ctx.strokeStyle = "#b5341c";
      ctx.lineWidth = 1.8;
      if (!this.measure.fixed) ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(mx0, my0); ctx.lineTo(mx1, my1); ctx.stroke();
      ctx.setLineDash([]);
      var me;
      for (me = 0; me < 2; me++) {
        var ex = me ? mx1 : mx0, ey = me ? my1 : my0;
        ctx.beginPath(); ctx.arc(ex, ey, 4, 0, 2 * Math.PI);
        ctx.fillStyle = "#b5341c"; ctx.fill();
        ctx.strokeStyle = "rgba(252, 252, 251, 0.95)"; ctx.lineWidth = 1.5; ctx.stroke();
      }
      /* No label on the line itself: the readout above the map already
         carries the distance, the bearing and both positions, and a second
         copy at the midpoint only covered the map it was measuring. */
      ctx.restore();
    }

    /* data cell rectangle */
    if (this.cellRect) {
      var r = this.cellRect, half = r.res / 2;
      var rx = lonToX(r.lon - half), ry = latToY(r.lat + half);
      var rw = r.res * view.scale;
      var rh = (mercY(r.lat + half) - mercY(r.lat - half)) * view.scale;
      ctx.strokeStyle = "rgba(252, 252, 251, 0.95)";
      ctx.lineWidth = 3;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.strokeStyle = "rgba(11, 11, 11, 0.75)";
      ctx.lineWidth = 1.25;
      ctx.strokeRect(rx, ry, rw, rh);
    }

    /* rubber-band zoom rectangle */
    if (withChrome && this.zoomDrag) {
      var zd = this.zoomDrag;
      var zx = Math.min(zd.x0, zd.x1), zy = Math.min(zd.y0, zd.y1);
      var zw = Math.abs(zd.x1 - zd.x0), zh = Math.abs(zd.y1 - zd.y0);
      ctx.fillStyle = "rgba(20, 48, 74, 0.12)";
      ctx.fillRect(zx, zy, zw, zh);
      ctx.strokeStyle = "#14304a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(zx, zy, zw, zh);
    }

    /* selection marker */
    if (this.selection) {
      var mx = lonToX(this.selection.lon), my = latToY(this.selection.lat);
      ctx.beginPath();
      ctx.arc(mx, my, 7, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(252, 252, 251, 0.95)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(mx, my, 4.5, 0, 2 * Math.PI);
      ctx.fillStyle = "#d03b3b";
      ctx.fill();
    }
  };

  TMMap.prototype.fmtDeg = function (v, pos, neg) {
    var a = Math.abs(Math.round(v * 10) / 10);
    if (a === 0) return "0\u00B0";
    return a + "\u00B0" + (v >= 0 ? pos : neg);
  };

  /* Standalone snapshot for the PDF: centred on a point, fixed span. Returns dataURL. */
  TMMap.prototype.snapshot = function (lat, lon, lonSpan, w, h) {
    var cv = document.createElement("canvas");
    var dpr = 2;
    cv.width = w * dpr; cv.height = h * dpr;
    var scale = w / lonSpan;
    var half = h / (2 * scale);
    var yC = mercY(lat);
    if (half >= MERC_Y_MAX) {
      yC = 0;
    } else {
      if (yC + half > MERC_Y_MAX) yC = MERC_Y_MAX - half;
      if (yC - half < -MERC_Y_MAX) yC = -MERC_Y_MAX + half;
    }
    var view = { cLon: lon, cLat: invMercY(yC), scale: Math.max(scale, 0.001) };
    var saveSel = this.selection, saveCell = this.cellRect;
    var savedW = this.cssW, savedH = this.cssH;
    this.cssW = w; this.cssH = h;
    this.renderTo(cv.getContext("2d"), w, h, dpr, view, false);
    this.cssW = savedW; this.cssH = savedH;
    this.selection = saveSel; this.cellRect = saveCell;
    return cv.toDataURL("image/png");
  };

  /* ---------- interaction ---------- */

  TMMap.prototype.zoomAt = function (px, py, factor) {
    this.touchInteract();
    var v = this.view;
    var ns = Math.max(this.minScale, Math.min(MAX_SCALE, v.scale * factor));
    if (ns === v.scale) return;
    var lonAt = v.cLon + (px - this.cssW / 2) / v.scale;
    var yAt = mercY(v.cLat) + (this.cssH / 2 - py) / v.scale;
    v.scale = ns;
    v.cLon = wrapDelta(lonAt - (px - this.cssW / 2) / ns);
    v.cLat = invMercY(yAt - (this.cssH / 2 - py) / ns);
    this.clampLat();
    this.render();
  };

  TMMap.prototype.zoomStep = function (factor) {
    this.zoomAt(this.cssW / 2, this.cssH / 2, factor);
  };

  /* Measuring is a mode like zoom-window, but it is NOT one-shot: people
     take several measurements in a row, and dropping out after each one
     would mean re-arming every time. Escape or the button ends it. */
  TMMap.prototype.setMeasureMode = function (on) {
    this.dragMode = on ? "measure" : "pan";
    if (!on) this.measure = null;
    this.canvas.style.cursor = on ? "crosshair" : "";
    if (this.opts.onDragMode) this.opts.onDragMode(this.dragMode);
    if (this.opts.onMeasure) this.opts.onMeasure(this.measureInfo());
    this.render();
  };

  TMMap.prototype.clearMeasure = function () {
    this.measure = null;
    if (this.opts.onMeasure) this.opts.onMeasure(null);
    this.render();
  };

  TMMap.prototype.measureInfo = function () {
    var m = this.measure;
    if (!m || !m.a || !m.b) return null;
    var km = geoDist(m.a, m.b);
    return { a: m.a, b: m.b, km: km, nm: km / 1.852,
             bearing: geoBearing(m.a, m.b), label: measureLabel(km),
             fixed: !!m.fixed };
  };

  TMMap.prototype.setZoomWindowMode = function (on) {
    this.dragMode = on ? "zoomwin" : "pan";
    if (!on) this.zoomDrag = null;
    this.canvas.style.cursor = on ? "zoom-in" : "crosshair";
    if (this.opts.onDragMode) this.opts.onDragMode(this.dragMode);
    this.render();
  };

  /* Fit the view to a screen-space rectangle (the rubber-band zoom). */
  TMMap.prototype.fitScreenRect = function (x0, y0, x1, y1) {
    var w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (w < 4 || h < 4) return;
    var mid = this.pointToLatLon((x0 + x1) / 2, (y0 + y1) / 2);
    var factor = Math.min(this.cssW / w, this.cssH / h);
    this.view.scale = Math.max(this.minScale, Math.min(MAX_SCALE, this.view.scale * factor));
    this.view.cLon = mid.lon;
    this.view.cLat = mid.lat;
    this.clampLat();
    this.render();
  };

  TMMap.prototype.bindEvents = function () {
    var self = this, el = this.canvas;

    el.addEventListener("pointerdown", function (e) {
      el.setPointerCapture(e.pointerId);
      self.pointers[e.pointerId] = { x: e.offsetX, y: e.offsetY };
      self.dragMoved = 0;
      self.downAt = { x: e.offsetX, y: e.offsetY, t: Date.now() };
      if ((self.dragMode === "zoomwin" || e.shiftKey) && Object.keys(self.pointers).length === 1) {
        self.zoomDrag = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY };
      }
    });

    el.addEventListener("pointermove", function (e) {
      if (self.zoomDrag && self.pointers[e.pointerId]) {
        self.zoomDrag.x1 = e.offsetX;
        self.zoomDrag.y1 = e.offsetY;
        self.dragMoved += 1;
        self.touchInteract();
        self.render();
        return;
      }
      var p = self.pointers[e.pointerId];
      if (!p) {
        if (self.opts.onHover) self.opts.onHover(self.pointToLatLon(e.offsetX, e.offsetY));
        return;
      }
      var ids = Object.keys(self.pointers);
      if (ids.length === 1) {
        var dx = e.offsetX - p.x, dy = e.offsetY - p.y;
        self.dragMoved += Math.abs(dx) + Math.abs(dy);
        self.view.cLon = wrapDelta(self.view.cLon - dx / self.view.scale);
        self.view.cLat = invMercY(mercY(self.view.cLat) + dy / self.view.scale);
        self.clampLat();
        p.x = e.offsetX; p.y = e.offsetY;
        self.touchInteract();
        self.render();
      } else if (ids.length === 2) {
        p.x = e.offsetX; p.y = e.offsetY;
        var a = self.pointers[ids[0]], b = self.pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (self.lastPinch) {
          var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          self.zoomAt(mid.x, mid.y, d / self.lastPinch);
          self.dragMoved += 10;
        }
        self.lastPinch = d;
      }
    });

    function endPointer(e) {
      delete self.pointers[e.pointerId];
      if (Object.keys(self.pointers).length < 2) self.lastPinch = null;
      if (self.zoomDrag) {
        var zr = self.zoomDrag;
        self.zoomDrag = null;
        var wasMode = self.dragMode === "zoomwin";
        if (Math.abs(zr.x1 - zr.x0) > 14 && Math.abs(zr.y1 - zr.y0) > 14) {
          self.fitScreenRect(zr.x0, zr.y0, zr.x1, zr.y1);
        } else if (self.opts.onSelect) {
          /* a tap in zoom-window mode still selects the location */
          var ll2 = self.pointToLatLon(e.offsetX, e.offsetY);
          self.opts.onSelect(ll2.lat, ll2.lon);
        }
        if (wasMode) self.setZoomWindowMode(false); /* one-shot, like CAD zoom window */
        self.downAt = null;
        self.render();
        return;
      }
      if (self.downAt && self.dragMoved < 6 && Date.now() - self.downAt.t < 700) {
        var ll = self.pointToLatLon(e.offsetX, e.offsetY);
        self.downAt = null;
        if (self.dragMode === "measure") {
          /* first tap starts, second finishes, third starts again. The panel
             result is never touched in this mode: measuring a distance is not
             asking for statistics somewhere new. */
          if (!self.measure || self.measure.fixed) {
            self.measure = { a: ll, b: ll, fixed: false };
          } else {
            self.measure.b = ll;
            self.measure.fixed = true;
          }
          if (self.opts.onMeasure) self.opts.onMeasure(self.measureInfo());
          self.render();
          return;
        }
        if (self.opts.onSelect) self.opts.onSelect(ll.lat, ll.lon);
      }
      self.downAt = null;
    }
    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", function (e) { delete self.pointers[e.pointerId]; self.lastPinch = null; });

    el.addEventListener("wheel", function (e) {
      e.preventDefault();
      self.zoomAt(e.offsetX, e.offsetY, Math.pow(1.0025, -e.deltaY));
    }, { passive: false });

    el.addEventListener("dblclick", function (e) {
      e.preventDefault();
      self.zoomAt(e.offsetX, e.offsetY, 2);
    });

    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && (self.zoomDrag || self.dragMode === "zoomwin")) {
        self.zoomDrag = null;
        self.setZoomWindowMode(false);
      }
      if (e.key === "Escape" && self.dragMode === "measure") self.setMeasureMode(false);
    });

    el.addEventListener("mousemove", function (e) {
      if (Object.keys(self.pointers).length) return;
      if (self.opts.onHover) {
        self.opts.onHover(self.pointToLatLon(e.offsetX, e.offsetY));
      }
      /* an open measurement follows the cursor so the distance is readable
         before committing the second point */
      if (self.dragMode === "measure" && self.measure && !self.measure.fixed) {
        self.measure.b = self.pointToLatLon(e.offsetX, e.offsetY);
        if (self.opts.onMeasure) self.opts.onMeasure(self.measureInfo());
        self.render();
        return;
      }
      /* asset hover hit-test (10 px radius) */
      var next = null;
      if (self.assetsOn && self.assets) {
        var i, a2, ax, ay, d2, best = 101;
        var wellsVisible = self.view.scale >= WELL_MIN_SCALE;
        for (i = 0; i < self.assets.length; i++) {
          a2 = self.assets[i];
          if (a2.t === "well" && !wellsVisible) continue;
          if (self.assetFilter && !self.assetFilter(a2)) continue;
          ax = self.lonToX(a2.lo); ay = self.latToY(a2.la);
          d2 = (ax - e.offsetX) * (ax - e.offsetX) + (ay - e.offsetY) * (ay - e.offsetY);
          if (d2 < best) { best = d2; next = a2; }
        }
      }
      /* Lines are tested only when no asset point is under the cursor: a
         point is a more precise target than a line passing near it, and a
         well sitting on its own pipeline should still identify as the well. */
      var nLine = null, nLineAt = null, nTrack = null, nTrackAt = null;
      if (!next) {
        var pipesUp = self.assetsOn && self.linesOn !== false && self.assetLinesBox && self.pipesVisible();
        if (pipesUp) {
          var hitP = self.hitLine(self.assetLinesBox, e.offsetX, e.offsetY);
          if (hitP) { nLine = hitP.ln; nLineAt = hitP.at; }
        }
        if (!nLine && self.cycTracksOn && self.cycShownBox) {
          var hitT = self.hitLine(self.cycShownBox, e.offsetX, e.offsetY);
          if (hitT) { nTrack = hitT.ln; nTrackAt = hitT.at; }
        }
      }
      if (next !== self.hoverAsset || nLine !== self.hoverLine || nTrack !== self.hoverTrack) {
        self.hoverAsset = next;
        self.hoverLine = nLine;
        self.hoverLineAt = nLineAt;
        self.hoverTrack = nTrack;
        self.hoverTrackAt = nTrackAt;
        el.style.cursor = (nLine || nTrack) ? "pointer" : "";
        self.render();
      }
    });
    el.addEventListener("mouseleave", function () {
      if (self.opts.onHover) self.opts.onHover(null);
      if (self.hoverAsset || self.hoverLine || self.hoverTrack) {
        self.hoverAsset = null;
        self.hoverLine = null;
        self.hoverTrack = null;
        self.render();
      }
    });
  };

  window.TMMap = TMMap;
})();
