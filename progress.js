// progress.js — the standalone Progress page. Reads the saved Library (browserAPI.storage.local
// .library) and draws two engine-free reports: a personal Progress trend and an Opening report.
// All the math lives in lib/progress.js so it can be unit-tested in Node; this file is only DOM.

import { browserAPI } from "./browser-compat.js";
import { openAnalysisTab } from "./analyze-flow.js";
import {
  progressPoints, summarizeProgress, openingReport, underperformingOpenings,
  movingAverage, linePath, phaseReport, personalBests, ownGames,
  sliceRange, filterGames, colourSplit, typeSplit, decisionProfile, accuracyHistogram,
  scoreTrend, momentum, stability, gradeSeries, sortRows,
  dailyActivity, metricEvidence, opponentReport, focusAreas, gameRows, opponentKey, PHASE_LABELS,
} from "./lib/progress.js";
import {
  createBackup, parseBackup, mergeLibraries, replaceLibrary, backupSummary,
  restorableSettingsKeys, BACKUP_KEYS,
} from "./lib/library-backup.js";

/* ---------------- tiny DOM helpers ---------------- */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    // Custom properties (--i stagger, --c category colour) are not style properties: Object.assign
    // drops them silently, so they must go through setProperty.
    else if (k === "style" && v && typeof v === "object") {
      for (const [prop, value] of Object.entries(v)) {
        if (prop.startsWith("--")) n.style.setProperty(prop, value);
        else n.style[prop] = value;
      }
    }
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    // Handlers must be listeners: setAttribute would stringify the function into an inline attribute
    // that never calls it (the same reason el() wraps on* keys).
    if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

/* ---------------- formatting ---------------- */
const fmtPct = (v) => (v == null ? "–" : `${Math.round(v)}%`);
const fmtAcc = (v) => (v == null ? "–" : v.toFixed(1));
const fmtRating = (v) => (v == null ? "–" : String(Math.round(v)));
const fmtDate = (ms) => {
  if (ms == null) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

/* ---------------- motion: only when the user allows it ---------------- */
const reducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};
// Count a headline number up to its value. The text is set to the final value first, so a user with
// reduced motion (or a failed rAF) always sees the truth rather than a stuck zero.
// The count-up is a first-paint effect only: every filter change re-renders the cards, and replaying the
// animation would flash all nine numbers back through 0 on each click.
let _animatedOnce = false;
function countUp(node, { value, format = String, ms = 700 }) {
  // The node already holds the true value; the animation only decorates it. A hidden tab pauses rAF,
  // which used to strand every card at 0, so a hidden page skips straight to the number.
  if (_animatedOnce || !Number.isFinite(value) || reducedMotion() || document.hidden) return;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - (1 - p) ** 3;
    node.textContent = format(value * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  node.textContent = format(0);
  requestAnimationFrame(step);
  // Whatever happens to the frames (a tab hidden mid-animation stops them for good), the card must end
  // on the real number - never on a half-counted or zeroed one.
  setTimeout(() => { node.textContent = format(value); }, ms + 80);
}

/* ---------------- tooltip ---------------- */
// One shared tooltip for charts, bars and histogram columns.
function tip() {
  let node = document.getElementById("tip");
  if (!node) { node = el("div", { id: "tip", role: "tooltip" }); document.body.append(node); }
  return node;
}
let tipShownAt = 0;
function showTip(html, x, y) {
  const node = tip();
  node.replaceChildren(...html);
  node.classList.add("show");
  tipShownAt = Date.now();
  const box = node.getBoundingClientRect();
  node.style.left = `${Math.min(Math.max(8, x - box.width / 2), window.innerWidth - box.width - 8)}px`;
  node.style.top = `${Math.max(8, y - box.height - 12)}px`;
}
function hideTip() { const node = document.getElementById("tip"); if (node) node.classList.remove("show"); }
// A scroll under the pointer invalidates the readout - but not the scroll that brought the point into
// view, which would otherwise hide it again immediately.
window.addEventListener("scroll", () => { if (Date.now() - tipShownAt > 250) hideTip(); }, true);

/* ---------------- the report window: range + filters ---------------- */
const RANGES = [["All", 0], ["Last 100", 100], ["Last 50", 50], ["Last 20", 20], ["Last 10", 10]];
const RESULTS = [["Any result", ""], ["Wins", "win"], ["Draws", "draw"], ["Losses", "loss"]];
let rangeLast = 0, filterColour = "", filterType = "", filterResult = "", openSort = { key: "games", dir: "desc" };
// A single day picked from the daily tracker (scopes every report), and the KPI card whose evidence
// panel is open. Both live outside the render so a click can rebuild the page without losing them.
let daySel = "", inspectKey = "";
// A rival or an opening picked from its own panel scopes the page the same way a day does; the master
// game table has its own sort, and can be expanded past its first page.
let filterOpponent = "", filterOpening = "", filterOpeningName = "", showAllGames = false;
let gameSort = { key: "at", dir: "desc" };

function chip(label, on, onclick) {
  return el("button", { class: `chip${on ? " on" : ""}`, type: "button", "aria-pressed": String(on), onclick }, label);
}
function chipRow(label, options, value, set) {
  return el("div", { class: "chip-row" },
    el("span", { class: "chip-label" }, label),
    ...options.map(([text, v]) => chip(text, v === value, () => { set(v); render(); })));
}

/** The tracked games narrowed to the chosen range and filters - the window every panel reports on. */
function windowed(records) {
  return filterGames(sliceRange(records, rangeLast),
    { colour: filterColour, type: filterType, result: filterResult, day: daySel,
      opponent: filterOpponent, opening: filterOpening });
}
function controlsRow(viewCount, tracked) {
  // Only the time classes the tracked account actually plays: another player's games must not put a
  // chip on the toolbar (it would filter this window down to nothing).
  const types = typeSplit(tracked).map((t) => [t.label, t.key]);
  const typeOptions = [["Any time control", ""], ...types];
  const filtering = !!(rangeLast || filterColour || filterType || filterResult || daySel
    || filterOpponent || filterOpening);
  return el("div", { class: "controls" },
    chipRow("Games", RANGES, rangeLast, (v) => { rangeLast = v; }),
    chipRow("Colour", [["Both", ""], ["White", "w"], ["Black", "b"]], filterColour, (v) => { filterColour = v; }),
    chipRow("Result", RESULTS, filterResult, (v) => { filterResult = v; }),
    typeOptions.length > 1 ? chipRow("Format", typeOptions, filterType, (v) => { filterType = v; }) : null,
    // A day picked in the tracker scopes the whole page; show it as a filter so it can be cleared here
    // instead of only by clicking the tiny cell again.
    daySel ? el("div", { class: "chip-row" },
      el("span", { class: "chip-label" }, "Day"),
      el("button", {
        class: "chip on", type: "button", title: "Clear this day",
        onclick: () => { daySel = ""; render(); },
      }, dayLabel(daySel))) : null,
    // A rival or opening picked from its panel is also a filter: show it here so it can be cleared
    // without hunting for the same row again.
    filterOpponent ? el("div", { class: "chip-row" },
      el("span", { class: "chip-label" }, "Opponent"),
      el("button", {
        class: "chip on", type: "button", title: "Clear this opponent",
        onclick: () => { filterOpponent = ""; render(); },
      }, opponentLabel(filterOpponent))) : null,
    filterOpening ? el("div", { class: "chip-row" },
      el("span", { class: "chip-label" }, "Opening"),
      el("button", {
        class: "chip on", type: "button", title: "Clear this opening",
        onclick: () => { filterOpening = ""; filterOpeningName = ""; render(); },
      }, filterOpeningName || "selected")) : null,
    el("div", { class: "chip-row" },
      el("span", { class: "chip-label" }, `${viewCount} ${viewCount === 1 ? "game" : "games"}`),
      filtering ? el("button", {
        class: "chip reset", type: "button",
        onclick: () => {
          rangeLast = 0; filterColour = ""; filterType = ""; filterResult = ""; daySel = "";
          filterOpponent = ""; filterOpening = ""; filterOpeningName = ""; render();
        },
      }, "Reset filters") : null));
}

/* ---------------- chart ---------------- */
const CHART_W = 640;
const CHART_H = 170;

function accuracySeries(points) { return points.map((p) => p.accuracy); }
function ratingSeries(points) { return points.map((p) => p.rating); }

// One line chart with a hover readout and click-through to the game. `domain` fixes the vertical
// range (accuracy is always 0-100 so the line's height stays comparable between visits); otherwise
// the range fits the data. `points` (optional) carries the per-game identity for the tooltip.
function lineChart(values, { domain = null, label, points = null, format = (v) => v.toFixed(1), hint = null }) {
  const series = values.filter((v) => v != null);
  if (series.length < 2) return el("div", { class: "chart-empty" }, "Analyze a few more games to see this trend.");

  const [lo, hi] = domain || [Math.min(...series), Math.max(...series)];
  const box = svg("svg", { class: "chart", viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: "none", role: "img", "aria-label": label });
  for (let i = 0; i <= 4; i++) {
    const y = 6 + ((CHART_H - 12) * i) / 4;
    box.append(svg("line", { class: "grid-line", x1: 0, y1: y.toFixed(1), x2: CHART_W, y2: y.toFixed(1) }));
  }
  const opts = { width: CHART_W, height: CHART_H - 12, pad: 4, min: lo, max: hi };
  const raw = linePath(values, opts);
  const smooth = linePath(movingAverage(values, 5), opts);
  if (raw) box.append(svg("path", { class: "chart-raw", d: raw, fill: "none", stroke: "var(--line)", "stroke-width": "1.5", "vector-effect": "non-scaling-stroke", pathLength: 1 }));
  box.append(svg("path", { class: "chart-line", d: smooth, fill: "none", stroke: "var(--accent)", "stroke-width": "2.5", "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke", pathLength: 1 }));

  if (points && points.length === values.length) {
    // Invisible hit area per game: hover for the readout, click to open that game. The bands meet at
    // the midpoint between neighbouring points, so they never overlap (an overlapping pair makes the
    // later rect swallow the earlier one's pointer events).
    const n = values.length;
    const xAt = (i) => (n <= 1 ? CHART_W / 2 : (i / (n - 1)) * CHART_W);
    values.forEach((v, i) => {
      if (v == null) return;
      const p = points[i];
      const y = opts.pad + (opts.height - 2 * opts.pad) * (1 - (Math.max(lo, Math.min(hi, v)) - lo) / ((hi - lo) || 1));
      const x = xAt(i);
      const left = i === 0 ? 0 : (xAt(i - 1) + x) / 2;
      const right = i === n - 1 ? CHART_W : (x + xAt(i + 1)) / 2;
      box.append(svg("rect", {
        class: "chart-hit", x: left.toFixed(1), y: 0, width: Math.max(1, right - left).toFixed(1), height: CHART_H,
        onmousemove: (e) => showTip([
          el("b", {}, `${format(v)}${hint ? ` ${hint}` : ""}`),
          el("span", {}, p?.label || ""),
          p?.opponent ? el("span", {}, `vs ${p.opponent}`) : null,
          p?.result ? el("span", { class: `tip-res ${p.result}` }, p.result) : null,
        ].filter(Boolean), e.clientX, e.clientY),
        onmouseleave: hideTip,
        onclick: p?.id ? () => openGame(p.id) : null,
      }));
      box.append(svg("circle", { class: "chart-dot", cx: x.toFixed(1), cy: Math.max(2, Math.min(CHART_H - 2, y)).toFixed(1), r: 2.4 }));
    });
  }
  return el("div", {},
    el("div", { class: "sub", style: { display: "flex", justifyContent: "space-between" } },
      el("span", {}, `low ${lo.toFixed(0)}${hint || ""}`), el("span", {}, `high ${hi.toFixed(0)}${hint || ""}`)),
    box);
}

/* ---------------- progress tab ---------------- */
let _sparkId = 0;
// The bottom half of a KPI card: shape without axes - a sparkline says "which way is this going".
function sparkline(values, { stroke = "var(--accent)" } = {}) {
  const series = (values || []).filter((v) => v != null);
  if (series.length < 2) return null;
  const W = 120, H = 30, pad = 3;
  const lo = Math.min(...series), hi = Math.max(...series);
  const x = (i) => (i / (series.length - 1)) * W;
  const y = (v) => pad + (H - 2 * pad) * (1 - ((v - lo) / ((hi - lo) || 1)));
  const line = "M" + series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" L");
  const id = `spark${++_sparkId}`;
  const box = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  box.append(svg("defs", {}, svg("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 },
    svg("stop", { offset: "0%", "stop-color": stroke, "stop-opacity": ".30" }),
    svg("stop", { offset: "100%", "stop-color": stroke, "stop-opacity": "0" }))));
  box.append(svg("path", { d: `${line} L${W},${H} L0,${H} Z`, fill: `url(#${id})` }));
  box.append(svg("path", { class: "spark-line", d: line, fill: "none", stroke, "stroke-width": "1.6",
    "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke", pathLength: 1 }));
  return box;
}

