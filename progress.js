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
function countUp(node, { value, format = String, ms = 700 }) {
  if (!Number.isFinite(value) || reducedMotion()) return;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - (1 - p) ** 3;
    node.textContent = format(value * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  node.textContent = format(0);
  requestAnimationFrame(step);
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
  return filterGames(sliceRange(records, rangeLast), { colour: filterColour, type: filterType, result: filterResult });
}
function controlsRow(viewCount) {
  const types = typeSplit(library).map((t) => [t.label, t.key]);
  const typeOptions = [["Any time control", ""], ...types];
  const filtering = !!(rangeLast || filterColour || filterType || filterResult);
  return el("div", { class: "controls" },
    chipRow("Games", RANGES, rangeLast, (v) => { rangeLast = v; }),
    chipRow("Colour", [["Both", ""], ["White", "w"], ["Black", "b"]], filterColour, (v) => { filterColour = v; }),
    chipRow("Result", RESULTS, filterResult, (v) => { filterResult = v; }),
    typeOptions.length > 1 ? chipRow("Format", typeOptions, filterType, (v) => { filterType = v; }) : null,
    el("div", { class: "chip-row" },
      el("span", { class: "chip-label" }, `${viewCount} ${viewCount === 1 ? "game" : "games"}`),
      filtering ? chip("Reset filters", false, () => { rangeLast = 0; filterColour = ""; filterType = ""; filterResult = ""; render(); }) : null));
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
function statCard(k, text, hint, cls = "", count = null) {
  const v = el("div", { class: "v" }, text);
  if (count && Number.isFinite(count.value)) countUp(v, count);
  return el("div", { class: `card ${cls}` }, el("div", { class: "k" }, k), v, hint ? el("div", { class: "h" }, hint) : null);
}
// Cards rise in one after another; the delay comes from --i so the order is explicit in the DOM.
const cardGrid = (...cards) => el("div", { class: "cards" },
  ...cards.map((card, i) => { card.style.setProperty("--i", String(i)); return card; }));

// A split panel: one row per bucket (colour, time class) with an animated score bar.
function splitPanel(title, sub, rows) {
  const body = rows.map((row, i) => el("div", { class: "split", style: { "--i": String(i) } },
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

function renderProgress(records) {
  const points = progressPoints(records);
  const s = summarizeProgress(records);
  const range = s.first && s.last ? `${fmtDate(s.first)} – ${fmtDate(s.last)}` : "";
  const profile = decisionProfile(records);
  const sd = stability(records);
  const grades = gradeSeries(records);
  const gradeAvg = grades.map((g) => g.value).filter((v) => v != null);
  const score = scoreTrend(records, 10);
  const gradeFormat = (v) => (v == null ? "—" : v.toFixed(1));

  const cards = cardGrid(
    statCard("Games", String(s.games), range, "", { value: s.games, format: (n) => String(Math.round(n)) }),
    statCard("Score", fmtPct(s.score), `${s.wins}W · ${s.draws}D · ${s.losses}L`,
      s.score != null && s.score >= 55 ? "good" : "", { value: s.score, format: (n) => `${Math.round(n)}%` }),
    statCard("Win rate", fmtPct(s.winRate), "draws excluded", "", { value: s.winRate, format: (n) => `${Math.round(n)}%` }),
    statCard("Avg accuracy", fmtAcc(s.accuracy), s.accuracy != null && s.accuracy >= 80 ? "strong start" : "per game",
      s.accuracy != null && s.accuracy >= 80 ? "good" : "", { value: s.accuracy, format: (n) => n.toFixed(1) }),
    statCard("Avg rating", fmtRating(s.rating), "your estimated rating", "", { value: s.rating, format: (n) => String(Math.round(n)) }),
    // Lower is better for both of these, so "good" means low.
    statCard("Error rate", profile?.errorRate == null ? "—" : `${profile.errorRate}%`, "inaccuracy or worse",
      profile?.errorRate == null ? "" : profile.errorRate <= 15 ? "good" : profile.errorRate >= 30 ? "bad" : "",
      profile?.errorRate == null ? null : { value: profile.errorRate, format: (n) => `${n.toFixed(1)}%` }),
    statCard("Consistency", sd.sd == null ? "—" : `±${sd.sd.toFixed(1)}`, "spread of accuracy", sd.sd != null && sd.sd <= 10 ? "good" : ""),
    statCard("Avg grade", gradeAvg.length ? gradeFormat(meanOf(gradeAvg)) : "—", "0-10 per move", "", gradeAvg.length ? { value: meanOf(gradeAvg), format: gradeFormat } : null),
    statCard("Brilliants", String(s.brilliants), "across all games", "", { value: s.brilliants, format: (n) => String(Math.round(n)) }),
  );
  return el("div", {},
    cards,
    momentumPanel(records),
    el("div", { class: "panel" }, el("h3", {}, "Accuracy over time"), el("p", { class: "sub" }, "Each game's accuracy, with a 5-game moving average. Hover a point; click it to open the game."),
      lineChart(accuracySeries(points), { domain: [0, 100], label: "Accuracy trend", points, format: (v) => v.toFixed(1), hint: "%" })),
    el("div", { class: "panel" }, el("h3", {}, "Rating estimate over time"), el("p", { class: "sub" }, "Your estimated rating per game."),
      lineChart(ratingSeries(points), { label: "Rating trend", points, format: (v) => String(Math.round(v)) })),
    score.some((p) => p.value != null)
      ? el("div", { class: "panel" }, el("h3", {}, "Tournament score over time"), el("p", { class: "sub" }, "Win 1, draw ½, loss 0 - rolling over 10 games."),
        lineChart(score.map((p) => (p.value == null ? null : p.value * 100)), { domain: [0, 100], label: "Score trend", points, format: (v) => `${Math.round(v)}%` }))
      : null,
    gradeAvg.length >= 2
      ? el("div", { class: "panel" }, el("h3", {}, "Move grade over time"), el("p", { class: "sub" }, "Your average move grade (0-10) in each game."),
        lineChart(grades.map((g) => g.value), { domain: [0, 10], label: "Grade trend", points, format: gradeFormat }))
      : null,
    histogramPanel(records),
    splitPanel("By colour", "The same numbers split by the side you played - most players have a clear weaker colour.", colourSplit(records)),
    typeSplit(records).length > 1
      ? splitPanel("By time control", "Where your results and accuracy actually come from.", typeSplit(records))
      : null,
    decisionPanel(records),
    phasePanel(records),
    bestsPanel(records),
  );
}
// Local mean for the grade card (lib/progress.js keeps its own private one).
function meanOf(values) {
  const clean = values.filter((v) => v != null);
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

/* ---------------- accuracy by phase ---------------- */
const PHASE_LABELS = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };

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
function bestsPanel(records) {
  const byId = recordById();
  const rows = personalBests(records).map((b) => el("tr",
    // Only rows that point at a real game are clickable (and get the hover/pointer styling).
    { class: b.id ? "" : "none", onclick: b.id ? () => openGame(b.id) : null, title: b.id ? "Open this game" : "" },
    el("td", {}, b.label),
    el("td", { class: "big" }, b.text ?? "–"),
    el("td", { class: "hint" }, b.id && byId.get(b.id) ? b.hint : ""),
  ));
  return el("div", { class: "panel" },
    el("h3", {}, "Personal bests"),
    el("p", { class: "sub" }, "Your standout games and runs. Click a row to reopen the game."),
    el("table", { class: "bests" },
      el("thead", {}, el("tr", {}, el("th", {}, "Best"), el("th", {}, "Value"), el("th", {}, "Game"))),
      el("tbody", {}, ...rows)));
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
  const rows = ordered.map((g) => el("tr", { class: weakKeys.has(g.key) ? "warn-row" : "", onclick: () => g.lastId && openGame(g.lastId), title: "Open your most recent game in this opening" },
    el("td", {}, el("span", { class: "op-name" }, g.name), g.eco ? el("span", { class: "op-eco" }, g.eco) : null),
    el("td", {}, String(g.games)),
    el("td", {}, g.score == null ? "—" : el("span", { class: `pill ${g.score <= 45 ? "low" : ""}` }, fmtPct(g.score))),
    el("td", {}, g.wins + "–" + g.draws + "–" + g.losses),
    el("td", {}, fmtAcc(g.accuracy)),
    el("td", {}, fmtRating(g.opponentRating)),
  ));

  const table = el("table", { class: "openings" },
    el("thead", {}, el("tr", {}, th("Opening", "name"), th("Games", "games"), th("Score", "score"), th("W–D–L", "wins"), th("Avg acc", "accuracy"), th("Opp rating", "opponentRating"))),
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

/* ---------------- shared navigation + opening a game ---------------- */
let activeTab = "progress";
let library = [];
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
function openGame(id) {
  const rec = recordById().get(id);
  if (!rec || !rec.pgn) return;
  const flip = (rec.meta && rec.meta.flip != null) ? rec.meta.flip : (rec.meSide === "b");
  openAnalysisTab({ pgn: rec.pgn, meta: { ...(rec.meta || {}), flip }, source: "library" });
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
    return el("p", { class: "note" }, `No username set - showing all ${total} games in the library. `
      + "Set your username in the extension popup (Manual setup - Username) and this page will count only your games.");
  }
  const skipped = total - showing;
  return el("p", { class: "sub" }, `Tracking ${username} - ${showing} of ${total} games`
    + (skipped > 0 ? `, ${skipped} from other players left out.` : "."));
}

function noGamesForPlayer() {
  return el("div", { class: "empty" }, `No games for ${username} in the library yet.`,
    el("br"), "This page matches either player's name, so it counts the games you played and skips the ones you only reviewed for someone else.");
}

function noGamesInWindow() {
  return el("div", { class: "empty" }, "No games match these filters.",
    el("br"), "Reset them above, or widen the range.");
}

function render() {
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-pressed", String(b.dataset.tab === activeTab));
  // The Data tab must work on an empty library too - that is where you import one.
  if (activeTab === "data") { view.replaceChildren(renderData()); return; }
  if (!library.length) { view.replaceChildren(emptyState()); return; }
  const tracked = username ? ownGames(library, username) : library;
  const strip = trackingStrip(tracked.length, library.length);
  if (!tracked.length) { view.replaceChildren(strip, noGamesForPlayer()); return; }
  const records = windowed(tracked);
  view.replaceChildren(
    strip,
    controlsRow(records.length),
    records.length ? (activeTab === "openings" ? renderOpenings(records) : renderProgress(records)) : noGamesInWindow());
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

try {
  const stored = await browserAPI.storage.local.get(["library", "username"]);
  library = Array.isArray(stored.library) ? stored.library : [];
  username = typeof stored.username === "string" ? stored.username.trim() : "";
} catch { library = []; username = ""; }

// The handle (and the library) can change while this page is open - the popup saves one, an analysis
// tab saves games - so follow the storage instead of requiring a reload.
try {
  browserAPI.storage.onChanged?.addListener((changes, area) => {
    if (area && area !== "local") return;
    if (!changes || (!("username" in changes) && !("library" in changes))) return;
    if (changes.username) username = typeof changes.username.newValue === "string" ? changes.username.newValue.trim() : "";
    if (changes.library) library = Array.isArray(changes.library.newValue) ? changes.library.newValue : [];
    render();
  });
} catch { /* no onChanged in this runtime: the page picks both up on its next open */ }

render();
