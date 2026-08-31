/* Sea State Explorer - SVG charts (exceedance curve + monthly bars).
   Single series each: series colour #2a78d6, context bars in de-emphasis grey.
   All values are also in the results table, so tooltips enhance rather than gate. */
(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var C = {
    series: "#2a78d6",
    wind: "#3f8f7a",
    dim: "#c3c2b7",
    ink: "#0b0b0b",
    ink2: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    baseline: "#c3c2b7",
    surface: "#fcfcfb"
  };

  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name), k;
    for (k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function txt(parent, x, y, s, attrs) {
    var e = el("text", attrs || {}, parent);
    e.setAttribute("x", x);
    e.setAttribute("y", y);
    e.textContent = s;
    return e;
  }

  var tipEl = null;
  function tip(show, clientX, clientY, html) {
    if (!tipEl) tipEl = document.getElementById("tm-tip");
    if (!tipEl) return;
    if (!show) { tipEl.hidden = true; return; }
    tipEl.innerHTML = html;
    tipEl.hidden = false;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var x = clientX + 14, y = clientY + 14;
    if (x + w > window.innerWidth - 8) x = clientX - w - 12;
    if (y + h > window.innerHeight - 8) y = clientY - h - 12;
    tipEl.style.left = x + "px";
    tipEl.style.top = y + "px";
  }

  /* Curve points including the implicit (0 m, 100%) anchor. */
  function curvePoints(thresholds, p) {
    var pts = [[0, 100]], i;
    for (i = 0; i < thresholds.length; i++) {
      if (p[i] !== null && p[i] !== undefined) pts.push([thresholds[i], p[i]]);
    }
    return pts;
  }

  /* spec: {thresholds, p, limit, interp(h) -> {p, floor}} */
  function renderCurve(container, spec) {
    container.innerHTML = "";
    var W = 640, H = 300, m = { l: 48, r: 16, t: 18, b: 46 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var xMax = spec.thresholds[spec.thresholds.length - 1];
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Exceedance curve: percent of time significant wave height exceeds each threshold" });
    container.appendChild(svg);

    function X(h) { return m.l + (h / xMax) * iw; }
    function Y(p) { return m.t + (1 - p / 100) * ih; }

    /* grid */
    var gv, gh;
    for (gv = 0; gv <= 100; gv += 25) {
      el("line", { x1: m.l, x2: m.l + iw, y1: Y(gv), y2: Y(gv), stroke: gv === 0 ? C.baseline : C.grid, "stroke-width": 1 }, svg);
      txt(svg, m.l - 7, Y(gv) + 3.5, gv + "%", { "text-anchor": "end", fill: C.muted, "font-size": 11 });
    }
    for (gh = 2; gh <= xMax; gh += 2) {
      el("line", { x1: X(gh), x2: X(gh), y1: m.t, y2: m.t + ih, stroke: C.grid, "stroke-width": 1 }, svg);
    }
    for (gh = 0; gh <= xMax; gh += 2) {
      txt(svg, X(gh), m.t + ih + 16, gh + "", { "text-anchor": "middle", fill: C.muted, "font-size": 11 });
    }
    txt(svg, m.l + iw / 2, H - 8, "Significant wave height Hs (m)", { "text-anchor": "middle", fill: C.ink2, "font-size": 11.5 });
    var yl = txt(svg, 0, 0, "% of time exceeding", { "text-anchor": "middle", fill: C.ink2, "font-size": 11.5 });
    yl.setAttribute("transform", "translate(13 " + (m.t + ih / 2) + ") rotate(-90)");

    var pts = curvePoints(spec.thresholds, spec.p);
    if (pts.length < 2) {
      txt(svg, W / 2, H / 2, "No data for the selected months", { "text-anchor": "middle", fill: C.muted, "font-size": 13 });
      return;
    }

    /* area wash + line */
    var dLine = "", dArea = "", i;
    for (i = 0; i < pts.length; i++) {
      dLine += (i ? " L " : "M ") + X(pts[i][0]).toFixed(1) + " " + Y(pts[i][1]).toFixed(1);
    }
    dArea = dLine + " L " + X(pts[pts.length - 1][0]).toFixed(1) + " " + Y(0).toFixed(1) +
      " L " + X(0).toFixed(1) + " " + Y(0).toFixed(1) + " Z";
    el("path", { d: dArea, fill: C.series, "fill-opacity": 0.10, stroke: "none" }, svg);

    /* operational limit reference */
    if (spec.limit && spec.limit > 0 && spec.limit <= xMax) {
      el("line", { x1: X(spec.limit), x2: X(spec.limit), y1: m.t, y2: m.t + ih,
        stroke: C.ink2, "stroke-width": 1, "stroke-dasharray": "4 3" }, svg);
      var anchor = spec.limit > xMax * 0.75 ? "end" : "start";
      var dx = spec.limit > xMax * 0.75 ? -5 : 5;
      txt(svg, X(spec.limit) + dx, m.t + 11, "limit " + spec.limit + " m", { "text-anchor": anchor, fill: C.ink2, "font-size": 10.5 });
    }

    el("path", { d: dLine, fill: "none", stroke: C.series, "stroke-width": 2,
      "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);

    /* markers at real thresholds (skip the synthetic 0 point) */
    for (i = 1; i < pts.length; i++) {
      el("circle", { cx: X(pts[i][0]), cy: Y(pts[i][1]), r: 4, fill: C.series,
        stroke: C.surface, "stroke-width": 2 }, svg);
    }

    /* hover layer: crosshair + tooltip */
    var cross = el("line", { x1: 0, x2: 0, y1: m.t, y2: m.t + ih, stroke: C.ink2, "stroke-width": 1, opacity: 0 }, svg);
    var dot = el("circle", { r: 4.5, fill: C.series, stroke: C.surface, "stroke-width": 2, opacity: 0 }, svg);
    var hover = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
    hover.addEventListener("mousemove", function (ev) {
      var box = svg.getBoundingClientRect();
      var px = (ev.clientX - box.left) * (W / box.width);
      var h = Math.max(0, Math.min(xMax, (px - m.l) / iw * xMax));
      var r = spec.interp(h);
      if (r.p === null) return;
      cross.setAttribute("x1", X(h)); cross.setAttribute("x2", X(h));
      cross.setAttribute("opacity", 0.35);
      dot.setAttribute("cx", X(h)); dot.setAttribute("cy", Y(r.p));
      dot.setAttribute("opacity", 1);
      tip(true, ev.clientX, ev.clientY,
        "Hs &gt; " + h.toFixed(1) + " m: <b>" + (r.floor ? "&lt; " : "") + window.TMData.fmtPct(r.p).replace("<", "&lt;") + "</b> of the time");
    });
    hover.addEventListener("mouseleave", function () {
      cross.setAttribute("opacity", 0);
      dot.setAttribute("opacity", 0);
      tip(false);
    });
  }

  /* spec: {values:[12 of % or null], selected:[12 bool], limit, monthNames} */
  function renderBars(container, spec) {
    container.innerHTML = "";
    var W = 430, H = 300, m = { l: 44, r: 10, t: 22, b: 36 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Percent of time above the operational limit, by calendar month" });
    container.appendChild(svg);

    var vmax = 0, i, anyData = false;
    for (i = 0; i < 12; i++) {
      if (spec.values[i] !== null) { anyData = true; if (spec.values[i] > vmax) vmax = spec.values[i]; }
    }
    var caps = [4, 8, 12, 20, 40, 60, 80, 100], niceMax = 100;
    for (i = 0; i < caps.length; i++) { if (vmax * 1.06 <= caps[i]) { niceMax = caps[i]; break; } }

    function Y(p) { return m.t + (1 - p / niceMax) * ih; }

    var g, gv;
    for (g = 0; g <= 4; g++) {
      gv = niceMax * g / 4;
      el("line", { x1: m.l, x2: m.l + iw, y1: Y(gv), y2: Y(gv), stroke: g === 0 ? C.baseline : C.grid, "stroke-width": 1 }, svg);
      txt(svg, m.l - 7, Y(gv) + 3.5, (niceMax < 20 ? gv.toFixed(gv % 1 ? 1 : 0) : Math.round(gv)) + "%",
        { "text-anchor": "end", fill: C.muted, "font-size": 11 });
    }

    if (!anyData) {
      txt(svg, W / 2, H / 2, "No data for this location", { "text-anchor": "middle", fill: C.muted, "font-size": 13 });
      return;
    }

    var slot = iw / 12, barW = Math.min(24, slot * 0.62);
    var maxIdx = -1;
    for (i = 0; i < 12; i++) {
      if (spec.values[i] !== null && (maxIdx < 0 || spec.values[i] > spec.values[maxIdx])) maxIdx = i;
    }

    for (i = 0; i < 12; i++) {
      var cx = m.l + slot * (i + 0.5);
      var v = spec.values[i];
      var x = cx - barW / 2;
      if (v !== null) {
        var y = Y(v), hgt = m.t + ih - y;
        var r = Math.min(4, barW / 2, hgt);
        var d = "M " + x + " " + (m.t + ih) +
          " L " + x + " " + (y + r) +
          " Q " + x + " " + y + " " + (x + r) + " " + y +
          " L " + (x + barW - r) + " " + y +
          " Q " + (x + barW) + " " + y + " " + (x + barW) + " " + (y + r) +
          " L " + (x + barW) + " " + (m.t + ih) + " Z";
        el("path", { d: d, fill: spec.selected[i] ? C.series : C.dim }, svg);
        if (i === maxIdx && hgt > 2) {
          txt(svg, cx, y - 5, window.TMData.fmtPct(v), { "text-anchor": "middle", fill: C.ink2, "font-size": 10.5 });
        }
      }
      txt(svg, cx, m.t + ih + 15, spec.monthNames[i][0], { "text-anchor": "middle", fill: spec.selected[i] ? C.ink2 : C.muted, "font-size": 10.5 });

      /* hover hit target: full column */
      (function (idx, colX) {
        var hit = el("rect", { x: colX, y: m.t, width: slot, height: ih, fill: "transparent" }, svg);
        hit.addEventListener("mousemove", function (ev) {
          var v2 = spec.values[idx];
          var name = spec.monthNames[idx];
          var body = v2 === null
            ? name + ": no data (possible ice season)"
            : name + ": <b>" + window.TMData.fmtPct(v2).replace("<", "&lt;") + "</b> of time above " + spec.limit + " m" +
              (spec.selected[idx] ? "" : " (month not selected)");
          tip(true, ev.clientX, ev.clientY, body);
        });
        hit.addEventListener("mouseleave", function () { tip(false); });
      })(i, m.l + slot * i);
    }

    txt(svg, m.l + iw / 2, H - 8, "Calendar month", { "text-anchor": "middle", fill: C.ink2, "font-size": 11.5 });
  }

  /* Peak-period distribution: % of time the peak period sits in each 1 s
     bin, aggregated over the selected months. The shape is the point: a
     twin-humped sea/swell site must read as two humps, which the old
     monthly-median line could never show. */
  function renderTpHist(container, spec) {
    container.innerHTML = "";
    var W = 660, H = 240, m = { l: 46, r: 12, t: 22, b: 36 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Percent of time the peak wave period falls in each one second band" });
    container.appendChild(svg);
    var nb = spec.nb, pct = spec.pct, i, vmax = 0;
    for (i = 0; i < nb; i++) if (pct[i] > vmax) vmax = pct[i];
    var caps = [4, 8, 12, 20, 30, 40, 60, 100], niceMax = 100;
    for (i = 0; i < caps.length; i++) { if (vmax * 1.08 <= caps[i]) { niceMax = caps[i]; break; } }

    function Y(p) { return m.t + (1 - p / niceMax) * ih; }

    var g, gv;
    for (g = 0; g <= 4; g++) {
      gv = niceMax * g / 4;
      el("line", { x1: m.l, x2: m.l + iw, y1: Y(gv), y2: Y(gv),
                   stroke: g === 0 ? C.baseline : C.grid, "stroke-width": 1 }, svg);
      txt(svg, m.l - 7, Y(gv) + 3.5, (niceMax < 20 ? gv.toFixed(gv % 1 ? 1 : 0) : Math.round(gv)) + "%",
        { "text-anchor": "end", fill: C.muted, "font-size": 11 });
    }

    var slot = iw / nb, barW = Math.min(30, slot * 0.7);
    for (i = 0; i < nb; i++) {
      var cx = m.l + slot * (i + 0.5);
      var v = pct[i];
      if (v > 0.05) {
        var y = Y(Math.min(v, niceMax)), hgt = m.t + ih - y;
        var x = cx - barW / 2;
        var r = Math.min(3, barW / 2, hgt);
        var d = "M " + x + " " + (m.t + ih) +
          " L " + x + " " + (y + r) +
          " Q " + x + " " + y + " " + (x + r) + " " + y +
          " L " + (x + barW - r) + " " + y +
          " Q " + (x + barW) + " " + y + " " + (x + barW) + " " + (y + r) +
          " L " + (x + barW) + " " + (m.t + ih) + " Z";
        el("path", { d: d, fill: C.series,
                     "fill-opacity": i === spec.modeIdx ? 0.95 : 0.7 }, svg);
        if (i === spec.modeIdx && hgt > 6) {
          txt(svg, cx, y - 5, Math.round(v) + "%",
            { "text-anchor": "middle", fill: C.ink2, "font-size": 10.5 });
        }
      }
      /* x tick label on every even second, plus the clamp bin */
      var sec = spec.t0 + i * spec.step;
      if (sec % 2 === 0 || i === nb - 1) {
        txt(svg, cx, m.t + ih + 15, sec + (i === nb - 1 ? "+" : ""),
          { "text-anchor": "middle", fill: C.ink2, "font-size": 10.5 });
      }
      (function (idx, colX) {
        var hit = el("rect", { x: colX, y: m.t, width: slot, height: ih, fill: "transparent" }, svg);
        hit.addEventListener("mousemove", function (ev) {
          var s0 = spec.t0 + idx * spec.step;
          var label = idx === nb - 1 ? s0 + " s and longer" : s0 + "-" + (s0 + spec.step) + " s";
          var v2 = pct[idx];
          tip(true, ev.clientX, ev.clientY,
            label + ": <b>" + (v2 < 0.5 ? "&lt; 0.5" : Math.round(v2)) + "%</b> of the time");
        });
        hit.addEventListener("mouseleave", function () { tip(false); });
      })(i, m.l + slot * i);
    }
    txt(svg, m.l + iw / 2, H - 8, "Peak period (s)",
      { "text-anchor": "middle", fill: C.ink2, "font-size": 11.5 });
  }

  /* Wave rose: 12 sectors of "% of time waves arrive FROM this direction",
     aggregated over the selected months. Single series, petal length = share.
     spec: {rose:[12 % or null], names:fn(centerDeg)->compass name} */
  function renderRose(container, spec) {
    container.innerHTML = "";
    var W = 300, H = 300, cx = W / 2, cy = H / 2 + 4, R = 108;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": (spec.what === "wind"
        ? "Wind rose: percent of time wind blows from each 30 degree direction sector"
        : "Wave rose: percent of time waves arrive from each 30 degree direction sector") });
    container.appendChild(svg);

    var petal = spec.what === "wind" ? C.wind : C.series;
    var rose = spec.rose, i, vmax = 0, hasData = false;
    if (rose) {
      for (i = 0; i < 12; i++) {
        if (rose[i] !== null && rose[i] !== undefined) { hasData = true; if (rose[i] > vmax) vmax = rose[i]; }
      }
    }
    if (!hasData) {
      txt(svg, W / 2, H / 2, "No direction data", { "text-anchor": "middle", fill: C.muted, "font-size": 13 });
      return;
    }
    var caps = [10, 20, 30, 40, 60, 80, 100], rmax = 100;
    for (i = 0; i < caps.length; i++) { if (vmax * 1.05 <= caps[i]) { rmax = caps[i]; break; } }

    function pt(deg, r) {
      var a = deg * Math.PI / 180;
      return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    }

    /* rings at quarter steps; labels on the SE diagonal, clear of the N mark */
    var g, rv, dg;
    for (g = 1; g <= 4; g++) {
      rv = R * g / 4;
      el("circle", { cx: cx, cy: cy, r: rv, fill: "none", stroke: C.grid, "stroke-width": 1 }, svg);
      if (g % 2 === 0) {
        dg = rv * 0.7071;
        txt(svg, cx + dg + 3, cy + dg + 9, Math.round(rmax * g / 4) + "%", { fill: C.muted, "font-size": 9.5 });
      }
    }
    /* compass labels */
    var comp = [["N", 0], ["E", 90], ["S", 180], ["W", 270]], cp;
    for (i = 0; i < 4; i++) {
      cp = pt(comp[i][1], R + 14);
      txt(svg, cp[0], cp[1] + 4, comp[i][0], { "text-anchor": "middle", fill: C.ink2, "font-size": 11.5, "font-weight": 600 });
    }

    /* petals: sector s covers [s*30, s*30+30) with a 2 deg inset gap */
    var maxIdx = -1;
    for (i = 0; i < 12; i++) if (rose[i] !== null && (maxIdx < 0 || rose[i] > rose[maxIdx])) maxIdx = i;
    for (i = 0; i < 12; i++) {
      var v = rose[i] === null || rose[i] === undefined ? 0 : rose[i];
      var r = Math.max(0, v / rmax) * R;
      var a0 = i * 30 + 2, a1 = i * 30 + 28;
      if (r > 0.5) {
        var p0 = pt(a0, r), p1 = pt(a1, r);
        el("path", {
          d: "M " + cx + " " + cy + " L " + p0[0].toFixed(1) + " " + p0[1].toFixed(1) +
             " A " + r.toFixed(1) + " " + r.toFixed(1) + " 0 0 1 " + p1[0].toFixed(1) + " " + p1[1].toFixed(1) + " Z",
          fill: petal, "fill-opacity": i === maxIdx ? 0.95 : 0.72,
          stroke: C.surface, "stroke-width": 1
        }, svg);
      }
      if (i === maxIdx && r > 12) {
        var lp = pt(i * 30 + 15, r + 12);
        txt(svg, lp[0], lp[1] + 3.5, Math.round(v) + "%", { "text-anchor": "middle", fill: C.ink2, "font-size": 10.5 });
      }
      /* hover hit: full-length sector wedge */
      (function (idx, val) {
        var q0 = pt(idx * 30, R), q1 = pt(idx * 30 + 30, R);
        var hit = el("path", {
          d: "M " + cx + " " + cy + " L " + q0[0].toFixed(1) + " " + q0[1].toFixed(1) +
             " A " + R + " " + R + " 0 0 1 " + q1[0].toFixed(1) + " " + q1[1].toFixed(1) + " Z",
          fill: "transparent"
        }, svg);
        hit.addEventListener("mousemove", function (ev) {
          var name = spec.names ? spec.names(idx * 30 + 15) : (idx * 30 + 15) + "\u00B0";
          tip(true, ev.clientX, ev.clientY,
            "From the " + name + ": <b>" + (val === null ? "no data" : Math.round(val) + "%") + "</b> of the time");
        });
        hit.addEventListener("mouseleave", function () { tip(false); });
      })(i, rose[i]);
    }
  }

  /* Typical peak period by month: dots joined by a line (non-zero baseline is
     fine for a position encoding). spec: {values:[12 s or null], selected:[12 bool], monthNames} */
  function renderTpMonths(container, spec) {
    container.innerHTML = "";
    var W = 430, H = 300, m = { l: 44, r: 10, t: 22, b: 36 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Typical peak wave period by calendar month" });
    container.appendChild(svg);

    var i, lo = null, hi = null, anyData = false;
    for (i = 0; i < 12; i++) {
      var v0 = spec.values[i];
      if (v0 !== null && v0 !== undefined) {
        anyData = true;
        if (lo === null || v0 < lo) lo = v0;
        if (hi === null || v0 > hi) hi = v0;
      }
    }
    if (!anyData) {
      txt(svg, W / 2, H / 2, "No period data", { "text-anchor": "middle", fill: C.muted, "font-size": 13 });
      return;
    }
    var yMin = Math.max(0, Math.floor(lo - 1)), yMax = Math.ceil(hi + 1);
    if (yMax - yMin < 4) yMax = yMin + 4;

    function Y(s) { return m.t + (1 - (s - yMin) / (yMax - yMin)) * ih; }
    var slot = iw / 12;
    function X(idx) { return m.l + slot * (idx + 0.5); }

    /* whole-second gridlines (2 s spacing when the range is wide) */
    var g, gStep = (yMax - yMin) > 6 ? 2 : 1;
    for (g = yMin; g <= yMax; g += gStep) {
      el("line", { x1: m.l, x2: m.l + iw, y1: Y(g), y2: Y(g), stroke: g === yMin ? C.baseline : C.grid, "stroke-width": 1 }, svg);
      txt(svg, m.l - 7, Y(g) + 3.5, g + " s", { "text-anchor": "end", fill: C.muted, "font-size": 11 });
    }

    var d = "", started = false, maxIdx = -1;
    for (i = 0; i < 12; i++) {
      if (spec.values[i] === null || spec.values[i] === undefined) { continue; }
      d += (started ? " L " : "M ") + X(i).toFixed(1) + " " + Y(spec.values[i]).toFixed(1);
      started = true;
      if (maxIdx < 0 || spec.values[i] > spec.values[maxIdx]) maxIdx = i;
    }
    el("path", { d: d, fill: "none", stroke: C.series, "stroke-width": 2,
      "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-opacity": 0.85 }, svg);

    for (i = 0; i < 12; i++) {
      var v = spec.values[i];
      if (v !== null && v !== undefined) {
        el("circle", { cx: X(i), cy: Y(v), r: 4, fill: spec.selected[i] ? C.series : C.dim,
          stroke: C.surface, "stroke-width": 2 }, svg);
        if (i === maxIdx) {
          txt(svg, X(i), Y(v) - 9, v.toFixed(1) + " s", { "text-anchor": "middle", fill: C.ink2, "font-size": 10.5 });
        }
      }
      txt(svg, X(i), m.t + ih + 15, spec.monthNames[i][0], { "text-anchor": "middle", fill: spec.selected[i] ? C.ink2 : C.muted, "font-size": 10.5 });
      (function (idx) {
        var hit = el("rect", { x: m.l + slot * idx, y: m.t, width: slot, height: ih, fill: "transparent" }, svg);
        hit.addEventListener("mousemove", function (ev) {
          var v2 = spec.values[idx];
          tip(true, ev.clientX, ev.clientY,
            spec.monthNames[idx] + ": " + (v2 === null || v2 === undefined
              ? "no data"
              : "typical peak period <b>" + v2.toFixed(1) + " s</b>" + (spec.selected[idx] ? "" : " (month not selected)")));
        });
        hit.addEventListener("mouseleave", function () { tip(false); });
      })(i);
    }
    txt(svg, m.l + iw / 2, H - 8, "Calendar month", { "text-anchor": "middle", fill: C.ink2, "font-size": 11.5 });
  }

  /* Weather windows by month: how many qualifying calm spells a typical year
     gives in each calendar month. spec: {values:[12 count or null],
     selected:[12 bool], monthNames, thr (m), dur (h)} */
  function renderWindows(container, spec) {
    container.innerHTML = "";
    var W = 430, H = 300, m = { l: 44, r: 10, t: 22, b: 36 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Weather windows per month: calm spells below the chosen wave height lasting at least the chosen duration" });
    container.appendChild(svg);

    var vmax = 0, i, anyData = false;
    for (i = 0; i < 12; i++) {
      if (spec.values[i] !== null) { anyData = true; if (spec.values[i] > vmax) vmax = spec.values[i]; }
    }
    if (!anyData) {
      txt(svg, W / 2, H / 2, "No data for this location", { "text-anchor": "middle", fill: C.muted, "font-size": 13 });
      return;
    }
    var caps = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128], niceMax = caps[caps.length - 1];
    for (i = 0; i < caps.length; i++) { if (vmax * 1.06 <= caps[i]) { niceMax = caps[i]; break; } }
    if (vmax * 1.06 > niceMax) niceMax = Math.ceil(vmax * 1.1);

    function Y(p) { return m.t + (1 - p / niceMax) * ih; }
    var g, gv;
    for (g = 0; g <= 4; g++) {
      gv = niceMax * g / 4;
      el("line", { x1: m.l, x2: m.l + iw, y1: Y(gv), y2: Y(gv), stroke: g === 0 ? C.baseline : C.grid, "stroke-width": 1 }, svg);
      txt(svg, m.l - 7, Y(gv) + 3.5, (gv % 1 ? gv.toFixed(1) : gv) + "", { "text-anchor": "end", fill: C.muted, "font-size": 11 });
    }

    var slot = iw / 12, barW = Math.min(24, slot * 0.62);
    var maxIdx = -1;
    for (i = 0; i < 12; i++) {
      if (spec.values[i] !== null && (maxIdx < 0 || spec.values[i] > spec.values[maxIdx])) maxIdx = i;
    }
    for (i = 0; i < 12; i++) {
      var cx = m.l + slot * (i + 0.5);
      var v = spec.values[i];
      var x = cx - barW / 2;
      if (v !== null) {
        var y = Y(v), hgt = m.t + ih - y;
        var r = Math.min(4, barW / 2, hgt);
        var d = "M " + x + " " + (m.t + ih) +
          " L " + x + " " + (y + r) +
          " Q " + x + " " + y + " " + (x + r) + " " + y +
          " L " + (x + barW - r) + " " + y +
          " Q " + (x + barW) + " " + y + " " + (x + barW) + " " + (y + r) +
          " L " + (x + barW) + " " + (m.t + ih) + " Z";
        el("path", { d: d, fill: spec.selected[i] ? C.series : C.dim }, svg);
        if (i === maxIdx && hgt > 2) {
          txt(svg, cx, y - 5, (v % 1 ? v.toFixed(1) : v) + "", { "text-anchor": "middle", fill: C.ink2, "font-size": 10.5 });
        }
      }
      txt(svg, cx, m.t + ih + 15, spec.monthNames[i][0], { "text-anchor": "middle", fill: spec.selected[i] ? C.ink2 : C.muted, "font-size": 10.5 });
      (function (idx, colX) {
        var hit = el("rect", { x: colX, y: m.t, width: slot, height: ih, fill: "transparent" }, svg);
        hit.addEventListener("mousemove", function (ev) {
          var v2 = spec.values[idx];
          var name = spec.monthNames[idx];
          var body = v2 === null
            ? name + ": no data (possible ice season)"
            : name + ": <b>" + (v2 % 1 ? v2.toFixed(1) : v2) + "</b> spell" + (v2 === 1 ? "" : "s") +
              " of " + spec.dur + " h or more below " + spec.thr + " m, in a typical year" +
              (spec.selected[idx] ? "" : " (month not selected)");
          tip(true, ev.clientX, ev.clientY, body);
        });
        hit.addEventListener("mouseleave", function () { tip(false); });
      })(i, m.l + slot * i);
    }
    txt(svg, m.l + iw / 2, H - 8, "Calendar month", { "text-anchor": "middle", fill: C.ink2, "font-size": 11.5 });
  }

  /* Cyclone exposure by month: storm-days inside the chosen ring, with the
     average storm count in the tooltip. spec: {days:[12], storms:[12],
     selected:[12 bool], monthNames, radius (nm)} */
  function renderCyc(container, spec) {
    container.innerHTML = "";
    var W = 430, H = 260, m = { l: 44, r: 10, t: 20, b: 36 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Average storm-days per month with a tropical cyclone inside the chosen distance" }, null);
    container.appendChild(svg);
    var vmax = 0, i, any = false;
    for (i = 0; i < 12; i++) {
      if (spec.days[i] > 0) any = true;
      if (spec.days[i] > vmax) vmax = spec.days[i];
    }
    if (!any) {
      txt(svg, W / 2, H / 2, "No recorded exposure at this distance", { "text-anchor": "middle", fill: C.muted, "font-size": 13 });
      return;
    }
    var caps = [0.5, 1, 2, 4, 8, 16, 31], niceMax = 31;
    for (i = 0; i < caps.length; i++) { if (vmax * 1.06 <= caps[i]) { niceMax = caps[i]; break; } }
    function Y(p) { return m.t + (1 - p / niceMax) * ih; }
    var g, gv;
    for (g = 0; g <= 4; g++) {
      gv = niceMax * g / 4;
      el("line", { x1: m.l, x2: m.l + iw, y1: Y(gv), y2: Y(gv), stroke: g === 0 ? C.baseline : C.grid, "stroke-width": 1 }, svg);
      txt(svg, m.l - 7, Y(gv) + 3.5, (gv % 1 ? gv.toFixed(1) : gv) + "", { "text-anchor": "end", fill: C.muted, "font-size": 11 });
    }
    var slot = iw / 12, barW = Math.min(24, slot * 0.62);
    var maxIdx = -1;
    for (i = 0; i < 12; i++) if (maxIdx < 0 || spec.days[i] > spec.days[maxIdx]) maxIdx = i;
    for (i = 0; i < 12; i++) {
      var cx = m.l + slot * (i + 0.5), v = spec.days[i], x = cx - barW / 2;
      if (v > 0) {
        var y = Y(v), hgt = m.t + ih - y, r = Math.min(4, barW / 2, hgt);
        var d = "M " + x + " " + (m.t + ih) + " L " + x + " " + (y + r) +
          " Q " + x + " " + y + " " + (x + r) + " " + y +
          " L " + (x + barW - r) + " " + y +
          " Q " + (x + barW) + " " + y + " " + (x + barW) + " " + (y + r) +
          " L " + (x + barW) + " " + (m.t + ih) + " Z";
        el("path", { d: d, fill: spec.selected[i] ? C.series : C.dim }, svg);
        if (i === maxIdx && hgt > 2) {
          txt(svg, cx, y - 5, v.toFixed(1), { "text-anchor": "middle", fill: C.ink2, "font-size": 10.5 });
        }
      }
      txt(svg, cx, m.t + ih + 15, spec.monthNames[i][0], { "text-anchor": "middle", fill: spec.selected[i] ? C.ink2 : C.muted, "font-size": 10.5 });
      (function (idx, colX) {
        var hit = el("rect", { x: colX, y: m.t, width: slot, height: ih, fill: "transparent" }, svg);
        hit.addEventListener("mousemove", function (ev) {
          var name = spec.monthNames[idx];
          tip(true, ev.clientX, ev.clientY,
            name + ": <b>" + spec.days[idx].toFixed(1) + "</b> storm-day" + (spec.days[idx] === 1 ? "" : "s") +
            " inside " + spec.radius.toLocaleString() + " nm; " + spec.storms[idx].toFixed(1) +
            " storm" + (spec.storms[idx] === 1 ? "" : "s") + " in an average season" +
            (spec.selected[idx] ? "" : " (month not selected)"));
        });
        hit.addEventListener("mouseleave", function () { tip(false); });
      })(i, m.l + slot * i);
    }
    txt(svg, m.l + iw / 2, H - 8, "Calendar month", { "text-anchor": "middle", fill: C.ink2, "font-size": 11.5 });
  }

  /* Across the day: mean Hs and mean wind by 3 h local-solar slot, two mini
     panels in one figure. spec: {hs:[8 m|null], wind:[8 m/s|null]} */
  function renderDiurnal(container, spec) {
    container.innerHTML = "";
    var W = 660, H = 240;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Mean wave height and wind speed by three hour slot of the local solar day" });
    container.appendChild(svg);
    var panels = [];
    if (spec.hs) panels.push({ vals: spec.hs, label: "Mean Hs (m)", fmt: function (v) { return v.toFixed(2) + " m"; } });
    if (spec.wind) panels.push({ vals: spec.wind, label: "Mean wind (m/s)", fmt: function (v) { return v.toFixed(1) + " m/s"; } });
    if (!panels.length) return;
    var pw = W / panels.length;
    panels.forEach(function (p, pi) {
      var m = { l: 46 + pi * pw, r: (pi + 1) * pw === W ? 12 : 18, t: 24, b: 34 };
      var x0 = 46 + pi * pw, iw = pw - 58;
      var ih = H - m.t - m.b;
      var lo = null, hi = null, i;
      for (i = 0; i < 8; i++) {
        var v0 = p.vals[i];
        if (v0 === null) continue;
        if (lo === null || v0 < lo) lo = v0;
        if (hi === null || v0 > hi) hi = v0;
      }
      if (lo === null) return;
      var pad = Math.max((hi - lo) * 0.25, hi * 0.02, 0.05);
      var yMin = Math.max(0, lo - pad), yMax = hi + pad;
      function Y(v) { return m.t + (1 - (v - yMin) / (yMax - yMin)) * ih; }
      function X(idx) { return x0 + (iw / 8) * (idx + 0.5); }
      function XH(h) { return x0 + iw * (h / 24); }
      /* night shading behind everything else */
      if (spec.nightRise !== null && spec.nightRise !== undefined && spec.nightRise > 0) {
        el("rect", { x: x0, y: m.t, width: XH(spec.nightRise) - x0, height: ih,
          fill: C.ink, "fill-opacity": 0.05 }, svg);
        el("rect", { x: XH(spec.nightSet), y: m.t, width: x0 + iw - XH(spec.nightSet),
          height: ih, fill: C.ink, "fill-opacity": 0.05 }, svg);
      }
      var g;
      for (g = 0; g <= 3; g++) {
        var gv = yMin + (yMax - yMin) * g / 3;
        el("line", { x1: x0, x2: x0 + iw, y1: Y(gv), y2: Y(gv), stroke: g === 0 ? C.baseline : C.grid, "stroke-width": 1 }, svg);
        txt(svg, x0 - 6, Y(gv) + 3.5, gv >= 10 ? gv.toFixed(0) : gv.toFixed(1),
          { "text-anchor": "end", fill: C.muted, "font-size": 10.5 });
      }
      var d = "", started = false;
      for (i = 0; i < 8; i++) {
        if (p.vals[i] === null) continue;
        d += (started ? " L " : "M ") + X(i).toFixed(1) + " " + Y(p.vals[i]).toFixed(1);
        started = true;
      }
      el("path", { d: d, fill: "none", stroke: C.series, "stroke-width": 2,
        "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-opacity": 0.85 }, svg);
      for (i = 0; i < 8; i++) {
        if (p.vals[i] !== null) {
          el("circle", { cx: X(i), cy: Y(p.vals[i]), r: 3.5, fill: C.series,
            stroke: C.surface, "stroke-width": 2 }, svg);
        }
        if (i % 2 === 0) {
          txt(svg, X(i), m.t + ih + 14, ("0" + (i * 3)).slice(-2) + ":00",
            { "text-anchor": "middle", fill: C.muted, "font-size": 10 });
        }
        (function (idx) {
          var hit = el("rect", { x: x0 + (iw / 8) * idx, y: m.t, width: iw / 8, height: ih,
            fill: "transparent" }, svg);
          hit.addEventListener("mousemove", function (ev) {
            var t0h = ("0" + (idx * 3)).slice(-2), t1h = ("0" + ((idx * 3 + 3) % 24)).slice(-2);
            tip(true, ev.clientX, ev.clientY,
              t0h + ":00 to " + t1h + ":00 local solar: " +
              (p.vals[idx] === null ? "no data" : "<b>" + p.fmt(p.vals[idx]) + "</b>"));
          });
          hit.addEventListener("mouseleave", function () { tip(false); });
        })(i);
      }
      txt(svg, x0 + iw / 2, 14, p.label, { "text-anchor": "middle", fill: C.ink2,
        "font-size": 11.5, "font-weight": "600" });
      txt(svg, x0 + iw / 2, H - 6, "Local solar time", { "text-anchor": "middle", fill: C.muted, "font-size": 10.5 });
    });
  }

  window.TMCharts = {
    renderCurve: renderCurve,
    renderBars: renderBars,
    renderRose: renderRose,
    renderTpMonths: renderTpMonths,
    renderTpHist: renderTpHist,
    renderWindows: renderWindows,
    renderCyc: renderCyc,
    renderDiurnal: renderDiurnal,
    curvePoints: curvePoints,
    tip: tip
  };
})();