// A signed change with the colouring that suits the metric (lower can be the good direction).
function deltaChip(delta, { unit = "", goodWhen = "up", digits = 1 } = {}) {
  if (delta == null || !Number.isFinite(delta)) return null;
  const step = 10 ** digits;
  const rounded = Math.round(delta * step) / step;
  const flat = Math.abs(rounded) < 1 / step;
  const good = goodWhen === "down" ? rounded < 0 : rounded > 0;
  const cls = flat ? "" : good ? "up" : "down";
  const arrow = flat ? "→" : rounded > 0 ? "▲" : "▼";
  return el("span", { class: `delta-chip ${cls}`.trim() }, `${arrow} ${rounded > 0 ? "+" : ""}${rounded}${unit}`);
}

// Open or close the evidence panel behind a KPI card.
function toggleInspect(key) {
  inspectKey = inspectKey === key ? "" : key;
  render();
}

// label · hero number · delta chip · sparkline (the four parts a KPI card needs). A card that names a
// metric is also a button: it opens the panel showing the games and the rule behind its number.
function statCard(k, text, hint, cls = "", count = null, { spark = null, delta = null, info = "", metric = "" } = {}) {
  const v = el("div", { class: "v" }, text);
  if (count && Number.isFinite(count.value)) countUp(v, count);
  const chart = spark ? sparkline(spark) : null;
  const card = el("div", { class: `card ${cls}`.trim() },
    el("div", { class: "k" }, el("span", {}, k),
      info ? el("span", {
        class: "hint-dot", title: info, onclick: (e) => e.stopPropagation(),
        onmouseenter: (e) => showTip([el("b", {}, k), el("span", {}, info)], e.clientX, e.clientY), onmouseleave: hideTip,
      }, "i") : null),
    el("div", { class: "row" }, v, delta),
    hint ? el("div", { class: "h" }, hint) : null,
    chart ? el("div", { class: "spark" }, chart) : null);
  if (metric) {
    const open = inspectKey === metric;
    card.classList.add("clickable");
    card.classList.toggle("open", open);
    card.setAttribute("role", "button");
    card.setAttribute("aria-expanded", String(open));
    card.tabIndex = 0;
    card.title = `How ${k} was counted`;
    card.addEventListener("click", () => toggleInspect(metric));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleInspect(metric); }
    });
  }
  return card;
}
// Cards rise in one after another; the delay comes from --i so the order is explicit in the DOM.
const cardGrid = (...cards) => el("div", { class: "cards" },
  ...cards.map((card, i) => { card.style.setProperty("--i", String(i)); return card; }));

// A split panel: one row per bucket (colour, time class, opponent) with an animated score bar. With
// `onclick` every row becomes a scope action, so the row that looks wrong is one click from its games.
function splitPanel(title, sub, rows, { onclick = null } = {}) {
  const body = rows.map((row, i) => el("div", {
    class: `split${onclick ? " clickable" : ""}`,
    style: { "--i": String(i) },
    onclick: onclick ? () => onclick(row) : null,
    // An action row is reachable without a mouse, like the clickable KPI cards.
    role: onclick ? "button" : null,
    tabIndex: onclick ? 0 : null,
    onkeydown: onclick ? (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onclick(row); }
    } : null,
    title: onclick ? "Show only these games" : null,
  },
    el("div", { class: "split-head" },
      el("span", { class: "split-name" }, row.label),
      el("span", { class: "split-games" }, `${row.games} ${row.games === 1 ? "game" : "games"}`)),
    el("div", {
      class: "bar",
      onmousemove: (e) => showTip([
        el("b", {}, `${fmtPct(row.score)} score`),
        el("span", {}, `${row.wins}W · ${row.draws}D · ${row.losses}L`),
        el("span", {}, `${fmtAcc(row.accuracy)} avg accuracy`),
      ], e.clientX, e.clientY),
      onmouseleave: hideTip,
    }, el("i", { style: { width: `${row.score == null ? 0 : Math.max(0, Math.min(100, row.score))}%` } })),
    el("div", { class: "split-foot" },
      el("span", {}, fmtPct(row.score)), el("span", {}, `${fmtAcc(row.accuracy)} acc`))));
  return el("div", { class: "panel" }, el("h3", {}, title), el("p", { class: "sub" }, sub), ...body);
}

