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
      s.src = src || "vendor/pdf-lib.min.js";
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
    var caps = [4, 8, 12, 20, 40, 60, 80, 100], niceMax = 100;
    for (i = 0; i < caps.length; i++) { if (vmax * 1.06 <= caps[i]) { niceMax = caps[i]; break; } }
    function Y(p) { return y0 + mb + (p / niceMax) * ih; }
    var g, lbl;
    for (g = 0; g <= 4; g++) {
      var gv = niceMax * g / 4;
      page.drawLine({ start: { x: x0 + ml, y: Y(gv) }, end: { x: x0 + ml + iw, y: Y(gv) },
        thickness: 0.5, color: rgb(P, g === 0 ? COL.baseline : COL.grid) });
      lbl = (niceMax < 20 && gv % 1 ? gv.toFixed(1) : String(Math.round(gv))) + "%";
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

  function generate(state) {
    return ensurePdfLib(state.cfg.pdfLibSrc).then(function (P) {
      return P.PDFDocument.create().then(function (doc) {
        return Promise.all([
          doc.embedFont(P.StandardFonts.Helvetica),
          doc.embedFont(P.StandardFonts.HelveticaBold)
        ]).then(function (fs) {
          var fonts = { reg: fs[0], bold: fs[1] };
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
          page.drawText(state.cfg.companyName.toUpperCase(), { x: M, y: PAGE_H - M - 12, size: 15, font: fonts.bold, color: rgb(P, COL.navy) });
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
