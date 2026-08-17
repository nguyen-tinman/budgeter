// Sandbox harness for the assistant-authored /custom page.
//
// HARNESS_HTML is the complete `srcdoc` of the iframe that runs the definition's
// `render` function. It is the ONLY place in apps/web where `new Function` (or
// any other eval-family construct) appears, and it only ever runs inside an
// iframe carrying `sandbox="allow-scripts"` with NO `allow-same-origin` — so the
// code executes on an opaque origin with no access to cookies, storage, the
// parent DOM, or this app's session. The CSP meta below is the first element in
// <head> so it applies to everything after it:
//
//   default-src 'none'   — no network at all (fetch/XHR/WebSocket/fonts/frames)
//   script-src 'unsafe-inline' 'unsafe-eval'
//                        — 'unsafe-eval' is REQUIRED: `new Function` throws
//                          without it, and that confined eval is the entire
//                          design. It is confined to this opaque origin.
//   style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'
//
// The harness itself builds every node with createElement/createElementNS and
// textContent — there is no innerHTML anywhere in this file. Untrusted strings
// (labels, titles, formatted numbers) therefore can never be parsed as markup.
//
// Message protocol (both sides check `event.source`):
//   parent → iframe  { type: "bk:render", nonce, render, data, meta }
//   iframe → parent  { type: "bk:ready" }
//                    { type: "bk:height", nonce, px }
//                    { type: "bk:error",  nonce, message }
//                    { type: "bk:done",   nonce }
//
// NOTE ON EDITING: the script below is emitted verbatim into an HTML document.
// Do not introduce a literal "</script" sequence, and do not use template
// literals or backslash escapes inside it — the outer TypeScript template
// literal would consume them. Newlines inside harness string literals are built
// with String.fromCharCode(10).

/** Theme tokens the host copies out of its own computed style and applies as
 *  CSS custom properties inside the harness, so charts match the app's theme. */
export const CUSTOM_HARNESS_THEME_VARS = [
  "--bg",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--border",
  "--border-strong",
  "--text",
  "--text-2",
  "--text-3",
  "--accent",
  "--positive",
  "--negative",
  "--warning",
  "--info",
  "--font-num",
] as const;

/** Message the host posts into the harness. */
export interface HarnessRenderMessage {
  type: "bk:render";
  nonce: number;
  render: string;
  data: Record<string, unknown>;
  meta: {
    title: string;
    workspaceId: number | null;
    palette: Array<{ id: number; name: string; color: string }>;
    theme: Record<string, string>;
  };
}

/** Messages the harness posts back out. */
export type HarnessOutboundMessage =
  | { type: "bk:ready" }
  | { type: "bk:height"; nonce: number | null; px: number }
  | { type: "bk:error"; nonce: number | null; message: string }
  | { type: "bk:done"; nonce: number | null };