// Recent form against the stretch before it - the honest answer to "am I improving?".
function momentumPanel(records) {
  const m = momentum(records, 5);
  const rowFor = (label, recent, previous, delta, format) => {
    const max = Math.max(recent ?? 0, previous ?? 0, 1);
    const cls = delta == null || Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
    const arrow = cls === "flat" ? "→" : cls === "up" ? "▲" : "▼";
    return el("div", { class: "mom-row" },
      el("span", { class: "mom-name" }, label),
      el("span", { class: "mom-val" }, format(recent)),
      delta == null ? null : el("span", { class: `delta ${cls}` }, `${arrow} ${delta > 0 ? "+" : ""}${Math.round(delta * 10) / 10}`),
      el("div", { class: "mom-bars", title: `previous ${format(previous)} → recent ${format(recent)}` },
        el("i", { class: "prev", style: { height: `${Math.round(((previous ?? 0) / max) * 100)}%` } }),
        el("i", { class: "rec", style: { height: `${Math.round(((recent ?? 0) / max) * 100)}%` } })));
  };
  const enough = m.previousGames > 0;
  return el("div", { class: "panel" },
    el("h3", {}, "Recent form"),
    el("p", { class: "sub" }, enough
      ? `The last ${m.recentGames} games against the ${m.previousGames} before them.`
      : "Play 10 games in this window to compare a recent run with the one before it."),
    rowFor("Accuracy", m.accuracy.recent, m.accuracy.previous, m.delta.accuracy, fmtAcc),
    rowFor("Score", m.score.recent, m.score.previous, m.delta.score, fmtPct),
    rowFor("Rating", m.rating.recent, m.rating.previous, m.delta.rating, fmtRating),
    enough ? el("div", { class: "mom-legend" }, el("span", {}, "◼ previous"), el("span", {}, "◼ recent")) : null);
}

// Results as a donut: composition at a glance, counts and shares spelled out beside it.
function donutPanel(records) {
  const s = summarizeProgress(records);
  const total = s.wins + s.draws + s.losses;
  if (!total) return null;
  const R = 62, C = 2 * Math.PI * R;
  const parts = [["Wins", s.wins, "var(--accent)"], ["Draws", s.draws, "var(--draw)"], ["Losses", s.losses, "var(--loss)"]];
  const box = svg("svg", { viewBox: "0 0 148 148", width: 148, height: 148, role: "img", "aria-label": "Results split" });
  box.append(svg("circle", { class: "track", cx: 74, cy: 74, r: R }));
  let offset = 0, slice = 0;
  for (const [label, n, colour] of parts) {
    if (!n) continue;
    const len = (n / total) * C;
    box.append(svg("circle", {
      class: "seg", cx: 74, cy: 74, r: R, stroke: colour,
      "stroke-dasharray": `${len.toFixed(2)} ${(C - len).toFixed(2)}`,
      "stroke-dashoffset": (-offset).toFixed(2),
      style: { "--from": (-offset - len).toFixed(2), "--i": String(slice++) },
    }));
    offset += len;
  }
  const legend = el("div", { class: "legend" }, ...parts.map(([label, n, colour]) => el("div", {
    class: "legend-row" },
    el("span", { class: "swatch", style: { background: colour } }),
    el("span", { class: "lbl" }, label),
    el("span", { class: "n" }, String(n)),
    el("span", { class: "pct" }, `${total ? Math.round((n / total) * 100) : 0}%`))));
  return el("div", { class: "donut-wrap" },
    el("div", { class: "donut" }, box,
      el("div", { class: "centre" }, el("b", {}, String(total)), el("span", {}, "games"))),
    legend);
}

// Move quality as shares (chess.com Insights style): the proportion first, the raw count second.
function qualityPanel(profile) {
  if (!profile || !profile.moves) return el("p", { class: "sub" }, "New analyses record this automatically; games saved before it are skipped.");
  const rows = profile.rows.filter((r) => r.me > 0);
  if (!rows.length) return el("p", { class: "sub" }, "No classified moves in this window.");
  const maxShare = Math.max(...rows.map((r) => r.share || 0), 1);
  const dist = el("div", { class: "dist" }, ...rows.map((r, i) => el("span", {
    class: "dist-seg",
    style: { width: `${r.share}%`, background: `var(--dq-${r.key})`, animationDelay: `${i * 40}ms` },
    onmousemove: (e) => showTip([el("b", {}, r.label), el("span", {}, `${r.share}% of your moves · ${r.me} total`)], e.clientX, e.clientY),
    onmouseleave: hideTip,
  })));
  const list = el("div", { class: "quality" }, ...rows.map((r, i) => el("div", {
    class: "q-row", style: { "--i": String(i), "--c": `var(--dq-${r.key})` } },
    el("span", { class: "q-name" }, r.label),
    el("div", { class: "q-bar" }, el("i", { style: { width: `${Math.round(((r.share || 0) / maxShare) * 100)}%` } })),
    el("span", { class: "q-pct" }, `${r.share}%`),
    el("span", { class: "q-n" }, String(r.me)))));
  return el("div", {}, dist, list);
}

// A panel whose own <h3> repeats the frame's title is noise - the section already says it, so the page
// showed "Accuracy distribution" twice. Drop the repeated heading and keep its sub-line.
function dropRepeatedHeading(node, title) {
  const wanted = String(title || "").trim().toLowerCase();
  if (!wanted || !node.querySelectorAll) return;
  // querySelectorAll only looks at descendants, and most sections pass the panel itself.
  const panels = [...(node.classList?.contains("panel") ? [node] : []), ...node.querySelectorAll(".panel")];
  for (const panel of panels) {
    const heading = [...panel.children].find((kid) => kid.tagName === "H3");
    if (heading && heading.textContent.trim().toLowerCase() === wanted) heading.remove();
  }
}

// One framed report section: eyebrow, title, hairline rule, then the panels inside it.
function sectionFrame({ id, eyebrow, title, node }) {
  const kids = (Array.isArray(node) ? node : [node]).filter(Boolean);
  for (const kid of kids) dropRepeatedHeading(kid, title);
  return el("section", { class: "sec", id },
    el("div", { class: "sec-head" }, el("span", { class: "eyebrow" }, eyebrow), el("h2", {}, title), el("span", { class: "rule" })),
    ...kids);
}

// The right-hand rail: jump links, with the section you are reading highlighted as you scroll.
let jumpObserver = null;
function renderJump(sections) {
  const rail = document.getElementById("jump");
  if (!rail) return;
  if (!sections.length) { rail.hidden = true; rail.replaceChildren(); return; }   // Data tab has no sections
  rail.hidden = false;
  rail.replaceChildren(el("div", { class: "jump-label" }, "On this page"),
    ...sections.map((s) => el("a", { href: `#${s.id}`, "data-for": s.id }, s.title)));
  if (jumpObserver) { jumpObserver.disconnect(); jumpObserver = null; }
  try {
    jumpObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const link = rail.querySelector(`a[data-for="${entry.target.id}"]`);
        for (const other of rail.querySelectorAll("a")) other.classList.toggle("on", other === link);
      }
      // The band starts below the sticky chrome, not 140px down: with the measured offset the rail
      // highlights the section you are actually reading.
    }, { rootMargin: `-${Math.round(stickyH || 140)}px 0px -55% 0px` });
    for (const s of sections) { const node = document.getElementById(s.id); if (node) jumpObserver.observe(node); }
  } catch { /* no IntersectionObserver: the links still work */ }
}

// Shown while the library is being read, so the page never flashes empty.
function skeleton() {
  return el("div", { class: "skeleton" },
    el("div", { class: "cards" }, ...Array.from({ length: 6 }, () => el("div", { class: "sk-card" }))),
    el("div", { class: "sk-row" }), el("div", { class: "sk-row" }));
}

