// progress.js — the standalone Progress page. Reads the saved Library (browserAPI.storage.local
// .library) and draws two engine-free reports: a personal Progress trend and an Opening report.
// All the math lives in lib/progress.js so it can be unit-tested in Node; this file is only DOM.

import { browserAPI } from "./browser-compat.js";
import { openAnalysisTab } from "./analyze-flow.js";
import {
  progressPoints, summarizeProgress, openingReport, underperformingOpenings,
  movingAverage, linePath,
} from "./lib/progress.js";

/* ---------------- tiny DOM helpers ---------------- */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v);
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

/* ---------------- chart ---------------- */
const CHART_W = 640;
const CHART_H = 170;

function accuracySeries(points) { return points.map((p) => p.accuracy); }
function ratingSeries(points) { return points.map((p) => p.rating); }

// One line chart. `domain` fixes the vertical range (accuracy is always 0–100 so the line's height
// stays comparable between visits); otherwise the range fits the data.
function lineChart(values, { domain = null, label }) {
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
  if (raw) box.append(svg("path", { d: raw, fill: "none", stroke: "var(--line)", "stroke-width": "1.5", "vector-effect": "non-scaling-stroke" }));
  box.append(svg("path", { d: smooth, fill: "none", stroke: "var(--accent)", "stroke-width": "2.5", "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));
  return el("div", {},
    el("div", { class: "sub", style: { display: "flex", justifyContent: "space-between" } },
      el("span", {}, `low ${lo.toFixed(0)}`), el("span", {}, `high ${hi.toFixed(0)}`)),
    box);
}

/* ---------------- progress tab ---------------- */
function statCard(k, v, hint, cls = "") {
  return el("div", { class: `card ${cls}` }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), hint ? el("div", { class: "h" }, hint) : null);
}

function renderProgress(records) {
  const points = progressPoints(records);
  const s = summarizeProgress(records);
  const range = s.first && s.last ? `${fmtDate(s.first)} – ${fmtDate(s.last)}` : "";
  const cards = el("div", { class: "cards" },
    statCard("Games", String(s.games), range),
    statCard("Score", fmtPct(s.score), `${s.wins}W · ${s.draws}D · ${s.losses}L`, s.score != null && s.score >= 55 ? "good" : ""),
    statCard("Win rate", fmtPct(s.winRate), "draws excluded"),
    statCard("Avg accuracy", fmtAcc(s.accuracy), s.accuracy != null && s.accuracy >= 80 ? "strong" : "", s.accuracy != null && s.accuracy >= 80 ? "good" : ""),
    statCard("Avg rating", fmtRating(s.rating), "your estimated rating"),
    statCard("Brilliants", String(s.brilliants), "across all games"),
  );
  return el("div", {},
    cards,
    el("div", { class: "panel" }, el("h3", {}, "Accuracy over time"), el("p", { class: "sub" }, "Each game's accuracy, with a 5-game moving average."), lineChart(accuracySeries(points), { domain: [0, 100], label: "Accuracy trend" })),
    el("div", { class: "panel" }, el("h3", {}, "Rating estimate over time"), el("p", { class: "sub" }, "Your estimated rating per game."), lineChart(ratingSeries(points), { label: "Rating trend" })),
  );
}

/* ---------------- openings tab ---------------- */
function renderOpenings(records) {
  const report = openingReport(records);
  if (!report.length) return el("div", { class: "empty" }, "No openings yet — analyze a game and it will be grouped here.");

  const weak = underperformingOpenings(report);
  const weakKeys = new Set(weak.map((g) => g.key));
  const byId = new Map(records.map((r) => [r.id, r]));

  const openGame = (id) => {
    const rec = byId.get(id);
    if (!rec || !rec.pgn) return;
    openAnalysisTab({ pgn: rec.pgn, meta: { ...(rec.meta || {}), flip: rec.meSide === "b" }, source: "library" });
  };

  const rows = report.map((g) => el("tr", { class: weakKeys.has(g.key) ? "warn-row" : "", onclick: () => g.lastId && openGame(g.lastId), title: "Open your most recent game in this opening" },
    el("td", {}, el("span", { class: "op-name" }, g.name), g.eco ? el("span", { class: "op-eco" }, g.eco) : null),
    el("td", {}, String(g.games)),
    el("td", {}, g.score == null ? "–" : el("span", { class: `pill ${g.score <= 45 ? "low" : ""}` }, fmtPct(g.score))),
    el("td", {}, g.wins + "–" + g.draws + "–" + g.losses),
    el("td", {}, fmtAcc(g.accuracy)),
    el("td", {}, fmtRating(g.opponentRating)),
  ));

  const table = el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Opening"), el("th", {}, "Games"), el("th", {}, "Score"), el("th", {}, "W–D–L"), el("th", {}, "Avg acc"), el("th", {}, "Opp rating"))),
    el("tbody", {}, ...rows));

  const weakRow = (g) => el("tr", { class: "warn-row", onclick: () => g.lastId && openGame(g.lastId) },
    el("td", {}, el("span", { class: "op-name" }, g.name), g.eco ? el("span", { class: "op-eco" }, g.eco) : null),
    el("td", {}, String(g.games) + " games"),
    el("td", {}, el("span", { class: "pill low" }, fmtPct(g.score))));

  const weakPanel = el("div", { class: "panel" },
    el("h3", {}, "Openings to look at"),
    el("p", { class: "sub" }, "Played at least 5 times and scoring 45% or less. Click a row to review your latest game in it."),
    el("table", {}, el("tbody", {}, ...weak.map(weakRow))));

  const allPanel = el("div", { class: "panel" },
    el("h3", {}, "All openings"),
    el("p", { class: "sub" }, `${report.length} openings from ${records.length} analyzed games. Click a row to review your latest game in it.`),
    table);

  return el("div", {}, weak.length ? weakPanel : null, allPanel);
}

/* ---------------- boot ---------------- */
let activeTab = "progress";
let library = [];
const view = document.getElementById("view");

function render() {
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-pressed", String(b.dataset.tab === activeTab));
  view.replaceChildren(library.length
    ? (activeTab === "openings" ? renderOpenings(library) : renderProgress(library))
    : el("div", { class: "empty" }, "Your Library is empty.",
        el("br"), "Analyze a game and its accuracy, rating and opening will appear here automatically."));
}

for (const b of document.querySelectorAll(".tab")) {
  b.addEventListener("click", () => { activeTab = b.dataset.tab; render(); });
}

try {
  const stored = await browserAPI.storage.local.get("library");
  library = Array.isArray(stored.library) ? stored.library : [];
} catch { library = []; }
render();