export const HARNESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<meta charset="utf-8">
<title>Custom page canvas</title>
<style>
  :root {
    --bg: #0c0b08;
    --surface: #14130f;
    --surface-2: #1c1a14;
    --surface-3: #25221b;
    --border: #2e2a21;
    --border-strong: #45402f;
    --text: #f1ebd9;
    --text-2: #b9b09a;
    --text-3: #7c7560;
    --accent: #d8a05a;
    --positive: #7ec98a;
    --negative: #d97a5a;
    --warning: #d9b45a;
    --info: #7a9ec9;
    --font-num: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    padding: 2px 0 4px;
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    overflow-x: auto;
    overflow-y: hidden;
  }
  #root { min-width: 0; }
  h1, h2, h3, h4 { margin: 0 0 8px; font-weight: 600; line-height: 1.25; }
  h1 { font-size: 19px; }
  h2 { font-size: 16px; }
  h3 { font-size: 14px; }
  p { margin: 0 0 8px; color: var(--text-2); }
  a { color: var(--accent); }
  .bk-hx-note { color: var(--text-3); font-size: 12px; margin: 6px 0 0; }
  .bk-hx-chart { width: 100%; max-width: 100%; height: auto; display: block; }
  .bk-hx-legend {
    display: flex; flex-wrap: wrap; gap: 4px 14px;
    margin: 6px 0 0; font-size: 11.5px; color: var(--text-2);
  }
  .bk-hx-legend > span { display: inline-flex; align-items: center; gap: 6px; }
  .bk-hx-swatch { width: 9px; height: 9px; border-radius: 2px; flex: 0 0 auto; }
  .bk-hx-empty {
    color: var(--text-3); font-size: 12.5px; font-style: italic;
    padding: 18px 0; text-align: center;
  }
  table.bk-hx-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  table.bk-hx-table th {
    text-align: left; font-size: 10.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3);
    padding: 6px 10px; border-bottom: 1px solid var(--border-strong);
    white-space: nowrap;
  }
  table.bk-hx-table td {
    padding: 7px 10px; border-bottom: 1px dotted var(--border); color: var(--text);
  }
  table.bk-hx-table tr:last-child td { border-bottom: 0; }
  table.bk-hx-table .num {
    text-align: right; font-family: var(--font-num); font-variant-numeric: tabular-nums;
  }
  table.bk-hx-table .right { text-align: right; }
  table.bk-hx-table .center { text-align: center; }
  .bk-hx-axis { fill: var(--text-3); font-size: 10px; font-family: var(--font-num); }
  .bk-hx-grid { stroke: var(--border); stroke-width: 1; }
  .bk-hx-zero { stroke: var(--border-strong); stroke-width: 1; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  "use strict";

  var NL = String.fromCharCode(10);
  var TAB = String.fromCharCode(9);
  var CR = String.fromCharCode(13);

  // Does the body OPEN by declaring a function instead of doing work — i.e.
  // "function render(...)", "async function(...)", or "(root, ...) =>"?
  //
  // Deliberately hand-scanned rather than a regex. This whole script lives
  // inside a TEMPLATE LITERAL and is parsed again as JS by the browser, so a
  // pattern written here loses a level of escaping at each step: a regex
  // literal is mangled into an unterminated group (a PARSE error that kills the
  // harness outright), and even the RegExp-from-string form degrades to "s" and
  // throws at construction. Plain string operations survive both layers.
  //
  // For the same reason nothing below may use a backslash escape or a backtick:
  // TAB/CR/NL come from String.fromCharCode, since a raw CR inside an emitted
  // string literal is itself a syntax error.
  function skipToCode(src) {
    var i = 0;
    while (i < src.length) {
      var c = src.charAt(i);
      if (c === " " || c === TAB || c === CR || c === NL) { i += 1; continue; }
      if (c === "/" && src.charAt(i + 1) === "/") {
        var eol = src.indexOf(NL, i);
        if (eol === -1) return src.length;
        i = eol + 1;
        continue;
      }
      if (c === "/" && src.charAt(i + 1) === "*") {
        var close = src.indexOf("*" + "/", i);
        if (close === -1) return src.length;
        i = close + 2;
        continue;
      }
      break;
    }
    return i;
  }
  function looksLikeDeclaration(src) {
    var rest = src.slice(skipToCode(src));
    if (rest.indexOf("function") === 0 || rest.indexOf("async") === 0) return true;
    // Arrow form: an opening paren, then "=>" after the matching-ish close.
    if (rest.charAt(0) !== "(") return false;
    var close = rest.indexOf(")");
    if (close === -1) return false;
    var after = rest.slice(close + 1);
    return after.slice(skipToCode(after)).indexOf("=>") === 0;
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  var rootEl = document.getElementById("root");
  var currentNonce = null;
  var reportedErrorNonce = null;

  function send(msg) {
    // targetOrigin "*" is unavoidable: the parent's origin is not observable
    // from an opaque-origin iframe. The payload carries nothing the parent did
    // not already send in, and the parent verifies event.source before reading.
    window.parent.postMessage(msg, "*");
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function isFiniteNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function appendChildren(node, children) {
    if (children === null || children === undefined) return;
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i++) appendChildren(node, children[i]);
      return;
    }
    if (children instanceof Node) { node.appendChild(children); return; }
    node.appendChild(document.createTextNode(String(children)));
  }

  function applyAttrs(node, attrs) {
    if (!attrs || typeof attrs !== "object") return;
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "text") { node.textContent = String(v); continue; }
      if (k === "style" && v && typeof v === "object") {
        for (var p in v) {
          if (Object.prototype.hasOwnProperty.call(v, p)) node.style.setProperty(p, String(v[p]));
        }
        continue;
      }
      node.setAttribute(k, v === true ? "" : String(v));
    }
  }

  // HTML element builder handed to render code as bk.el.
  function el(tag, attrs, children) {
    var node = document.createElement(String(tag || "div"));
    applyAttrs(node, attrs);
    appendChildren(node, children);
    return node;
  }

  // SVG builder (internal to the chart helpers).
  function svgEl(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    applyAttrs(node, attrs);
    appendChildren(node, children);
    return node;
  }

  function svgText(x, y, str, cls, anchor) {
    var t = svgEl("text", {
      x: x, y: y, class: cls || "bk-hx-axis",
      "text-anchor": anchor || "middle"
    });
    t.textContent = String(str);
    return t;
  }

  function formatDollars(n) {
    if (!isFiniteNum(n)) return "\\u2014";
    var abs = Math.abs(n);
    var out = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? "\\u2212$" : "$") + out;
  }

  function shortNumber(n) {
    if (!isFiniteNum(n)) return "";
    var abs = Math.abs(n);
    var sign = n < 0 ? "\\u2212" : "";
    if (abs >= 1000000) return sign + (abs / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + "M";
    if (abs >= 1000) return sign + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + "k";
    if (abs >= 10) return sign + Math.round(abs);
    return sign + abs.toFixed(abs === Math.round(abs) ? 0 : 1);
  }

  function emptyBox(parent, text) {
    var d = el("div", { class: "bk-hx-empty" }, text || "No data to plot.");
    parent.appendChild(d);
    return d;
  }

  function resolveTarget(target) {
    return target instanceof Node ? target : rootEl;
  }

  // Nice-ish axis bounds: pad the range and snap to a round step.
  function axisBounds(min, max) {
    if (!isFiniteNum(min) || !isFiniteNum(max)) return { lo: 0, hi: 1, step: 1 };
    if (min > 0) min = 0;
    if (max < 0) max = 0;
    if (min === max) { max = min + 1; }
    var span = max - min;
    var raw = span / 4;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    // A zero/NaN step would make the tick loop in drawYAxis run forever. The
    // guards above should make that unreachable; this makes it impossible.
    if (!isFiniteNum(step) || step <= 0) step = 1;
    return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step: step };
  }

  function drawFrame(opts) {
    var W = 720;
    var H = Math.max(140, Math.min(900, Math.round(opts.height || 260)));
    var m = { top: 12, right: 14, bottom: opts.bottom === undefined ? 30 : opts.bottom, left: opts.left === undefined ? 58 : opts.left };
    // width:100% via CSS + a viewBox and NO preserveAspectRatio override, so
    // the chart scales uniformly with the panel instead of stretching text.
    var svg = svgEl("svg", {
      class: "bk-hx-chart",
      viewBox: "0 0 " + W + " " + H,
      role: "img"
    });
    var titleNode = svgEl("title");
    titleNode.textContent = opts.label ? String(opts.label) : "Chart";
    svg.appendChild(titleNode);
    return { svg: svg, W: W, H: H, m: m, iw: W - m.left - m.right, ih: H - m.top - m.bottom };
  }

  function drawYAxis(f, bounds, fmt) {
    for (var v = bounds.lo; v <= bounds.hi + bounds.step / 1000; v += bounds.step) {
      var frac = (bounds.hi - v) / (bounds.hi - bounds.lo || 1);
      var y = f.m.top + frac * f.ih;
      f.svg.appendChild(svgEl("line", {
        class: v === 0 ? "bk-hx-zero" : "bk-hx-grid",
        x1: f.m.left, x2: f.m.left + f.iw, y1: y, y2: y
      }));
      f.svg.appendChild(svgText(f.m.left - 8, y + 3.5, fmt(v), "bk-hx-axis", "end"));
    }
  }

  function legend(parent, entries) {
    if (!entries.length) return;
    var box = el("div", { class: "bk-hx-legend" });
    for (var i = 0; i < entries.length; i++) {
      var sw = el("i", { class: "bk-hx-swatch", style: { background: entries[i].color, display: "inline-block" } });
      box.appendChild(el("span", null, [sw, String(entries[i].label)]));
    }
    parent.appendChild(box);
  }

  function makeBk(meta) {
    var palette = Array.isArray(meta.palette) ? meta.palette : [];
    var colors = palette.map(function (c) { return c && c.color ? String(c.color) : "#9a9a9a"; });
    if (!colors.length) colors = ["#c97a4a", "#7a9ec9", "#a07cc9", "#c9a14a", "#7ec98a", "#c97a98", "#5db8b8", "#9a9a9a"];

    function colorFor(i) {
      var n = Number(i);
      if (!isFiniteNum(n)) n = 0;
      return colors[((Math.floor(n) % colors.length) + colors.length) % colors.length];
    }

    function lineChart(target, opts) {
      var parent = resolveTarget(target);
      opts = opts || {};
      var series = Array.isArray(opts.series) ? opts.series : [];
      var fmt = typeof opts.yFormat === "function" ? opts.yFormat : shortNumber;
      var clean = [];
      for (var i = 0; i < series.length; i++) {
        var pts = Array.isArray(series[i] && series[i].points) ? series[i].points : [];
        var kept = [];
        for (var j = 0; j < pts.length; j++) {
          if (pts[j] && isFiniteNum(Number(pts[j].y))) {
            kept.push({ x: pts[j].x, y: Number(pts[j].y) });
          }
        }
        if (kept.length) {
          clean.push({
            label: series[i].label === undefined ? "Series " + (i + 1) : String(series[i].label),
            color: series[i].color ? String(series[i].color) : colorFor(i),
            points: kept
          });
        }
      }
      if (!clean.length) return emptyBox(parent, "No points to plot.");

      // Numeric x when every x parses as a finite number; otherwise index the
      // points and use their x values as category labels.
      var numericX = true;
      var labels = [];
      for (var s = 0; s < clean.length && numericX; s++) {
        for (var p = 0; p < clean[s].points.length; p++) {
          if (!isFiniteNum(Number(clean[s].points[p].x))) { numericX = false; break; }
        }
      }
      var xMin = 0, xMax = 1;
      if (numericX) {
        xMin = Infinity; xMax = -Infinity;
        for (var a = 0; a < clean.length; a++) {
          for (var b = 0; b < clean[a].points.length; b++) {
            var xv = Number(clean[a].points[b].x);
            if (xv < xMin) xMin = xv;
            if (xv > xMax) xMax = xv;
          }
        }
        if (xMin === xMax) { xMax = xMin + 1; }
      } else {
        var longest = 0;
        for (var c = 0; c < clean.length; c++) {
          if (clean[c].points.length > longest) { longest = clean[c].points.length; labels = clean[c].points.map(function (q) { return String(q.x); }); }
        }
        xMin = 0; xMax = Math.max(1, longest - 1);
      }

      var yMin = Infinity, yMax = -Infinity;
      for (var d = 0; d < clean.length; d++) {
        for (var e = 0; e < clean[d].points.length; e++) {
          if (clean[d].points[e].y < yMin) yMin = clean[d].points[e].y;
          if (clean[d].points[e].y > yMax) yMax = clean[d].points[e].y;
        }
      }
      var bounds = axisBounds(yMin, yMax);
      var f = drawFrame({ height: opts.height || 280, label: opts.label });
      drawYAxis(f, bounds, fmt);

      function px(xv, idx) { var v = numericX ? Number(xv) : idx; return f.m.left + ((v - xMin) / (xMax - xMin || 1)) * f.iw; }
      function py(yv) { return f.m.top + ((bounds.hi - yv) / (bounds.hi - bounds.lo || 1)) * f.ih; }

      for (var k = 0; k < clean.length; k++) {
        var pointsAttr = [];
        for (var n = 0; n < clean[k].points.length; n++) {
          pointsAttr.push(px(clean[k].points[n].x, n).toFixed(2) + "," + py(clean[k].points[n].y).toFixed(2));
        }
        f.svg.appendChild(svgEl("polyline", {
          fill: "none", stroke: clean[k].color, "stroke-width": 2,
          "stroke-linejoin": "round", "stroke-linecap": "round",
          points: pointsAttr.join(" ")
        }));
        if (clean[k].points.length <= 40) {
          for (var q2 = 0; q2 < clean[k].points.length; q2++) {
            f.svg.appendChild(svgEl("circle", {
              cx: px(clean[k].points[q2].x, q2), cy: py(clean[k].points[q2].y), r: 2.5, fill: clean[k].color
            }));
          }
        }
      }

      // X labels: at most 8, evenly sampled.
      var tickCount = numericX ? 6 : Math.min(8, labels.length || 1);
      if (numericX) {
        for (var t = 0; t < tickCount; t++) {
          var xv2 = xMin + ((xMax - xMin) * t) / (tickCount - 1 || 1);
          f.svg.appendChild(svgText(px(xv2, 0), f.m.top + f.ih + 16, shortNumber(xv2)));
        }
      } else if (labels.length) {
        var stride = Math.max(1, Math.ceil(labels.length / tickCount));
        for (var t2 = 0; t2 < labels.length; t2 += stride) {
          f.svg.appendChild(svgText(px(0, t2), f.m.top + f.ih + 16, labels[t2]));
        }
      }

      parent.appendChild(f.svg);
      legend(parent, clean.map(function (sv) { return { label: sv.label, color: sv.color }; }));
      return f.svg;
    }

    function barChart(target, opts) {
      var parent = resolveTarget(target);
      opts = opts || {};
      var raw = Array.isArray(opts.bars) ? opts.bars : [];
      var fmt = typeof opts.yFormat === "function" ? opts.yFormat : shortNumber;
      var bars = [];
      for (var i = 0; i < raw.length; i++) {
        if (!raw[i]) continue;
        var v = Number(raw[i].value);
        if (!isFiniteNum(v)) continue;
        bars.push({
          label: raw[i].label === undefined ? String(i + 1) : String(raw[i].label),
          value: v,
          color: raw[i].color ? String(raw[i].color) : colorFor(i)
        });
      }
      if (!bars.length) return emptyBox(parent, "No bars to plot.");

      var lo = Infinity, hi = -Infinity;
      for (var j = 0; j < bars.length; j++) {
        if (bars[j].value < lo) lo = bars[j].value;
        if (bars[j].value > hi) hi = bars[j].value;
      }
      var bounds = axisBounds(lo, hi);

      if (opts.horizontal) {
        var rowH = 24;
        var f2 = drawFrame({
          height: opts.height || Math.max(140, bars.length * rowH + 44),
          left: 140, bottom: 24, label: opts.label
        });
        var zeroX = f2.m.left + ((0 - bounds.lo) / (bounds.hi - bounds.lo || 1)) * f2.iw;
        var band = f2.ih / bars.length;
        for (var b = 0; b < bars.length; b++) {
          var cy = f2.m.top + band * b + band / 2;
          var vx = f2.m.left + ((bars[b].value - bounds.lo) / (bounds.hi - bounds.lo || 1)) * f2.iw;
          f2.svg.appendChild(svgEl("rect", {
            x: Math.min(zeroX, vx), y: cy - Math.min(14, band * 0.6) / 2,
            width: Math.max(1, Math.abs(vx - zeroX)), height: Math.min(14, band * 0.6),
            fill: bars[b].color, rx: 2
          }));
          f2.svg.appendChild(svgText(f2.m.left - 8, cy + 3.5, bars[b].label, "bk-hx-axis", "end"));
          f2.svg.appendChild(svgText(vx + (bars[b].value < 0 ? -6 : 6), cy + 3.5, fmt(bars[b].value), "bk-hx-axis", bars[b].value < 0 ? "end" : "start"));
        }
        f2.svg.appendChild(svgEl("line", { class: "bk-hx-zero", x1: zeroX, x2: zeroX, y1: f2.m.top, y2: f2.m.top + f2.ih }));
        parent.appendChild(f2.svg);
        return f2.svg;
      }

      var f3 = drawFrame({ height: opts.height || 280, label: opts.label });
      drawYAxis(f3, bounds, fmt);
      var slot = f3.iw / bars.length;
      var barW = Math.max(2, Math.min(48, slot * 0.66));
      var zeroY = f3.m.top + ((bounds.hi - 0) / (bounds.hi - bounds.lo || 1)) * f3.ih;
      for (var g = 0; g < bars.length; g++) {
        var cx = f3.m.left + slot * g + slot / 2;
        var vy = f3.m.top + ((bounds.hi - bars[g].value) / (bounds.hi - bounds.lo || 1)) * f3.ih;
        f3.svg.appendChild(svgEl("rect", {
          x: cx - barW / 2, y: Math.min(zeroY, vy),
          width: barW, height: Math.max(1, Math.abs(vy - zeroY)),
          fill: bars[g].color, rx: 2
        }));
      }
      var strideB = Math.max(1, Math.ceil(bars.length / 12));
      for (var h = 0; h < bars.length; h += strideB) {
        f3.svg.appendChild(svgText(f3.m.left + slot * h + slot / 2, f3.m.top + f3.ih + 16, bars[h].label));
      }
      parent.appendChild(f3.svg);
      return f3.svg;
    }

    function table(target, opts) {
      var parent = resolveTarget(target);
      opts = opts || {};
      var cols = Array.isArray(opts.columns) ? opts.columns : [];
      var rows = Array.isArray(opts.rows) ? opts.rows : [];
      if (!cols.length || !rows.length) return emptyBox(parent, "No rows to show.");
      var tbl = el("table", { class: "bk-hx-table" });
      var thead = el("thead");
      var htr = el("tr");
      for (var i = 0; i < cols.length; i++) {
        var align = cols[i] && cols[i].align ? String(cols[i].align) : "left";
        htr.appendChild(el("th", { class: align === "right" ? "right" : align === "center" ? "center" : "" },
          cols[i] && cols[i].label !== undefined ? String(cols[i].label) : String(cols[i] && cols[i].key)));
      }
      thead.appendChild(htr);
      tbl.appendChild(thead);
      var tbody = el("tbody");
      for (var r = 0; r < rows.length; r++) {
        var tr = el("tr");
        for (var c = 0; c < cols.length; c++) {
          var col = cols[c] || {};
          var raw = rows[r] ? rows[r][col.key] : undefined;
          var txt;
          if (typeof col.format === "function") {
            txt = String(col.format(raw, rows[r]));
          } else if (raw === null || raw === undefined) {
            txt = "\\u2014";
          } else {
            txt = String(raw);
          }
          var cls = col.align === "right" ? "num" : col.align === "center" ? "center" : "";
          if (!cls && isFiniteNum(raw)) cls = "num";
          tr.appendChild(el("td", { class: cls }, txt));
        }
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      parent.appendChild(tbl);
      return tbl;
    }

    function note(target, text) {
      var parent = resolveTarget(target);
      var p = el("p", { class: "bk-hx-note" }, text === undefined || text === null ? "" : String(text));
      parent.appendChild(p);
      return p;
    }

    return {
      el: el,
      formatDollars: formatDollars,
      palette: palette,
      colorFor: colorFor,
      lineChart: lineChart,
      barChart: barChart,
      table: table,
      note: note
    };
  }

  function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    for (var k in theme) {
      if (!Object.prototype.hasOwnProperty.call(theme, k)) continue;
      if (String(k).indexOf("--") !== 0) continue;
      document.documentElement.style.setProperty(String(k), String(theme[k]));
    }
  }

  var lastPx = 0;
  function reportHeight() {
    var px = Math.max(document.documentElement.scrollHeight, rootEl ? Math.ceil(rootEl.getBoundingClientRect().height) : 0);
    px = Math.max(200, Math.min(4000, px + 8));
    if (Math.abs(px - lastPx) < 2) return;
    lastPx = px;
    send({ type: "bk:height", nonce: currentNonce, px: px });
  }

  window.addEventListener("message", function (ev) {
    // Only the embedding page may drive this frame.
    if (ev.source !== window.parent) return;
    var msg = ev.data;
    if (!msg || typeof msg !== "object" || msg.type !== "bk:render") return;
    currentNonce = msg.nonce === undefined ? null : msg.nonce;
    applyTheme(msg.meta && msg.meta.theme);
    clearNode(rootEl);
    var bk = makeBk(msg.meta || {});
    try {
      var body = String(msg.render === undefined || msg.render === null ? "" : msg.render);
      var fn = new Function("root", "data", "bk", '"use strict";' + NL + body);
      var payloadData = msg.data && typeof msg.data === "object" ? msg.data : {};
      fn(rootEl, payloadData, bk);
      // A body that DECLARES a function instead of BEING one ("function
      // render(root,data,bk){...}") runs cleanly and draws nothing, so the page
      // would report success and sit blank. Detect that exact shape — nothing
      // drawn AND the body opens with a function/arrow declaration — and say so
      // precisely, which also tells the model what to change on its next try.
      if (rootEl.childNodes.length === 0 && looksLikeDeclaration(body)) {
        throw new Error(
          "render drew nothing: your string DECLARES a function instead of being the function " +
          "body. Remove the 'function render(root, data, bk) {' wrapper and its closing brace, " +
          "leaving just the statements."
        );
      }
    } catch (err) {
      clearNode(rootEl);
      reportedErrorNonce = currentNonce;
      send({
        type: "bk:error",
        nonce: currentNonce,
        message: String((err && err.message) ? err.message : err)
      });
      reportHeight();
      return;
    }
    send({ type: "bk:done", nonce: currentNonce });
    reportHeight();
  });

  // Anything the render code throws AFTER its synchronous body returned — a
  // setTimeout callback, an event handler, a rejected promise — lands here
  // rather than in the try/catch around the render call. Without this it would
  // vanish: the parent already saw bk:done and would show a page that silently
  // stopped updating. Reported once per payload so a throwing interval cannot
  // flood the parent.
  function reportAsyncError(message) {
    if (currentNonce === null) return;
    if (reportedErrorNonce === currentNonce) return;
    reportedErrorNonce = currentNonce;
    send({ type: "bk:error", nonce: currentNonce, message: String(message) });
  }

  window.addEventListener("error", function (ev) {
    reportAsyncError(ev && ev.message ? ev.message : "Uncaught error in page code");
  });

  window.addEventListener("unhandledrejection", function (ev) {
    var reason = ev ? ev.reason : null;
    var text = reason && reason.message ? reason.message : reason;
    reportAsyncError(
      text === undefined || text === null ? "Unhandled promise rejection in page code" : text
    );
  });

  if (typeof ResizeObserver === "function") {
    var ro = new ResizeObserver(function () { reportHeight(); });
    ro.observe(document.documentElement);
    if (rootEl) ro.observe(rootEl);
  } else {
    setInterval(reportHeight, 500);
  }

  send({ type: "bk:ready" });
})();
</` + `script>
</body>
</html>`;
