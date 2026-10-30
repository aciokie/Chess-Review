// progress.js — the standalone Progress page. Reads the saved Library (browserAPI.storage.local
// .library) and draws two engine-free reports: a personal Progress trend and an Opening report.
// All the math lives in lib/progress.js so it can be unit-tested in Node; this file is only DOM.

import { browserAPI } from "./browser-compat.js";
import { openAnalysisTab } from "./analyze-flow.js";
import {
  progressPoints, summarizeProgress, openingReport, underperformingOpenings,
  movingAverage, linePath, phaseReport, personalBests,
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
    else if (k === "style" && v && typeof v === "object") Object.assign(n.style, v);
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
    phasePanel(records),
    bestsPanel(records),
  );
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

/* ---------------- shared navigation + opening a game ---------------- */
let activeTab = "progress";
let library = [];
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

function render() {
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-pressed", String(b.dataset.tab === activeTab));
  // The Data tab must work on an empty library too - that is where you import one.
  if (activeTab === "data") { view.replaceChildren(renderData()); return; }
  view.replaceChildren(library.length
    ? (activeTab === "openings" ? renderOpenings(library) : renderProgress(library))
    : emptyState());
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
  const stored = await browserAPI.storage.local.get("library");
  library = Array.isArray(stored.library) ? stored.library : [];
} catch { library = []; }
render();