// How many games land in each accuracy band.
function histogramPanel(records) {
  const { bins, total } = accuracyHistogram(records, { size: 10 });
  if (!total) {
    return el("div", { class: "panel" },
      el("h3", {}, "Accuracy distribution"),
      el("p", { class: "sub" }, "Nothing to plot in this window."));
  }
  const max = Math.max(...bins.map((b) => b.count), 1);
  const columns = bins.map((bin, i) => {
    const fill = el("i", { style: { height: `${Math.round((bin.count / max) * 100)}%` } });
    const bar = el("div", { class: "hist-bar" }, fill);
    const count = el("span", { class: "hist-n" }, bin.count ? String(bin.count) : "");
    const axis = el("span", { class: "hist-ax" }, String(bin.from));
    const label = [el("b", {}, `${bin.from}-${bin.to}%`), el("span", {}, `${bin.count} ${bin.count === 1 ? "game" : "games"}`)];
    return el("div", {
      class: "hist-col",
      style: { "--i": String(i) },
      onmousemove: (e) => showTip(label, e.clientX, e.clientY),
      onmouseleave: hideTip,
    }, bar, count, axis);
  });
  return el("div", { class: "panel" },
    el("h3", {}, "Accuracy distribution"),
    el("p", { class: "sub" }, `${total} ${total === 1 ? "game" : "games"} by accuracy band. A cluster on the left is where your losses live.`),
    el("div", { class: "hist" }, ...columns));
}

// Your decisions against your opponents', from the tallies saved with each game.
function decisionPanel(records) {
  const profile = decisionProfile(records);
  if (!profile) {
    return el("div", { class: "panel" }, el("h3", {}, "Decision quality"),
      el("p", { class: "sub" }, "New analyses record this automatically; games saved before it are skipped."));
  }
  const max = Math.max(1, ...profile.rows.map((r) => Math.max(r.me, r.them)));
  const rows = profile.rows.map((r, i) => el("div", {
    class: `dec kind-${r.kind}`,
    style: { "--i": String(i), "--c": `var(--dq-${r.key})` },
  },
    el("span", { class: "dec-name" }, r.label),
    el("div", { class: "dec-bar", title: `you ${r.me} · opponent ${r.them}` },
      el("i", { class: "me", style: { width: `${Math.round((r.me / max) * 100)}%` } })),
    el("span", { class: "dec-n" }, String(r.me)),
    el("div", { class: "dec-bar opp" },
      el("i", { class: "them", style: { width: `${Math.round((r.them / max) * 100)}%` } })),
    el("span", { class: "dec-n opp" }, String(r.them))));
  return el("div", { class: "panel" },
    el("h3", {}, "Decision quality"),
    el("p", { class: "sub" }, `${profile.errorRate == null ? "—" : `${profile.errorRate}% of your moves were an inaccuracy or worse`} · ${profile.moves} classified moves across ${profile.games} ${profile.games === 1 ? "game" : "games"} · left bar = you, right = opponent.`),
    el("div", { class: "dec-head" }, el("span", {}, "Move"), el("span", { class: "dec-n" }, "You"), el("span", { class: "dec-n opp" }, "Opp")),
    ...rows);
}

