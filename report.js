/* Sea State Explorer - one page A4 PDF summary via pdf-lib (vendored, lazy loaded).
   Vector redraw of the two charts + map snapshot + table + disclaimer + CTA.
   In demo mode the page carries a diagonal DEMONSTRATION DATA watermark. */
(function () {
  "use strict";

  var PAGE_W = 595.28, PAGE_H = 841.89, M = 40;

  var COL = {
    ink: [0.043, 0.043, 0.043],
    ink2: [0.322, 0.318, 0.306],
    muted: [0.537, 0.529, 0.506],
    grid: [0.882, 0.878, 0.851],
    baseline: [0.765, 0.761, 0.718],
    navy: [0.078, 0.188, 0.29],
    series: [0.165, 0.471, 0.839],
    dim: [0.765, 0.761, 0.718],
    wm: [0.91, 0.91, 0.91]
  };

  function ensurePdfLib(src) {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      var u = src || "vendor/pdf-lib.min.js";
      s.src = window.TM_BUILD ? u + (u.indexOf("?") < 0 ? "?" : "&") + "v=" + window.TM_BUILD : u;
      s.onload = function () { resolve(window.PDFLib); };
      s.onerror = function () { reject(new Error("Could not load the PDF library.")); };
      document.head.appendChild(s);
    });
  }

  function rgb(P, c) { return P.rgb(c[0], c[1], c[2]); }

  function wrapText(font, text, size, width) {
    var words = String(text).split(/\s+/), lines = [], line = "";
    var i, tryLine;
    for (i = 0; i < words.length; i++) {
      tryLine = line ? line + " " + words[i] : words[i];
      if (font.widthOfTextAtSize(tryLine, size) > width && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = tryLine;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawWrapped(page, font, text, x, y, size, width, leading, color) {
    var lines = wrapText(font, text, size, width), i;
    for (i = 0; i < lines.length; i++) {
      page.drawText(lines[i], { x: x, y: y - i * leading, size: size, font: font, color: color });
    }
    return y - lines.length * leading;
  }

  /* ---- vector curve chart ---- */
  function drawCurvePdf(P, page, fonts, x0, y0, w, h, spec) {
    var ml = 30, mr = 6, mt = 10, mb = 26;
    var iw = w - ml - mr, ih = h - mt - mb;
    var xMax = spec.thresholds[spec.thresholds.length - 1];
    function X(v) { return x0 + ml + (v / xMax) * iw; }
    function Y(p) { return y0 + mb + (p / 100) * ih; }
    var g, i;
    for (g = 0; g <= 100; g += 25) {
      page.drawLine({ start: { x: x0 + ml, y: Y(g) }, end: { x: x0 + ml + iw, y: Y(g) },
        thickness: 0.5, color: rgb(P, g === 0 ? COL.baseline : COL.grid) });
      page.drawText(g + "%", { x: x0 + ml - 4 - fonts.reg.widthOfTextAtSize(g + "%", 6.5), y: Y(g) - 2.2,
        size: 6.5, font: fonts.reg, color: rgb(P, COL.muted) });
    }
    for (g = 2; g <= xMax; g += 2) {
      page.drawLine({ start: { x: X(g), y: Y(0) }, end: { x: X(g), y: Y(100) },
        thickness: 0.5, color: rgb(P, COL.grid) });
    }
    for (g = 0; g <= xMax; g += 2) {
      page.drawText(String(g), { x: X(g) - fonts.reg.widthOfTextAtSize(String(g), 6.5) / 2, y: y0 + mb - 10,
        size: 6.5, font: fonts.reg, color: rgb(P, COL.muted) });
    }
    page.drawText("Significant wave height Hs (m)", {
      x: x0 + ml + iw / 2 - fonts.reg.widthOfTextAtSize("Significant wave height Hs (m)", 7) / 2,
      y: y0 + 2, size: 7, font: fonts.reg, color: rgb(P, COL.ink2) });

    if (spec.limit && spec.limit <= xMax) {
      page.drawLine({ start: { x: X(spec.limit), y: Y(0) }, end: { x: X(spec.limit), y: Y(100) },
        thickness: 0.7, color: rgb(P, COL.ink2), dashArray: [3, 2] });
      page.drawText("limit " + spec.limit + " m", { x: X(spec.limit) + 3, y: Y(100) - 7,
        size: 6.5, font: fonts.reg, color: rgb(P, COL.ink2) });
    }

    var pts = window.TMCharts.curvePoints(spec.thresholds, spec.p);
    for (i = 1; i < pts.length; i++) {
      page.drawLine({
        start: { x: X(pts[i - 1][0]), y: Y(pts[i - 1][1]) },
        end: { x: X(pts[i][0]), y: Y(pts[i][1]) },
        thickness: 1.4, color: rgb(P, COL.series)
      });
    }
    for (i = 1; i < pts.length; i++) {
      page.drawCircle({ x: X(pts[i][0]), y: Y(pts[i][1]), size: 1.9, color: rgb(P, COL.series),
        borderColor: rgb(P, [0.988, 0.988, 0.984]), borderWidth: 0.8 });
    }
  }

  /* ---- vector monthly bars ---- */
  function drawBarsPdf(P, page, fonts, x0, y0, w, h, spec) {
    var ml = 28, mr = 4, mt = 12, mb = 26;
    var iw = w - ml - mr, ih = h - mt - mb;
    var vmax = 0, i;
    for (i = 0; i < 12; i++) if (spec.values[i] !== null && spec.values[i] > vmax) vmax = spec.values[i];
    /* spec.unit defaults to "%" because most of these charts are percentages,
       but weather-window spell counts and cyclone storm-days are not, and
       labelling a count as a percentage is just wrong. When a unit is given
       the scale is chosen from the data instead of the percentage ladder. */
    var unit = spec.unit === undefined ? "%" : spec.unit;
    var caps = unit === "%" ? [4, 8, 12, 20, 40, 60, 80, 100]
                            : [1, 2, 4, 5, 8, 10, 16, 20, 40, 60, 100];
    var niceMax = caps[caps.length - 1];
    for (i = 0; i < caps.length; i++) { if (vmax * 1.06 <= caps[i]) { niceMax = caps[i]; break; } }
    function Y(p) { return y0 + mb + (p / niceMax) * ih; }
    var g, lbl;
    for (g = 0; g <= 4; g++) {
      var gv = niceMax * g / 4;
      page.drawLine({ start: { x: x0 + ml, y: Y(gv) }, end: { x: x0 + ml + iw, y: Y(gv) },
        thickness: 0.5, color: rgb(P, g === 0 ? COL.baseline : COL.grid) });
      lbl = (niceMax < 20 && gv % 1 ? gv.toFixed(1) : String(Math.round(gv))) + unit;
      page.drawText(lbl, { x: x0 + ml - 4 - fonts.reg.widthOfTextAtSize(lbl, 6.5), y: Y(gv) - 2.2,
        size: 6.5, font: fonts.reg, color: rgb(P, COL.muted) });
    }
    var slot = iw / 12, barW = Math.min(11, slot * 0.62);
    for (i = 0; i < 12; i++) {
      var cx = x0 + ml + slot * (i + 0.5);
      var v = spec.values[i];
      if (v !== null) {
        page.drawRectangle({ x: cx - barW / 2, y: Y(0), width: barW, height: Math.max(0.4, (v / niceMax) * ih),
          color: rgb(P, spec.selected[i] ? COL.series : COL.dim) });
      }
      var mchar = spec.monthNames[i][0];
      page.drawText(mchar, { x: cx - fonts.reg.widthOfTextAtSize(mchar, 6.5) / 2, y: y0 + mb - 10,
        size: 6.5, font: fonts.reg, color: rgb(P, spec.selected[i] ? COL.ink2 : COL.muted) });
    }
    page.drawText("Calendar month", {
      x: x0 + ml + iw / 2 - fonts.reg.widthOfTextAtSize("Calendar month", 7) / 2,
      y: y0 + 2, size: 7, font: fonts.reg, color: rgb(P, COL.ink2) });
  }

  function monthListLabel(state) {
    if (state.months.length === 12) return "All year (Jan to Dec)";
    return state.months.map(function (m) { return state.monthNames[m]; }).join(", ");
  }

  function loadLogo(doc, src) {
    /* Optional: a missing or unreadable file leaves the header on the text
       wordmark it used before, rather than failing the whole PDF. */
    if (!src) return Promise.resolve(null);
    return fetch(src).then(function (r) {
      if (!r.ok) throw new Error("logo HTTP " + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      return doc.embedPng(buf);
    }).catch(function () { return null; });
  }


  /* ---------- helpers for the continuation pages ----------------------- */

  /* Every page after the first gets the same slim header and a page number,
     so a printed report still reads in order if the staple comes out. The
     footer rule and page count are stamped at the end, once the total is
     known. */
  function addPage(doc, P, fonts, logo, title, sub) {
    var page = doc.addPage([PAGE_W, PAGE_H]);
    if (logo) {
      var h = 15;
      page.drawImage(logo, { x: M, y: PAGE_H - M - 16, width: logo.width * (h / logo.height), height: h });
    }
    var tw = fonts.bold.widthOfTextAtSize(title, 11);
    page.drawText(title, { x: PAGE_W - M - tw, y: PAGE_H - M - 8, size: 11, font: fonts.bold, color: rgb(P, COL.ink) });
    if (sub) {
      var sw = fonts.reg.widthOfTextAtSize(sub, 8);
      page.drawText(sub, { x: PAGE_W - M - sw, y: PAGE_H - M - 19, size: 8, font: fonts.reg, color: rgb(P, COL.muted) });
    }
    page.drawLine({ start: { x: M, y: PAGE_H - M - 26 }, end: { x: PAGE_W - M, y: PAGE_H - M - 26 },
                    thickness: 0.8, color: rgb(P, COL.navy) });
    return page;
  }

  function sectionHead(P, page, fonts, x, y, text) {
    page.drawText(text.toUpperCase(), { x: x, y: y, size: 7.5, font: fonts.bold, color: rgb(P, COL.muted) });
    return y - 13;
  }

  /* A compass rose. The sector count comes from the data (12 sectors of 30
     degrees today), each petal drawn as a hatched triangle because pdf-lib
     has no arc primitive and a wedge is indistinguishable from one at this
     size. Null sectors are skipped rather than drawn as zero. */
  function drawRosePdf(P, page, fonts, cx, cy, r, rose) {
    var i, k, maxv = 0;
    for (i = 0; i < rose.length; i++) if (rose[i] > maxv) maxv = rose[i];
    if (maxv <= 0) return;
    /* two reference rings so the petals can be read as percentages */
    for (k = 1; k <= 2; k++) {
      var rr = r * k / 2, seg = [], a;
      for (a = 0; a <= 360; a += 12) {
        seg.push({ x: cx + rr * Math.sin(a * Math.PI / 180), y: cy + rr * Math.cos(a * Math.PI / 180) });
      }
      for (i = 1; i < seg.length; i++) {
        page.drawLine({ start: seg[i - 1], end: seg[i], thickness: 0.3, color: rgb(P, COL.baseline) });
      }
    }
    var n = rose.length, half = Math.PI / n;
    for (i = 0; i < n; i++) {
      if (!rose[i]) continue;
      var ang = (i / n) * 2 * Math.PI;          /* 0 = north, clockwise */
      var len = r * (rose[i] / maxv);
      var p0 = { x: cx, y: cy };
      var p1 = { x: cx + len * Math.sin(ang - half), y: cy + len * Math.cos(ang - half) };
      var p2 = { x: cx + len * Math.sin(ang + half), y: cy + len * Math.cos(ang + half) };
      page.drawLine({ start: p0, end: p1, thickness: 0.6, color: rgb(P, COL.series) });
      page.drawLine({ start: p1, end: p2, thickness: 0.6, color: rgb(P, COL.series) });
      page.drawLine({ start: p2, end: p0, thickness: 0.6, color: rgb(P, COL.series) });
      /* fill by hatching: no polygon primitive, and a hollow petal reads as
         an outline drawing rather than a chart */
      var t;
      for (t = 0.08; t < 1; t += 0.08) {
        page.drawLine({
          start: { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t },
          end: { x: p0.x + (p2.x - p0.x) * t, y: p0.y + (p2.y - p0.y) * t },
          thickness: 0.7, color: rgb(P, COL.series)
        });
      }
    }
    var lbl = [["N", 0, r + 7], ["E", r + 6, 0], ["S", 0, -(r + 9)], ["W", -(r + 8), 0]];
    for (i = 0; i < lbl.length; i++) {
      page.drawText(lbl[i][0], { x: cx + lbl[i][1] - 2, y: cy + lbl[i][2] - 2, size: 6.5,
        font: fonts.reg, color: rgb(P, COL.muted) });
    }
    page.drawText(Math.round(maxv) + "%", { x: cx + 2, y: cy + r - 6, size: 5.5,
      font: fonts.reg, color: rgb(P, COL.muted) });
  }

  /* Peak-period distribution: one bar per band. */
  function drawHistPdf(P, page, fonts, x0, y0, w, h, spec) {
    var v = spec.values, i, maxv = 0;
    for (i = 0; i < v.length; i++) if (v[i] > maxv) maxv = v[i];
    if (maxv <= 0) maxv = 1;
    /* Round the top up to something readable, then label it: bars without a
       scale show shape but no magnitude. */
    /* halve cleanly so the mid gridline is not a rounded oddity like 13% */
    var caps = [2, 4, 10, 20, 30, 40, 50, 60, 80, 100], nice = 100, ci;
    for (ci = 0; ci < caps.length; ci++) { if (maxv * 1.06 <= caps[ci]) { nice = caps[ci]; break; } }
    var ml2 = 22, iw2 = w - ml2, ih2 = h - 12, g2;
    for (g2 = 0; g2 <= 2; g2++) {
      var gv2 = nice * g2 / 2, gy = y0 + (gv2 / nice) * ih2;
      page.drawLine({ start: { x: x0 + ml2, y: gy }, end: { x: x0 + w, y: gy },
        thickness: 0.5, color: rgb(P, g2 === 0 ? COL.baseline : COL.grid) });
      var gl = String(Math.round(gv2)) + "%";
      page.drawText(gl, { x: x0 + ml2 - 3 - fonts.reg.widthOfTextAtSize(gl, 6), y: gy - 2,
        size: 6, font: fonts.reg, color: rgb(P, COL.muted) });
    }
    maxv = nice;
    x0 = x0 + ml2;
    w = iw2;
    h = ih2 + 12;
    var bw = w / v.length;
    for (i = 0; i < v.length; i++) {
      var bh = (v[i] / maxv) * (h - 12);
      if (bh > 0) {
        page.drawRectangle({ x: x0 + i * bw + bw * 0.15, y: y0, width: bw * 0.7, height: bh,
          color: rgb(P, COL.series) });
      }
      if (i % 2 === 0) {
        var lb = String(spec.t0 + i * spec.step);
        page.drawText(lb, { x: x0 + i * bw + bw / 2 - fonts.reg.widthOfTextAtSize(lb, 6) / 2,
          y: y0 - 8, size: 6, font: fonts.reg, color: rgb(P, COL.muted) });
      }
    }
    page.drawText("peak period (s)", { x: x0 + w / 2 - 18, y: y0 - 17, size: 6,
      font: fonts.reg, color: rgb(P, COL.muted) });
  }

  function generate(state) {
    return ensurePdfLib(state.cfg.pdfLibSrc).then(function (P) {
      return P.PDFDocument.create().then(function (doc) {
        return Promise.all([
          doc.embedFont(P.StandardFonts.Helvetica),
          doc.embedFont(P.StandardFonts.HelveticaBold),
          loadLogo(doc, state.cfg.logoSrc)
        ]).then(function (fs) {
          var fonts = { reg: fs[0], bold: fs[1] };
          var logo = fs[2];
          var page = doc.addPage([PAGE_W, PAGE_H]);
          var y;

          /* watermark under everything in demo mode */
          if (state.isDemo) {
            page.drawText("DEMONSTRATION DATA", {
              x: 70, y: 200, size: 44, font: fonts.bold,
              color: rgb(P, COL.wm), rotate: P.degrees(40)
            });
          }

          /* header */
          if (logo) {
            var lgH = 22;
            page.drawImage(logo, {
              x: M, y: PAGE_H - M - 26,
              width: logo.width * (lgH / logo.height), height: lgH
            });
          } else {
            page.drawText(state.cfg.companyName.toUpperCase(), { x: M, y: PAGE_H - M - 12, size: 15, font: fonts.bold, color: rgb(P, COL.navy) });
          }
          var t1 = "Sea State Exceedance Summary";
          page.drawText(t1, { x: PAGE_W - M - fonts.bold.widthOfTextAtSize(t1, 11), y: PAGE_H - M - 8, size: 11, font: fonts.bold, color: rgb(P, COL.ink) });
          var dt = new Date();
          var t2 = "Generated " + dt.toISOString().slice(0, 10);
          page.drawText(t2, { x: PAGE_W - M - fonts.reg.widthOfTextAtSize(t2, 8.5), y: PAGE_H - M - 21, size: 8.5, font: fonts.reg, color: rgb(P, COL.muted) });
          page.drawLine({ start: { x: M, y: PAGE_H - M - 30 }, end: { x: PAGE_W - M, y: PAGE_H - M - 30 }, thickness: 0.8, color: rgb(P, COL.navy) });

          /* location block, left column */
          y = PAGE_H - M - 48;
          function field(label, value) {
            page.drawText(label.toUpperCase(), { x: M, y: y, size: 7, font: fonts.bold, color: rgb(P, COL.muted) });
            y -= 12;
            y = drawWrapped(page, fonts.reg, value, M, y, 10, 280, 12, rgb(P, COL.ink)) - 5;
          }
          field("Selected location", state.latLonLabel);
          field("Nearest data point", state.cellLabel);
          if (state.depthLabel) field("Water depth at data point", state.depthLabel);
          if (state.nearestLabel) field("Nearest mapped asset", state.nearestLabel);
          if (state.prevailingLabel) field("Prevailing conditions", state.prevailingLabel);
          field("Months", monthListLabel(state));
          field("Data basis", state.basisLabel);

          /* map snapshot, right */
          var mapY = PAGE_H - M - 48;
          var mapW = 210, mapH = 130, mapX = PAGE_W - M - mapW;
          var embedMap = state.mapPng
            ? doc.embedPng(state.mapPng.split(",")[1]).catch(function () { return null; })
            : Promise.resolve(null);

          return embedMap.then(function (img) {
            if (img) {
              page.drawImage(img, { x: mapX, y: mapY - mapH, width: mapW, height: mapH });
              page.drawRectangle({ x: mapX, y: mapY - mapH, width: mapW, height: mapH,
                borderColor: rgb(P, COL.baseline), borderWidth: 0.8 });
            }
            y = Math.min(y, mapY - mapH) - 16;

            /* headline */
            var big = state.headlineBig, sub = state.headlineSub;
            page.drawText(big, { x: M, y: y - 20, size: 27, font: fonts.bold, color: rgb(P, COL.ink) });
            var bigW = fonts.bold.widthOfTextAtSize(big, 27);
            drawWrapped(page, fonts.reg, sub, M + bigW + 12, y - 8, 10, PAGE_W - 2 * M - bigW - 12, 12, rgb(P, COL.ink2));
            y -= 40;

            /* charts */
            var chartH = 165;
            page.drawText("Chance of exceeding a given wave height", { x: M, y: y - 10, size: 8.5, font: fonts.bold, color: rgb(P, COL.ink2) });
            page.drawText("Time above " + state.limit + " m, by month", { x: 360, y: y - 10, size: 8.5, font: fonts.bold, color: rgb(P, COL.ink2) });
            drawCurvePdf(P, page, fonts, M, y - 16 - chartH, 300, chartH,
              { thresholds: state.thresholds, p: state.combined.p, limit: state.limit });
            drawBarsPdf(P, page, fonts, 360, y - 16 - chartH, PAGE_W - M - 360, chartH,
              { values: state.monthlyAtLimit, selected: state.selectedFlags, monthNames: state.monthNames });
            y = y - 16 - chartH - 16;

            /* table, left + notes, right */
            var tx = M, tw = 300;
            var col2 = tx + 150, col3 = tx + 230;
            page.drawText("Hs threshold", { x: tx, y: y - 8, size: 8, font: fonts.bold, color: rgb(P, COL.ink2) });
            page.drawText("% of time above", { x: col2 - fonts.bold.widthOfTextAtSize("% of time above", 8), y: y - 8, size: 8, font: fonts.bold, color: rgb(P, COL.ink2) });
            page.drawText("approx days/month", { x: col3 + 70 - fonts.bold.widthOfTextAtSize("approx days/month", 8), y: y - 8, size: 8, font: fonts.bold, color: rgb(P, COL.ink2) });
            page.drawLine({ start: { x: tx, y: y - 12 }, end: { x: tx + tw, y: y - 12 }, thickness: 0.6, color: rgb(P, COL.baseline) });
            var ry = y - 22, i, pv, txt1, txt2, txt3;
            for (i = 0; i < state.thresholds.length; i++) {
              pv = state.combined.p[i];
              txt1 = state.thresholds[i].toFixed(1) + " m";
              txt2 = pv === null ? "no data" : window.TMData.fmtPct(pv).replace("<", "under ");
              txt3 = pv === null ? "-" : (pv * 0.3044).toFixed(pv * 0.3044 < 3 ? 1 : 0);
              page.drawText(txt1, { x: tx, y: ry, size: 8, font: fonts.reg, color: rgb(P, COL.ink) });
              page.drawText(txt2, { x: col2 - fonts.reg.widthOfTextAtSize(txt2, 8), y: ry, size: 8, font: fonts.reg, color: rgb(P, COL.ink) });
              page.drawText(txt3, { x: col3 + 70 - fonts.reg.widthOfTextAtSize(txt3, 8), y: ry, size: 8, font: fonts.reg, color: rgb(P, COL.ink) });
              ry -= 11.2;
            }

            /* notes column */
            var nx = 360, nw = PAGE_W - M - nx;
            page.drawText("READ THIS FIRST", { x: nx, y: y - 8, size: 7, font: fonts.bold, color: rgb(P, COL.muted) });
            var noteY = y - 20;
            noteY = drawWrapped(page, fonts.reg,
              "Long term climatological averages for open water. Not a forecast. " +
              "Values close to coastlines, in sheltered or shallow water, and in tropical " +
              "cyclone conditions are unreliable. Extremes may be underestimated." +
              (state.assetsShown || state.depthLabel
                ? " Depth bands and asset positions are indicative, never for navigation."
                : ""),
              nx, noteY, 7.5, nw, 9.5, rgb(P, COL.ink2)) - 6;
            noteY = drawWrapped(page, fonts.bold,
              "Specialist lifting solutions for subsea operations: " + state.cfg.website.replace(/^https?:\/\//, ""),
              nx, noteY, 7.5, nw, 9.5, rgb(P, COL.navy)) - 4;
            if (state.shareUrl) {
              /* the URL is one unbroken token, so wrap it by measured width */
              page.drawText("Interactive version of this page:",
                { x: nx, y: noteY, size: 6.8, font: fonts.reg, color: rgb(P, COL.muted) });
              noteY -= 8.8;
              var rest = String(state.shareUrl);
              while (rest.length) {
                var take = rest.length;
                while (take > 1 && fonts.reg.widthOfTextAtSize(rest.slice(0, take), 6.8) > nw) take--;
                page.drawText(rest.slice(0, take),
                  { x: nx, y: noteY, size: 6.8, font: fonts.reg, color: rgb(P, COL.muted) });
                noteY -= 8.8;
                rest = rest.slice(take);
              }
              noteY -= 4;
            }

            /* holistic site snapshot: extremes, wind, weather windows,
               current and tide. Optional lines, clipped above the footer. */
            var snap = [];
            if (state.extremesLabel) snap.push(state.extremesLabel);
            if (state.windLabel) snap.push(state.windLabel);
            if (state.tpModeLabel) snap.push(state.tpModeLabel);
            if (state.windowsLabel) snap.push(state.windowsLabel);
            if (state.daylightLabel) snap.push(state.daylightLabel);
            if (state.diurnalLabel) snap.push(state.diurnalLabel);
            if (state.cycLabel) snap.push(state.cycLabel);
            if (state.ensoLabel) snap.push("El Nino vs La Nina: " + state.ensoLabel);
            if (state.curLines) snap = snap.concat(state.curLines);
            if (snap.length) {
              noteY -= 6;
              page.drawText("SITE SNAPSHOT", { x: nx, y: noteY, size: 7, font: fonts.bold, color: rgb(P, COL.muted) });
              noteY -= 11;
              var si;
              for (si = 0; si < snap.length; si++) {
                if (noteY < 96) break;   /* stay clear of the footer rule */
                noteY = drawWrapped(page, fonts.reg, snap[si], nx, noteY, 7.5, nw, 9.5, rgb(P, COL.ink2)) - 4;
              }
            }

            /* footer */
            var fy = 78;
            page.drawLine({ start: { x: M, y: fy }, end: { x: PAGE_W - M, y: fy }, thickness: 0.5, color: rgb(P, COL.baseline) });
            var disc = state.disclaimer + " " + state.meta.attribution;
            var endY = drawWrapped(page, fonts.reg, disc, M, fy - 11, 6.6, PAGE_W - 2 * M, 8.2, rgb(P, COL.muted));
            page.drawText(state.cfg.companyName + " | " + state.cfg.website.replace(/^https?:\/\//, ""),
              { x: M, y: endY - 4, size: 7.5, font: fonts.bold, color: rgb(P, COL.navy) });

            /* ---------- page 2: month by month ---------- */
            var hdrSub = state.latLonLabel + "  " + monthListLabel(state);
            var p2 = addPage(doc, P, fonts, logo, "Month by month", hdrSub);
            var y2 = PAGE_H - M - 44;

            y2 = sectionHead(P, p2, fonts, M, y2, "Time above " + state.limit + " m, by month");
            drawBarsPdf(P, p2, fonts, M, y2 - 150, PAGE_W - 2 * M, 150,
              { values: state.monthlyAtLimit, selected: state.selectedFlags, monthNames: state.monthNames });
            y2 = y2 - 150 - 26;

            /* The matrix is the part a one page summary could never carry:
               every month against every threshold, which is what someone
               planning a campaign window actually reads. */
            y2 = sectionHead(P, p2, fonts, M, y2, "Percentage of time above each wave height, by month");
            var thr = state.thresholds, nT = Math.min(thr.length, 9);
            var cw = (PAGE_W - 2 * M - 46) / nT;
            var hx = M + 46, ti, mi;
            for (ti = 0; ti < nT; ti++) {
              var th = thr[ti].toFixed(1);
              p2.drawText(th, { x: hx + ti * cw + cw / 2 - fonts.bold.widthOfTextAtSize(th, 7) / 2,
                y: y2, size: 7, font: fonts.bold, color: rgb(P, COL.ink2) });
            }
            /* The unit goes in the empty left cell of the header row, on the
               same baseline as the threshold numbers it belongs to. It was
               at y2 + 12, which is one point off the section heading's own
               baseline, so the two printed on top of each other. */
            p2.drawText("Hs (m)", { x: M, y: y2, size: 6.5,
              font: fonts.bold, color: rgb(P, COL.muted) });
            y2 -= 5;
            p2.drawLine({ start: { x: M, y: y2 }, end: { x: PAGE_W - M, y: y2 }, thickness: 0.6, color: rgb(P, COL.baseline) });
            y2 -= 11;
            for (mi = 0; mi < 12; mi++) {
              var on = state.selectedFlags[mi];
              var mcol = on ? COL.ink : COL.dim;
              p2.drawText(state.monthNames[mi], { x: M, y: y2, size: 7.5,
                font: on ? fonts.bold : fonts.reg, color: rgb(P, mcol) });
              for (ti = 0; ti < nT; ti++) {
                var pv2 = (state.monthN[mi] > 0 && state.monthExc[mi]) ? state.monthExc[mi][ti] : null;
                var cell = pv2 === null || pv2 === undefined
                  ? "-" : window.TMData.fmtPct(pv2).replace("<", "under ");
                p2.drawText(cell, { x: hx + ti * cw + cw / 2 - fonts.reg.widthOfTextAtSize(cell, 7) / 2,
                  y: y2, size: 7, font: fonts.reg, color: rgb(P, mcol) });
              }
              y2 -= 11.5;
            }
            y2 -= 6;
            drawWrapped(p2, fonts.reg,
              "Months in bold are the ones selected for the headline figure on page 1. " +
              "Every month is shown so a different working window can be judged from the same table.",
              M, y2, 7, PAGE_W - 2 * M, 9, rgb(P, COL.muted));
            y2 -= 24;

            if (state.windows) {
              y2 = sectionHead(P, p2, fonts, M, y2, "Weather windows by month: spells below " +
                state.windows.thr + " m lasting " + state.windows.dur + " h or more");
              drawBarsPdf(P, p2, fonts, M, y2 - 130, PAGE_W - 2 * M, 130,
                { values: state.windows.values, selected: state.selectedFlags,
                  monthNames: state.monthNames, unit: "" });
              y2 = y2 - 130 - 14;
              if (state.windowsLabel) {
                drawWrapped(p2, fonts.reg, state.windowsLabel, M, y2, 7.5, PAGE_W - 2 * M, 9.5, rgb(P, COL.ink2));
              }
            }

            /* ---------- page 3: wind and sea state ---------- */
            var p3 = addPage(doc, P, fonts, logo, "Wind and sea state", hdrSub);
            var y3 = PAGE_H - M - 44;
            var colW = (PAGE_W - 2 * M - 20) / 2;

            if (state.rose || state.vrose) {
              y3 = sectionHead(P, p3, fonts, M, y3, "Direction");
              var roseR = 62, roseY = y3 - roseR - 12;
              var both = !!(state.rose && state.vrose);
              function placeRose(cx, title, data) {
                var tw2 = fonts.bold.widthOfTextAtSize(title, 8);
                p3.drawText(title, { x: cx - tw2 / 2, y: y3 - 2, size: 8,
                  font: fonts.bold, color: rgb(P, COL.ink2) });
                drawRosePdf(P, p3, fonts, cx, roseY, roseR, data);
              }
              if (both) {
                placeRose(M + colW / 2, "Where waves come from", state.rose);
                placeRose(M + colW + 20 + colW / 2, "Where wind comes from", state.vrose);
              } else if (state.rose) {
                placeRose(PAGE_W / 2, "Where waves come from", state.rose);
              } else {
                placeRose(PAGE_W / 2, "Where wind comes from", state.vrose);
              }
              y3 = roseY - roseR - 26;
              drawWrapped(p3, fonts.reg,
                "Petals point the way the waves or wind come FROM. The outer ring is the " +
                "most common sector; the figure beside it is its share of the time.",
                M, y3, 7, PAGE_W - 2 * M, 9, rgb(P, COL.muted));
              y3 -= 22;
            }

            if (state.tpAgg) {
              y3 = sectionHead(P, p3, fonts, M, y3, "Peak period, share of time in each band");
              drawHistPdf(P, p3, fonts, M, y3 - 118, PAGE_W - 2 * M, 118,
                { values: state.tpAgg.pct, t0: state.tpAgg.t0, step: state.tpAgg.step });
              y3 = y3 - 118 - 24;
              if (state.tpModeLabel) {
                y3 = drawWrapped(p3, fonts.reg, state.tpModeLabel, M, y3, 7.5, PAGE_W - 2 * M, 9.5, rgb(P, COL.ink2)) - 4;
              }
              y3 = drawWrapped(p3, fonts.reg,
                "Multiple humps usually mean multiple seas, for example local wind waves " +
                "and longer swell.",
                M, y3, 7, PAGE_W - 2 * M, 9, rgb(P, COL.muted)) - 16;
            }

            var facts = [];
            if (state.windLabel) facts.push(["Wind", state.windLabel]);
            if (state.extremesLabel) facts.push(["Extreme sea states", state.extremesLabel]);
            if (state.prevailingLabel) facts.push(["Prevailing conditions", state.prevailingLabel]);
            if (state.daylightLabel) facts.push(["Daylight", state.daylightLabel]);
            if (facts.length) {
              y3 = sectionHead(P, p3, fonts, M, y3, "In numbers");
              var fi;
              for (fi = 0; fi < facts.length && y3 > 70; fi++) {
                p3.drawText(facts[fi][0].toUpperCase(), { x: M, y: y3, size: 6.5,
                  font: fonts.bold, color: rgb(P, COL.muted) });
                y3 = drawWrapped(p3, fonts.reg, facts[fi][1], M, y3 - 10, 8, PAGE_W - 2 * M, 10, rgb(P, COL.ink)) - 8;
              }
            }

            /* ---------- page 4: cyclones, tide, notes ---------- */
            var p4 = addPage(doc, P, fonts, logo, "Exposure and notes", hdrSub);
            var y4 = PAGE_H - M - 44;

            if (state.cyc) {
              y4 = sectionHead(P, p4, fonts, M, y4, "Tropical cyclone exposure within " +
                state.cyc.radius + " nm, storm-days per month");
              drawBarsPdf(P, p4, fonts, M, y4 - 130, PAGE_W - 2 * M, 130,
                { values: state.cyc.days, selected: state.selectedFlags,
                  monthNames: state.monthNames, unit: "" });
              y4 = y4 - 130 - 16;
              if (state.cycLabel) {
                y4 = drawWrapped(p4, fonts.reg, state.cycLabel, M, y4, 7.5, PAGE_W - 2 * M, 9.5, rgb(P, COL.ink2)) - 16;
              }
            }

            if (state.diurnal && state.diurnalLabel) {
              y4 = sectionHead(P, p4, fonts, M, y4, "Across the day");
              y4 = drawWrapped(p4, fonts.reg, state.diurnalLabel, M, y4, 8, PAGE_W - 2 * M, 10, rgb(P, COL.ink)) - 16;
            }

            if (state.curLines && state.curLines.length) {
              y4 = sectionHead(P, p4, fonts, M, y4, "Current and tide");
              var ci;
              for (ci = 0; ci < state.curLines.length && y4 > 150; ci++) {
                y4 = drawWrapped(p4, fonts.reg, state.curLines[ci], M, y4, 8, PAGE_W - 2 * M, 10, rgb(P, COL.ink)) - 5;
              }
              y4 -= 12;
            }

            if (state.ensoLabel) {
              y4 = sectionHead(P, p4, fonts, M, y4, "El Nino and La Nina");
              y4 = drawWrapped(p4, fonts.reg, state.ensoLabel, M, y4, 8, PAGE_W - 2 * M, 10, rgb(P, COL.ink)) - 16;
            }

            y4 = sectionHead(P, p4, fonts, M, y4, "How to read this report");
            y4 = drawWrapped(p4, fonts.reg,
              "These are long term climatological statistics, not a forecast. They describe how the " +
              "sea behaved at this point over the record, month by month, which is what early stage " +
              "planning needs. They do not tell you what next Tuesday looks like, and they will " +
              "underestimate extremes close to coastlines, in sheltered or shallow water, and in " +
              "tropical cyclone conditions. Real operability also depends on spectral detail, " +
              "current and tide, and how your vessel responds.",
              M, y4, 8, PAGE_W - 2 * M, 10.5, rgb(P, COL.ink2)) - 18;

            y4 = sectionHead(P, p4, fonts, M, y4, "Sources");
            y4 = drawWrapped(p4, fonts.reg, state.allSources || state.meta.attribution, M, y4, 7, PAGE_W - 2 * M, 9, rgb(P, COL.muted)) - 16;

            /* closing call to action, mirroring page 1 */
            p4.drawRectangle({ x: M, y: 92, width: PAGE_W - 2 * M, height: 54, color: rgb(P, COL.navy) });
            p4.drawText("Planning a subsea lift?", { x: M + 14, y: 124, size: 12,
              font: fonts.bold, color: P.rgb(1, 1, 1) });
            drawWrapped(p4, fonts.reg,
              "Weather windows decide when a lift can go. Thrust Maritime provides specialist " +
              "lifting solutions for subsea operations. " + state.cfg.website.replace(/^https?:\/\//, ""),
              M + 14, 110, 8.5, PAGE_W - 2 * M - 28, 11, P.rgb(0.87, 0.91, 0.95));

            /* ---------- page numbers, once the total is known ---------- */
            var pages = doc.getPages(), pi2;
            for (pi2 = 0; pi2 < pages.length; pi2++) {
              var lbl2 = "Page " + (pi2 + 1) + " of " + pages.length;
              pages[pi2].drawText(lbl2, {
                x: PAGE_W - M - fonts.reg.widthOfTextAtSize(lbl2, 7),
                y: 60, size: 7, font: fonts.reg, color: rgb(P, COL.muted)
              });
            }

            return doc.save();
          });
        });
      });
    });
  }

  function deliver(bytes, filename, mode) {
    if (mode === "inline") {
      var b64 = "";
      var chunk = 0x8000, i, sub;
      for (i = 0; i < bytes.length; i += chunk) {
        sub = bytes.subarray(i, i + chunk);
        b64 += String.fromCharCode.apply(null, sub);
      }
      var uri = "data:application/pdf;base64," + btoa(b64);
      var ov = document.createElement("div");
      ov.style.cssText = "position:fixed;inset:0;z-index:100;background:rgba(10,15,20,0.65);display:flex;flex-direction:column;padding:24px;";
      var bar = document.createElement("div");
      bar.style.cssText = "display:flex;justify-content:flex-end;margin-bottom:8px;";
      var btn = document.createElement("button");
      btn.textContent = "Close preview";
      btn.style.cssText = "background:#fcfcfb;border:none;border-radius:7px;padding:8px 14px;font-size:14px;cursor:pointer;";
      btn.onclick = function () { document.body.removeChild(ov); };
      bar.appendChild(btn);
      var fr = document.createElement("iframe");
      fr.src = uri;
      fr.style.cssText = "flex:1;border:none;border-radius:8px;background:#fff;";
      ov.appendChild(bar);
      ov.appendChild(fr);
      document.body.appendChild(ov);
      return;
    }
    var blob = new Blob([bytes], { type: "application/pdf" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      document.body.removeChild(a);
    }, 1500);
  }

  window.TMReport = { generate: generate, deliver: deliver };
})();