/* ---------------- drill-down: the evidence behind a card ---------------- */
const dayLabel = (key) => {
  const [y, m, d] = String(key || "").split("-").map(Number);
  const at = new Date(y, m - 1, d);
  return Number.isNaN(at.getTime()) ? String(key || "")
    : at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

// The panel behind a KPI card: the rule that produces the number, the statistics beside it, and the
// games that fed it. Every row reopens its review; a row with a saved worst decision also jumps to
// that move.
function inspectorPanel(records) {
  const ev = metricEvidence(records, inspectKey);
  if (!ev) return null;
  const stats = [];
  const chipText = (text) => el("span", { class: "stat-chip" }, text);
  // A pooled rate (error rate) has no meaningful mean of per-game rates, so it shows only the pooled
  // fraction that produces the card's number. "Games" has no per-game size either (its mean is 1).
  if (ev.pooled) stats.push(chipText(`${ev.pooled.num} errors in ${ev.pooled.den} moves`));
  else if (ev.mean != null && ev.key !== "games") stats.push(chipText(`mean ${ev.mean}`));
  if (ev.spread) stats.push(chipText(`sd ±${ev.sd ?? "–"}`));
  if (ev.total != null) stats.push(chipText(`total ${ev.total}`));
  if (ev.min != null && ev.order !== "none" && ev.max !== ev.min) stats.push(chipText(`range ${ev.minText}–${ev.maxText}`));
  stats.push(chipText(`${ev.games} ${ev.games === 1 ? "game" : "games"}`));
  const order = ev.order === "asc" ? " (worst first)" : ev.order === "desc" ? " (highest first)" : " (newest first)";
  const sub = ev.games > ev.shown
    ? `${ev.rule} Showing the ${ev.shown} most relevant of ${ev.games}${order}.`
    : ev.rule;
  // For score / win rate / games the value column IS the result, so a Result column would duplicate it.
  const showResult = ev.order !== "none";
  const rows = ev.rows.map((row) => el("tr",
    { class: row.id ? "" : "none", onclick: row.id ? () => openGame(row.id) : null, title: row.id ? "Open this game" : "" },
    el("td", {}, row.label || "—"),
    showResult ? el("td", {}, row.result ? el("span", { class: `pill ${row.result === "loss" ? "low" : ""}` }, row.result) : "—") : null,
    el("td", { class: "big" }, row.text),
    el("td", { class: "act" }, row.id ? el("button", {
      class: "linkbtn", type: "button",
      title: row.ply ? "Open the review at this game's worst move" : "Open this game",
      onclick: (e) => { e.stopPropagation(); openGame(row.id, row.ply); },
    }, row.ply ? `move ${Math.ceil(row.ply / 2)}` : "open") : null)));
  return el("div", { class: "panel inspect" },
    el("div", { class: "inspect-head" },
      el("h3", {}, `${ev.label} — how this was counted`),
      el("button", { class: "btn ghost sm", type: "button", onclick: () => { inspectKey = ""; render(); } }, "Close")),
    el("p", { class: "sub" }, sub),
    el("div", { class: "inspect-stats" }, ...stats),
    ev.rows.length
      ? el("table", { class: "contrib" },
        el("thead", {}, el("tr", {},
          el("th", {}, "Game"),
          showResult ? el("th", {}, "Result") : null,
          el("th", {}, ev.label),
          el("th", {}, ""))),
        el("tbody", {}, ...rows))
      : el("p", { class: "sub" }, "No game in this window carries this data yet."));
}

/* ---------------- daily tracker ---------------- */
// Twelve weeks of days, sized by how many games landed on each. A cell is a button: it scopes every
// report on the page to that day, which is the fastest way from "that was a bad Tuesday" to the games.
function dailyPanel(records) {
  const daily = dailyActivity(records, { days: 84 });
  if (!daily.games) {
    return el("div", { class: "panel" },
      el("h3", {}, "Daily tracker"),
      el("p", { class: "sub" }, daily.undated
        ? `${daily.undated} saved ${daily.undated === 1 ? "game carries" : "games carry"} no date in its PGN, so ${daily.undated === 1 ? "it" : "they"} cannot be placed on a day.`
        : "No games in the last 84 days."));
  }
  const level = (n) => (!n ? 0
    : n >= Math.max(4, Math.ceil(daily.max * 0.75)) ? 4
      : n >= Math.max(3, Math.ceil(daily.max / 2)) ? 3 : n >= 2 ? 2 : 1);
  // Pad the first column so every column is a real week (Monday first, matching the cell order).
  const lead = (new Date(daily.first).getDay() + 6) % 7;
  const cells = daily.cells.map((cell) => el("button", {
    class: `day${cell.key === daySel ? " on" : ""}`,
    type: "button",
    "data-level": String(level(cell.games)),
    "aria-label": `${dayLabel(cell.key)}: ${cell.games} games`,
    "aria-pressed": String(cell.key === daySel),
    onclick: () => { daySel = daySel === cell.key ? "" : cell.key; rangeLast = 0; inspectKey = ""; render(); },
    onmousemove: (e) => showTip([
      el("b", {}, dayLabel(cell.key)),
      el("span", {}, cell.games
        ? `${cell.games} ${cell.games === 1 ? "game" : "games"} · ${cell.wins}W ${cell.draws}D ${cell.losses}L`
        : "No games"),
      cell.accuracy != null ? el("span", {}, `${cell.accuracy} avg accuracy`) : null,
      cell.games ? el("span", {}, "Click to scope every report to this day") : null,
    ].filter(Boolean), e.clientX, e.clientY),
    onmouseleave: hideTip,
  }));
  return el("div", { class: "panel" },
    el("h3", {}, "Daily tracker"),
    el("p", { class: "sub" },
      `${daily.games} ${daily.games === 1 ? "game" : "games"} on ${daily.activeDays} ${daily.activeDays === 1 ? "day" : "days"} in the last ${daily.days}`
      + ` · current streak ${daily.streak} ${daily.streak === 1 ? "day" : "days"}`
      + ` · best run ${daily.best} ${daily.best === 1 ? "day" : "days"}`
      + (daily.undated ? ` · ${daily.undated} undated` : "")),
    el("div", { class: "days" },
      ...Array.from({ length: lead }, () => el("span", { class: "day empty", "aria-hidden": "true" })),
      ...cells),
    el("div", { class: "day-foot" },
      el("span", { class: "day-legend" }, "Less",
        ...["0", "1", "2", "3", "4"].map((n) => el("span", { class: "day", "data-level": n, "aria-hidden": "true" })),
        "More"),
      el("span", {}, daySel
        ? `Scoped to ${dayLabel(daySel)} — click the day again to clear.`
        : "Click a day to scope every report to it.")));
}

// The Progress tab, assembled as framed sections (the jump rail is built from them).
function renderProgress(records, tracked) {
  const points = progressPoints(records);
  const s = summarizeProgress(records);
  const profile = decisionProfile(records);
  const sd = stability(records);
  const grades = gradeSeries(records);
  const gradeValues = grades.map((g) => g.value).filter((v) => v != null);
  const score = scoreTrend(records, 10);
  const m = momentum(records, 5);
  const range = s.first && s.last ? `${fmtDate(s.first)} – ${fmtDate(s.last)}` : "";
  const gradeFormat = (v) => (v == null ? "—" : v.toFixed(1));
  const errorRate = profile?.errorRate ?? null;
  // The rating card reports ONE scale for the whole window (never an average of two different numbers),
  // so it says which scale this is and how many games the window could not supply on it.
  const ratingSub = (s.ratingScale === "estimate" ? "estimated by the review"
    : s.ratingScale === "elo" ? "recorded Elo" : "no ratings yet")
    + (s.missingRating ? ` · ${s.missingRating} not on this scale` : "");
  const ratingInfo = s.ratingScale === "elo"
    ? "The Elo recorded in these games. Older games have no rating estimate from the review, and the two scales are never averaged together, so this window stays on one of them."
    : "The rating the review estimates you played at, averaged over this window. Games saved before the estimate existed are left out rather than mixed in.";
  // A delta is only meaningful against a full comparison window: with 6-9 games the "previous" side is
  // 1-4 games and a chip would overstate the change, so it is withheld.
  const comparable = m.previousGames === m.window;
  const delta = (value, opts) => (comparable ? deltaChip(value, opts) : null);

  // `metric` makes a card a button: it opens the panel listing the games (and rule) behind the number.
  const cards = cardGrid(
    statCard("Games", String(s.games), range, "", { value: s.games, format: (n) => String(Math.round(n)) },
      { info: "Games in the window that this page is tracking.", metric: "games" }),
    statCard("Score", fmtPct(s.score), `${s.wins}W · ${s.draws}D · ${s.losses}L`,
      s.score != null && s.score >= 55 ? "good" : "", { value: s.score, format: (n) => `${Math.round(n)}%` },
      { delta: delta(m.delta.score, { unit: " pp" }), spark: score.map((p) => (p.value == null ? null : p.value * 100)), info: "Tournament score: a win is 1, a draw ½, a loss 0.", metric: "score" }),
    statCard("Win rate", fmtPct(s.winRate), "draws excluded", "", { value: s.winRate, format: (n) => `${Math.round(n)}%` }, { metric: "winRate" }),
    statCard("Avg accuracy", fmtAcc(s.accuracy), "per game", s.accuracy != null && s.accuracy >= 80 ? "good" : "",
      { value: s.accuracy, format: (n) => n.toFixed(1) },
      { delta: delta(m.delta.accuracy, { unit: " pp" }), spark: points.map((p) => p.accuracy), info: "Average of each game's accuracy in this window.", metric: "accuracy" }),
    statCard("Avg rating", fmtRating(s.rating), ratingSub, "", { value: s.rating, format: (n) => String(Math.round(n)) },
      { delta: delta(m.delta.rating), spark: points.map((p) => p.rating), info: ratingInfo, metric: "rating" }),
    // Lower is better for both of these, so "good" means low.
    statCard("Error rate", errorRate == null ? "—" : `${errorRate}%`, "inaccuracy or worse",
      errorRate == null ? "" : errorRate <= 15 ? "good" : errorRate >= 30 ? "bad" : "",
      errorRate == null ? null : { value: errorRate, format: (n) => `${n.toFixed(1)}%` },
      { info: "Share of your classified moves that were an inaccuracy, mistake, miss or blunder.", metric: "errorRate" }),
    statCard("Consistency", sd.sd == null ? "—" : `±${sd.sd.toFixed(1)}`, "spread of accuracy",
      sd.sd != null && sd.sd <= 10 ? "good" : "", null,
      { info: "One standard deviation of your per-game accuracy. Lower is steadier.", metric: "consistency" }),
    statCard("Avg grade", gradeValues.length ? gradeFormat(meanOf(gradeValues)) : "—", "0-10 per move", "",
      gradeValues.length ? { value: meanOf(gradeValues), format: gradeFormat } : null, { spark: grades.map((g) => g.value), metric: "grade" }),
    // `brilliantCount` counts both sides, so this card uses the per-side tally: "yours" is literal.
    statCard("Brilliants", String(s.brilliants), "yours, across all games", "", { value: s.brilliants, format: (n) => String(Math.round(n)) }, { metric: "brilliants" }),
  );

  const trend = (title, sub, chart) => el("div", { class: "panel" }, el("h3", {}, title), el("p", { class: "sub" }, sub), chart);
  const sections = [];
  const add = (id, eyebrow, title, node) => { if (node) sections.push(sectionFrame({ id, eyebrow, title, node })); };

  add("sec-overview", "Overview", "How you are playing", [cards, inspectorPanel(records)]);
  add("sec-focus", "Coaching", "What to work on", focusPanel(records));
  // The tracker always lists every filtered game (not just the current day), so picking another day
  // is always possible - it is the report window that narrows, not the calendar. It must apply every
  // filter EXCEPT the day and the range: a cell's count has to match what clicking it will show.
  add("sec-daily", "Rhythm", "Daily tracker",
    dailyPanel(filterGames(tracked || records, {
      colour: filterColour, type: filterType, result: filterResult,
      opponent: filterOpponent, opening: filterOpening,
    })));
  add("sec-form", "Momentum", "Recent form", momentumPanel(records));
  add("sec-results", "Results", "How your games end", donutPanel(records));
  add("sec-trends", "Trends", "Accuracy, rating and score", [
    trend("Accuracy over time", "Each game's accuracy with a 5-game moving average. Hover a point; click it to open the game.",
      lineChart(accuracySeries(points), { domain: [0, 100], label: "Accuracy trend", points, format: (v) => v.toFixed(1), hint: "%" })),
    trend("Rating estimate over time", "Your estimated rating per game.",
      lineChart(ratingSeries(points), { label: "Rating trend", points, format: (v) => String(Math.round(v)) })),
    score.some((p) => p.value != null)
      ? trend("Tournament score over time", "Win 1, draw ½, loss 0 — rolling over 10 games.",
        lineChart(score.map((p) => (p.value == null ? null : p.value * 100)), { domain: [0, 100], label: "Score trend", points, format: (v) => `${Math.round(v)}%` }))
      : null,
    gradeValues.length >= 2
      ? trend("Move grade over time", "Your average move grade (0-10) in each game.",
        lineChart(grades.map((g) => g.value), { domain: [0, 10], label: "Grade trend", points, format: gradeFormat }))
      : null,
  ]);
  add("sec-moves", "Moves", "Move quality", el("div", { class: "panel" },
    el("h3", {}, "Move quality"),
    el("p", { class: "sub" }, "How your moves were classified in this window, and what you did with the board."),
    qualityPanel(profile)));
  add("sec-decisions", "Moves", "You and your opponents", decisionPanel(records));
  add("sec-context", "Context", "By colour and time control", [
    splitPanel("By colour", "The same numbers split by the side you played — most players have a clear weaker colour.", colourSplit(records)),
    typeSplit(records).length > 1
      ? splitPanel("By time control", "Where your results and accuracy actually come from.", typeSplit(records))
      : null,
  ]);
  add("sec-rivals", "Opponents", "Head to head", rivalsPanel(records));
  add("sec-dist", "Moves", "Accuracy distribution", histogramPanel(records));
  add("sec-phases", "Moves", "Accuracy by phase", phasePanel(records));
  add("sec-games", "Archive", "Every game", gamesPanel(records));
  add("sec-records", "Records", "Personal bests", bestsPanel(records, tracked));
  _animatedOnce = true;
  return sections;
}
// Local mean for the grade card (lib/progress.js keeps its own private one).
function meanOf(values) {
  const clean = values.filter((v) => v != null);
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

/* ---------------- accuracy by phase ---------------- */
function phasePanel(records) {
  const { covered, phases, worst } = phaseReport(records);
  const rows = phases.map((p) => el("div", { class: `phase ${p.key === worst ? "weak" : ""}` },
    el("div", { class: "name" }, PHASE_LABELS[p.key] || p.key),
    el("div", { class: "bar" }, el("i", { style: { width: `${p.accuracy == null ? 0 : Math.round(p.accuracy)}%` } })),
    el("div", { class: "val" }, fmtAcc(p.accuracy)),
  ));
  const sub = covered
    ? `${covered} ${covered === 1 ? "game" : "games"} carried phase data${worst ? ` · weakest: ${PHASE_LABELS[worst] || worst}` : ""}`
    : "New games record this automatically; older saved games are skipped.";
  return el("div", { class: "panel" },
    el("h3", {}, "Accuracy by phase"),
    el("p", { class: "sub" }, sub),
    ...rows);
}

/* ---------------- personal bests ---------------- */
function bestsPanel(records, streakSource = null) {
  const byId = recordById();
  const rows = personalBests(records, { streakSource }).map((b) => el("tr",
    // Only rows that point at a real game are clickable (and get the hover/pointer styling).
    { class: b.id ? "" : "none", onclick: b.id ? () => openGame(b.id) : null, title: b.id ? "Open this game" : "" },
    el("td", {}, b.label),
    el("td", { class: "big" }, b.text ?? "–"),
    el("td", { class: "hint" }, b.id && byId.get(b.id) ? b.hint : ""),
  ));
  return el("div", { class: "panel" },
    el("h3", {}, "Personal bests"),
    el("p", { class: "sub" }, "Your standout games and runs in this window. Click a row to reopen the game. "
      + "Streaks count every tracked game, so a filter above cannot make unrelated wins look consecutive."),
    el("table", { class: "bests" },
      el("thead", {}, el("tr", {}, el("th", {}, "Best"), el("th", {}, "Value"), el("th", {}, "Game"))),
      el("tbody", {}, ...rows)));
}

/* ---------------- coaching: what to work on ---------------- */
const targetLabel = (target) => {
  if (target.kind === "game") return target.ply ? `move ${Math.ceil(target.ply / 2)}` : "open game";
  if (target.kind === "colour") return `see ${target.label || "these"} games`;
  if (target.kind === "opponent") return `see games vs ${target.label}`;
  return "see these games";
};

// The window's few concrete leaks. Each one is a row with a destination: a review at the decisive move
// when the finding is a single game, or the whole page narrowed to the colour / rival / opening it is
// about. The ranking and thresholds live in focusAreas so they can be tested without a DOM.
function focusPanel(records) {
  const areas = focusAreas(records).slice(0, 4);
  if (!areas.length) {
    return el("div", { class: "panel" },
      el("h3", {}, "What to work on"),
      el("p", { class: "sub" }, "No clear leak in this window: no phase four accuracy points behind the others, "
        + "no colour more than eight score points down, no opening scoring under 45%, and no rival you score "
        + "under 40% against. Play a few more games and this list fills itself in."));
  }
  const rows = areas.map((area, i) => el("div", { class: "focus-row", style: { "--i": String(i) } },
    el("span", { class: "focus-title" }, area.title),
    el("span", { class: "focus-detail" }, area.detail),
    area.target ? el("button", {
      class: "linkbtn focus-go", type: "button",
      title: area.target.kind === "game" ? "Open this game" : "Show only these games",
      onclick: () => applyTarget(area.target),
    }, targetLabel(area.target)) : null));
  return el("div", { class: "panel" },
    el("h3", {}, "What to work on"),
    el("p", { class: "sub" }, "The sharpest edges in this window, ranked by how far below your own baseline they sit. "
      + "Every line goes somewhere: the games behind it, or a review at the move that decided it."),
    el("div", { class: "focus-list" }, ...rows));
}

/* ---------------- head to head ---------------- */
function rivalsPanel(records) {
  const { rows, unnamed } = opponentReport(records);
  if (!rows.length) {
    return el("div", { class: "panel" },
      el("h3", {}, "Head to head"),
      el("p", { class: "sub" }, "None of these games names an opponent, so there is nobody to group them by."));
  }
  const nemesis = rows.filter((r) => r.games >= 3 && r.score != null)
    .reduce((worst, row) => (!worst || row.score < worst.score ? row : worst), null);
  const panel = splitPanel("Head to head",
    "Most played first. Click a row to scope every report to that opponent."
    + (unnamed ? ` ${unnamed} ${unnamed === 1 ? "game has" : "games have"} no opponent name and ${unnamed === 1 ? "is" : "are"} left out.` : ""),
    rows.slice(0, 8), { onclick: (row) => scopeTo({ opponent: row.key }) });
  if (nemesis) {
    panel.append(el("p", { class: "note" },
      `Toughest regular: ${nemesis.name} - ${nemesis.wins}W ${nemesis.draws}D ${nemesis.losses}L in ${nemesis.games} games (${fmtPct(nemesis.score)} score).`));
  }
  return panel;
}

/* ---------------- every game ---------------- */
const GAME_COLS = [
  ["Date", "at"], ["Opponent", "opponent"], ["Colour", "colourLabel"], ["Result", "result"],
  ["Acc", "accuracy"], ["Grade", "grade"], ["Errors", "errors"], ["Moves", "moves"],
];

// The window as a sortable table. A row reopens its review; the button in the last column lands on the
// ply of that game's costliest decision, which is the fastest way from "that game was bad" to "this is
// where it went".
function gamesPanel(records) {
  const all = sortRows(gameRows(records), gameSort.key, gameSort.dir);
  const rows = showAllGames ? all : all.slice(0, 60);
  const th = (label, key) => {
    const active = gameSort.key === key;
    return el("th", {
      class: `sortable${active ? " active" : ""}`,
      "aria-sort": active ? (gameSort.dir === "asc" ? "ascending" : "descending") : "none",
      title: `Sort by ${label.toLowerCase()}`,
      onclick: () => { gameSort = { key, dir: active && gameSort.dir === "desc" ? "asc" : "desc" }; render(); },
    }, label, el("span", { class: "caret" }, active ? (gameSort.dir === "asc" ? "▲" : "▼") : ""));
  };
  const body = rows.map((row) => el("tr", { onclick: () => openGame(row.id), title: "Open this game" },
    el("td", {}, row.date || "—"),
    el("td", {}, row.opponent || "—"),
    el("td", {}, row.colourLabel),
    el("td", {}, row.result ? el("span", { class: `pill ${row.result === "loss" ? "low" : ""}` }, row.result) : "—"),
    el("td", {}, fmtAcc(row.accuracy)),
    el("td", {}, row.grade == null ? "—" : row.grade.toFixed(1)),
    el("td", {}, row.errors == null ? "—" : String(row.errors)),
    el("td", {}, row.moves == null ? "—" : String(row.moves)),
    el("td", { class: "act" }, el("button", {
      class: "linkbtn", type: "button",
      title: row.ply ? "Open the review at this game's worst move" : "Open this game",
      onclick: (e) => { e.stopPropagation(); openGame(row.id, row.ply); },
    }, row.ply ? `move ${Math.ceil(row.ply / 2)}` : "open"))));
  return el("div", { class: "panel" },
    el("h3", {}, "Every game"),
    el("p", { class: "sub" }, `All ${all.length} ${all.length === 1 ? "game" : "games"} in this window, one row each. `
      + "Click a row to reopen the review, or the button to land on that game's costliest move."),
    el("table", { class: "games" },
      el("thead", {}, el("tr", {}, ...GAME_COLS.map(([label, key]) => th(label, key)), el("th", {}, ""))),
      el("tbody", {}, ...body)),
    all.length > 60
      ? el("div", { class: "actions" },
        el("button", {
          class: "btn ghost sm", type: "button",
          onclick: () => { showAllGames = !showAllGames; render(); },
        }, showAllGames ? "Show the newest 60" : `Show all ${all.length} games`),
        el("span", { class: "note" }, `showing ${rows.length} of ${all.length}`))
      : null);
}

/* ---------------- openings tab ---------------- */
function renderOpenings(records) {
  const report = openingReport(records);
  if (!report.length) return el("div", { class: "empty" }, "No openings yet — analyze a game and it will be grouped here.");

  const weak = underperformingOpenings(report);
  const weakKeys = new Set(weak.map((g) => g.key));

  // Click a header to sort; the first click on the active column flips the direction.
  const th = (label, key) => {
    const active = openSort.key === key;
    return el("th", {
      class: `sortable${active ? " active" : ""}`,
      "aria-sort": active ? (openSort.dir === "asc" ? "ascending" : "descending") : "none",
      title: `Sort by ${label.toLowerCase()}`,
      onclick: () => { openSort = { key, dir: active && openSort.dir === "desc" ? "asc" : "desc" }; render(); },
    }, label, el("span", { class: "caret" }, active ? (openSort.dir === "asc" ? "▲" : "▼") : ""));
  };

  const ordered = sortRows(report, openSort.key, openSort.dir);
  // A row scopes the whole report to that opening (the chip in the toolbar clears it); the button in
  // the last column goes straight to your latest game in it.
  const rows = ordered.map((g) => el("tr", { class: weakKeys.has(g.key) ? "warn-row" : "",
    onclick: () => scopeTo({ opening: g.key, label: g.name }),
    title: "Show only your games in this opening" },
    el("td", {}, el("span", { class: "op-name" }, g.name), g.eco ? el("span", { class: "op-eco" }, g.eco) : null),
    el("td", {}, String(g.games)),
    el("td", {}, g.score == null ? "—" : el("span", { class: `pill ${g.score <= 45 ? "low" : ""}` }, fmtPct(g.score))),
    el("td", {}, g.wins + "–" + g.draws + "–" + g.losses),
    el("td", {}, fmtAcc(g.accuracy)),
    el("td", {}, fmtRating(g.opponentRating)),
    el("td", { class: "act" }, g.lastId ? el("button", {
      class: "linkbtn", type: "button", title: "Open your most recent game in this opening",
      onclick: (e) => { e.stopPropagation(); openGame(g.lastId); },
    }, "review") : null),
  ));

  const table = el("table", { class: "openings" },
    el("thead", {}, el("tr", {}, th("Opening", "name"), th("Games", "games"), th("Score", "score"), th("W–D–L", "wins"), th("Avg acc", "accuracy"), th("Opp rating", "opponentRating"), el("th", {}, ""))),
    el("tbody", {}, ...rows));

  const weakRow = (g) => el("tr", { class: "warn-row",
    onclick: () => scopeTo({ opening: g.key, label: g.name }), title: "Show only your games in this opening" },
    el("td", {}, el("span", { class: "op-name" }, g.name), g.eco ? el("span", { class: "op-eco" }, g.eco) : null),
    el("td", {}, String(g.games) + " games"),
    el("td", {}, el("span", { class: "pill low" }, fmtPct(g.score))),
    el("td", { class: "act" }, g.lastId ? el("button", {
      class: "linkbtn", type: "button", title: "Open your most recent game in this opening",
      onclick: (e) => { e.stopPropagation(); openGame(g.lastId); },
    }, "review") : null));

  const weakPanel = el("div", { class: "panel" },
    el("h3", {}, "Openings to look at"),
    el("p", { class: "sub" }, "Played at least 5 times and scoring 45% or less. Click a row to scope the report to it."),
    el("table", {}, el("tbody", {}, ...weak.map(weakRow))));

  const allPanel = el("div", { class: "panel" },
    el("h3", {}, "All openings"),
    el("p", { class: "sub" }, `${report.length} openings from ${records.length} analyzed games. Click a row to scope the report to that opening.`),
    table);

  return el("div", {}, weak.length ? weakPanel : null, allPanel);
}

/* ---------------- shared navigation + opening a game ---------------- */
let activeTab = "progress";
let library = [];
// Storage is user-editable (and a half-written backup can leave a null in it), so nothing downstream may
// assume every entry is a record: one null used to throw in recordById and blank every tab, including
// the Data tab you would repair it from.
const cleanLibrary = (value) => (Array.isArray(value) ? value : [])
  .filter((r) => r && typeof r === "object" && typeof r.id === "string" && r.id);
// The single account this page tracks - the handle from the popup's manual panel (storage "username",
// the same value that seats a review). A library can also hold games reviewed for someone else, or be
// used by another person, so counting all of it would move these numbers for reasons that are not
// your chess. Empty = nothing to filter by, and the page says so instead of pretending.
let username = "";
// A one-shot message shown on the Data tab after a re-render (notice is consumed by renderData).
let notice = "";
let noticeBad = false;
const view = document.getElementById("view");

const recordById = () => new Map(library.map((r) => [r.id, r]));
// Reopen a saved game in the analyzer, reproducing the exact perspective it was saved with (stored
// flip hint first, else the saved side) - the same rule as openLibraryGame in analysis.js.
function openGame(id, ply = null) {
  const rec = recordById().get(id);
  if (!rec || !rec.pgn) return;
  const flip = (rec.meta && rec.meta.flip != null) ? rec.meta.flip : (rec.meSide === "b");
  const meta = { ...(rec.meta || {}), flip };
  // A move-level link lands the review on that position instead of the starting one. The review
  // treats it as one-shot, so it never gets written back into the saved game.
  if (ply != null) meta.startPly = ply;
  openAnalysisTab({ pgn: rec.pgn, meta, source: "library" });
}

// The name as the library last spelled it, for the toolbar chip of an active opponent filter.
function opponentLabel(key) {
  for (const rec of library) if (opponentKey(rec) === key) return String(rec.opName).trim();
  return "selected";
}

/**
 * Narrow the whole page to one slice of the window - a colour, a rival, an opening - then go back to
 * the top so the cards show the new numbers instead of leaving the reader on a panel that no longer
 * describes what is above it.
 */
function scopeTo(patch) {
  if ("colour" in patch) filterColour = patch.colour || "";
  if ("opponent" in patch) filterOpponent = patch.opponent || "";
  if ("opening" in patch) {
    filterOpening = patch.opening || "";
    filterOpeningName = patch.opening ? patch.label || "" : "";
  }
  if ("day" in patch) daySel = patch.day || "";
  inspectKey = "";
  activeTab = "progress";
  render();
  const top = document.getElementById("sec-overview");
  // jsdom (and old browsers) have no scrollIntoView: the scope still applied, the page just stays put.
  if (top && typeof top.scrollIntoView === "function") {
    top.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  }
}

// Where a finding or a row sends the reader: a review at a move, or the whole page scoped to a slice.
function applyTarget(target) {
  if (!target) return;
  if (target.kind === "game") { openGame(target.id, target.ply ?? null); return; }
  if (target.kind === "colour") { scopeTo({ colour: target.value }); return; }
  if (target.kind === "opponent") { scopeTo({ opponent: target.value }); return; }
  if (target.kind === "opening") { scopeTo({ opening: target.value, label: target.label }); return; }
}

function emptyState() {
  return el("div", { class: "empty" }, "Your Library is empty.",
    el("br"), "Analyze a game and its accuracy, rating and opening will appear here automatically.",
    el("br"), "Have a backup? Restore it from the Data tab.");
}

// Who the reports are counting, and what was left out - so "my progress" can never silently mean
// "every game in this library".
function trackingStrip(showing, total) {
  if (!username) {
    return el("p", { class: "tracking warn" },
      el("span", {}, `No username set — showing all ${total} games in the library.`),
      el("span", {}, "Set your username in the extension popup (Manual setup → Username) and this page will count only your games."));
  }
  const skipped = total - showing;
  return el("p", { class: "tracking" },
    el("span", {}, `Tracking `, el("b", {}, username)),
    // "left out" rather than "from other players": a game saved without player names (the Live board)
    // cannot be proven to be someone else's, it just does not match the handle.
    el("span", {}, `${showing} of ${total} games${skipped > 0 ? ` · ${skipped} not matched to this handle` : ""}`));
}

function noGamesForPlayer() {
  return el("div", { class: "empty" }, `No games for ${username} in the library yet.`,
    el("br"), "This page matches either player's name, so it counts the games you played and skips the ones you only reviewed for someone else.");
}

function noGamesInWindow() {
  return el("div", { class: "empty" }, "No games match these filters.",
    el("br"), "Reset them above, or widen the range.");
}

/**
 * The sticky header and toolbar sit over the page, so an anchor jump has to clear both. Their height is
 * not fixed (the tabs wrap on narrow screens, the chip rows wrap with the filters), and a hard-coded
 * `scroll-margin-top` left every jump hiding the heading it aimed at. Measure instead of guessing.
 */
let stickyH = 0;   // header + toolbar, for the jump rail's "am I reading this?" band
function syncStickyOffset() {
  const header = document.querySelector("header.top");
  if (!header) return;
  const style = document.documentElement.style;
  const topH = header.offsetHeight;
  if (topH > 0) style.setProperty("--top-h", `${topH}px`);
  const toolbar = document.querySelector(".toolbar");
  const total = topH + (toolbar ? toolbar.offsetHeight : 0);
  if (total > 0) { stickyH = total; style.setProperty("--sticky-h", `${total}px`); }
}
// Every view swap goes through here so the measured offset always describes what is on screen.
function paint(...nodes) {
  view.replaceChildren(...nodes);
  syncStickyOffset();
}
window.addEventListener("resize", syncStickyOffset);

function render() {
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-pressed", String(b.dataset.tab === activeTab));
  // The Data tab must work on an empty library too - that is where you import one.
  if (activeTab === "data") { paint(renderData()); renderJump([]); return; }
  if (!library.length) { paint(emptyState()); renderJump([]); return; }
  const tracked = username ? ownGames(library, username) : library;
  const toolbar = el("div", { class: "toolbar" },
    trackingStrip(tracked.length, library.length),
    tracked.length ? controlsRow(windowed(tracked).length, tracked) : null);
  if (!tracked.length) { paint(toolbar, noGamesForPlayer()); renderJump([]); return; }
  const records = windowed(tracked);
  const frames = records.length
    ? (activeTab === "openings"
      ? [sectionFrame({ id: "sec-openings", eyebrow: "Openings", title: "Your repertoire", node: renderOpenings(records) })]
      : renderProgress(records, tracked))
    : [];
  paint(toolbar, ...(frames.length ? frames : [noGamesInWindow()]));
  renderJump(frames.map((f) => ({ id: f.id, title: f.querySelector("h2")?.textContent || "" })));
}

for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => { activeTab = b.dataset.tab; render(); });
}

/* ---------------- data tab: backup + restore ---------------- */
const LIBRARY_MAX = 1000;   // mirrors analysis.js: the analyzer keeps the newest 1000 games
const LIBRARY_LOCK = "chess-review-library";
const fmtDateTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(); };

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function renderData() {
  const withPhases = library.filter((r) => r.myPhases).length;
  const status = el("div", { class: `status ${noticeBad ? "bad" : ""}` }, notice);
  const say = (msg, bad = false) => { status.textContent = msg || ""; status.classList.toggle("bad", !!bad); };
  notice = ""; noticeBad = false;   // consumed once

  const includeSettings = el("input", { type: "checkbox", checked: true });
  const mergeBtn = el("button", { class: "btn", disabled: true }, "Merge into library");
  const replaceBtn = el("button", { class: "btn ghost", disabled: true }, "Replace library");
  let pending = null;

  const fileInput = el("input", { type: "file", accept: "application/json,.json", style: { display: "none" } });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";   // let the same file be picked again
    if (!file) return;
    let text;
    try { text = await file.text(); } catch { return say("That file could not be read.", true); }
    const parsed = parseBackup(text);
    if (!parsed.ok) { pending = null; mergeBtn.disabled = replaceBtn.disabled = true; return say(parsed.error, true); }
    pending = parsed.backup;
    const s = backupSummary(pending);
    mergeBtn.disabled = replaceBtn.disabled = false;
    say(`Read a backup from ${s.exportedAt ? fmtDateTime(s.exportedAt) : "an unknown date"}: ${s.games} games`
      + `${s.hasSettings ? ", settings" : ""}${s.hasPlayerHistory ? ", account history" : ""}. Choose how to apply it.`);
  });

  const exportBtn = el("button", { class: "btn", onclick: async () => {
    say("Preparing ...");
    try {
      const all = await browserAPI.storage.local.get(BACKUP_KEYS);
      const backup = createBackup(all);
      const name = `chess-review-backup-${new Date().toISOString().slice(0, 10)}.json`;
      download(name, JSON.stringify(backup, null, 2));
      say(`Exported ${backupSummary(backup).games} games to ${name}.`);
    } catch (e) { say(`Export failed: ${e && e.message ? e.message : e}`, true); }
  } }, "Export backup");

  async function apply(replace) {
    if (!pending) return;
    const s = backupSummary(pending);
    if (replace && !window.confirm(`Replace your library with the ${s.games} games from this backup? This cannot be undone.`)) return;
    say("Restoring ...");
    try {
      const keys = includeSettings.checked ? restorableSettingsKeys(pending) : [];
      // Serialize under the analyzer's own library lock so a concurrent analysis tab cannot lose a
      // save, and re-read the library inside the lock before merging.
      const task = async () => {
        const current = (await browserAPI.storage.local.get("library")).library;
        const merged = replace
          ? replaceLibrary(pending.data.library, { limit: LIBRARY_MAX })
          : mergeLibraries(current, pending.data.library, { limit: LIBRARY_MAX });
        const writes = { library: merged.library };
        for (const key of keys) writes[key] = pending.data[key];
        await browserAPI.storage.local.set(writes);
        return merged;
      };
      const result = navigator.locks && navigator.locks.request
        ? await navigator.locks.request(LIBRARY_LOCK, task) : await task();
      library = result.library;
      notice = replace
        ? `Restored ${result.library.length} games from the backup.`
        : `Merged the backup: ${result.added} new, ${result.updated} updated, ${result.unchanged} unchanged.`;
      noticeBad = false;
      render();
    } catch (e) { say(`Restore failed: ${e && e.message ? e.message : e}`, true); }
  }
  mergeBtn.addEventListener("click", () => apply(false));
  replaceBtn.addEventListener("click", () => apply(true));

  return el("div", {},
    el("div", { class: "panel" },
      el("h3", {}, "Backup and restore"),
      el("p", { class: "sub" }, "Save your library and settings to a file, or move them to another PC."),
      el("div", { class: "actions" }, exportBtn,
        el("button", { class: "btn ghost", onclick: () => fileInput.click() }, "Import backup"), fileInput),
      status,
      el("p", { class: "note" }, `Export carries your ${library.length} games plus whatever settings, handle, layout and account history are stored. `
        + "Per-game analysis caches are left out (they are large and rebuild when a game is reopened). "
        + `Phase data is present for ${withPhases} of ${library.length} games.`)),
    el("div", { class: "panel" },
      el("h3", {}, "When importing"),
      el("label", { class: "check" }, includeSettings, el("span", {}, "Also restore settings, handle and layout")),
      el("div", { class: "actions" }, mergeBtn, replaceBtn),
      el("p", { class: "note" }, "Merging keeps both libraries: games are matched by id and the newer copy wins, so re-importing an older backup never rolls one back. "
        + "Replacing asks for confirmation first.")),
  );
}

view.replaceChildren(skeleton());          // the read below is fast, but never show an empty page
try {
  const stored = await browserAPI.storage.local.get(["library", "username"]);
  library = cleanLibrary(stored.library);
  username = typeof stored.username === "string" ? stored.username.trim() : "";
} catch { library = []; username = ""; }

// The handle (and the library) can change while this page is open - the popup saves one, an analysis
// tab saves games - so follow the storage instead of requiring a reload.
try {
  browserAPI.storage.onChanged?.addListener((changes, area) => {
    if (area && area !== "local") return;
    if (!changes || (!("username" in changes) && !("library" in changes))) return;
    if (changes.username) username = typeof changes.username.newValue === "string" ? changes.username.newValue.trim() : "";
    if (changes.library) library = cleanLibrary(changes.library.newValue);
    render();
  });
} catch { /* no onChanged in this runtime: the page picks both up on its next open */ }

render();
