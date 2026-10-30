// lib/progress.js — pure aggregation behind the Progress page (accuracy/rating trend + opening
// report). Everything here reads only the records the analyzer already saves to
// browserAPI.storage.local["library"]; it never touches storage, the engine or the network, so the
// helpers run directly in Node (see tests/progress.test.mjs).
//
// A library record (see saveToLibrary in analysis.js) is shaped like:
//   { id, savedAt, pgn, meta, meSide, myName, opName, myAcc, opAcc, myRating, opRating,
//     result, type, eco, opening, date, url, hasBrilliant, brilliantCount, myBrilliant, fav, solved,
//     plies, myPhases }
// Only complete analyses are ever saved, so every record is a finished game. `result` is
// "win" | "loss" | "draw" | "" and all accuracy/rating fields may be null.
// `plies` is the game length (half-moves) and `myPhases` is the analyzed side's accuracy in
// { opening, middlegame, endgame }; both are absent on records saved before they were added, which
// the phase/personal-best reports tolerate by simply skipping those games.

const RESULTS = new Set(["win", "loss", "draw"]);

const asNumber = (value) => {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

const mean = (values) => {
  const clean = values.filter((v) => v != null);
  return clean.length ? clean.reduce((sum, v) => sum + v, 0) / clean.length : null;
};

/** Drop anything that isn't a game record (guards against a corrupted storage entry). */
export function libraryRecords(records) {
  return (Array.isArray(records) ? records : []).filter((r) => r && typeof r === "object" && r.id);
}

/** Oldest → newest, so a chart reads left to right. */
export function sortChronological(records) {
  return [...libraryRecords(records)].sort((a, b) => (asNumber(a.savedAt) ?? 0) - (asNumber(b.savedAt) ?? 0));
}

/** One point per game for the accuracy / rating / brilliants series. */
export function progressPoints(records) {
  return sortChronological(records).map((r) => ({
    id: r.id,
    label: r.date || "",
    savedAt: asNumber(r.savedAt),
    result: RESULTS.has(r.result) ? r.result : "",
    type: r.type || "",
    accuracy: asNumber(r.myAcc),
    rating: asNumber(r.myRating),
    brilliants: asNumber(r.brilliantCount) ?? 0,
  }));
}

/** Headline numbers for the dashboard cards. */
export function summarizeProgress(records) {
  const points = progressPoints(records);
  const accuracies = [];
  const ratings = [];
  let wins = 0, losses = 0, draws = 0, other = 0, brilliants = 0;
  for (const p of points) {
    if (p.result === "win") wins++;
    else if (p.result === "loss") losses++;
    else if (p.result === "draw") draws++;
    else other++;
    if (p.accuracy != null) accuracies.push(p.accuracy);
    if (p.rating != null) ratings.push(p.rating);
    brilliants += p.brilliants;
  }
  const played = wins + losses;                        // draws are excluded from "win rate"
  const decided = wins + losses + draws;               // chess "score %" counts a draw as half
  return {
    games: points.length, wins, losses, draws, other, brilliants,
    winRate: played ? (100 * wins) / played : null,
    score: decided ? (100 * (wins + draws / 2)) / decided : null,
    accuracy: mean(accuracies),
    rating: mean(ratings),
    first: points[0]?.savedAt ?? null,
    last: points.at(-1)?.savedAt ?? null,
  };
}

/** Identity of an opening: the ECO code plus the book name, or a single "unknown" bucket. */
export function openingKey(record) {
  const eco = String(record?.eco || "").trim();
  const name = String(record?.opening || "").trim();
  if (!eco && !name) return { key: "unknown", eco: "", name: "Other / unnamed" };
  return { key: `${eco}|${name}`, eco, name: name || eco };
}

/** Group the library by opening, with the same win-rate / score / accuracy math as the summary. */
export function openingReport(records, { minGames = 1 } = {}) {
  const groups = new Map();
  for (const r of libraryRecords(records)) {
    const { key, eco, name } = openingKey(r);
    if (!groups.has(key)) groups.set(key, { key, eco, name, games: 0, wins: 0, losses: 0, draws: 0, accuracies: [], ratings: [], last: null });
    const g = groups.get(key);
    g.games++;
    if (r.result === "win") g.wins++;
    else if (r.result === "loss") g.losses++;
    else if (r.result === "draw") g.draws++;
    const acc = asNumber(r.myAcc);
    if (acc != null) g.accuracies.push(acc);
    const op = asNumber(r.opRating);
    if (op != null) g.ratings.push(op);
    const savedAt = asNumber(r.savedAt) ?? 0;
    if (!g.last || savedAt > g.last.savedAt) g.last = { id: r.id, savedAt };
  }
  return [...groups.values()].map((g) => {
    const played = g.wins + g.losses;
    const decided = g.wins + g.losses + g.draws;
    return {
      key: g.key, eco: g.eco, name: g.name, games: g.games,
      wins: g.wins, losses: g.losses, draws: g.draws,
      winRate: played ? (100 * g.wins) / played : null,
      score: decided ? (100 * (g.wins + g.draws / 2)) / decided : null,
      accuracy: mean(g.accuracies),
      opponentRating: mean(g.ratings),
      lastId: g.last?.id ?? null,
    };
  })
    .filter((g) => g.games >= minGames)
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
}

/** Openings played often enough but scored poorly — the "you keep losing this" list. */
export function underperformingOpenings(report, { minGames = 5, maxScore = 45 } = {}) {
  return report
    .filter((g) => g.games >= minGames && g.score != null && g.score <= maxScore)
    .sort((a, b) => a.score - b.score || b.games - a.games);
}

/** Simple trailing average; nulls inside the window are skipped and never break the line. */
export function movingAverage(values, window = 5) {
  return values.map((_, i) => mean(values.slice(Math.max(0, i - window + 1), i + 1)));
}

/**
 * SVG polyline path for a series, skipping null gaps. Pure: for a given viewBox it always returns
 * the same string, so the chart math is testable without a DOM. Returns "" when fewer than two
 * points remain.
 */
export function linePath(values, { width = 100, height = 100, pad = 4, min = null, max = null } = {}) {
  const points = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (points.length < 2) return "";
  const lo = min ?? Math.min(...points.map(([, v]) => v));
  const hi = max ?? Math.max(...points.map(([, v]) => v));
  const span = hi - lo || 1;
  const n = values.length - 1 || 1;
  return points
    .map(([i, v], idx) => {
      const x = pad + (width - 2 * pad) * (i / n);
      const y = pad + (height - 2 * pad) * (1 - (v - lo) / span);
      return `${idx ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

/* ---------------- per-phase accuracy ---------------- */
// The analyzer computes per-phase accuracy with the same tuned method as the whole-game number; the
// library only stores the analyzed side's three phases, so this report can only average those.
export const PHASE_KEYS = ["opening", "middlegame", "endgame"];

/** Average accuracy per game phase across the library, plus how many games carried phase data. */
export function phaseReport(records) {
  const values = { opening: [], middlegame: [], endgame: [] };
  let covered = 0;
  for (const rec of libraryRecords(records)) {
    const phases = rec.myPhases;
    if (!phases || typeof phases !== "object") continue;
    let used = false;
    for (const key of PHASE_KEYS) {
      const v = asNumber(phases[key]);
      if (v == null) continue;
      values[key].push(v);
      used = true;
    }
    if (used) covered++;
  }
  const phases = PHASE_KEYS.map((key) => ({ key, accuracy: mean(values[key]), games: values[key].length }));
  // The weakest phase you have played enough of to trust (minGames guards a single bad move).
  const rankable = phases.filter((p) => p.games >= 3 && p.accuracy != null);
  const worst = rankable.length ? rankable.reduce((a, b) => (b.accuracy < a.accuracy ? b : a)) : null;
  return { covered, phases, worst: worst ? worst.key : null };
}

/* ---------------- personal bests ---------------- */
const bestLabel = (rec) => [rec?.date, rec?.opName ? `vs ${rec.opName}` : ""].filter(Boolean).join(" · ");

/**
 * The stand-out single game / run in the library. Each entry is { key, label, value, text, hint, id }
 * where `id` is the game to open, or null when the category has no qualifying game yet. Pure.
 */
export function personalBests(records) {
  const ordered = sortChronological(records);   // oldest -> newest, so streaks read forward
  const pick = (test, compare) => {
    let best = null;
    for (const rec of ordered) {
      const value = test(rec);
      if (value == null) continue;
      if (!best || compare(value, best.value)) best = { value, rec };
    }
    return best;
  };

  const accuracy = pick((r) => asNumber(r.myAcc), (v, b) => v > b);
  const brilliants = pick((r) => (asNumber(r.brilliantCount) ?? 0) || null, (v, b) => v > b);
  const topWin = pick((r) => (r.result === "win" ? asNumber(r.opRating) : null), (v, b) => v > b);
  const fastestWin = pick((r) => (r.result === "win" && asNumber(r.plies) ? asNumber(r.plies) : null), (v, b) => v < b);

  let win = 0, unbeaten = 0, bestWin = 0, bestUnbeaten = 0, winEnd = null, unbeatenEnd = null;
  for (const rec of ordered) {
    if (rec.result === "win") { win++; unbeaten++; }
    else if (rec.result === "draw") { win = 0; unbeaten++; }
    else { win = 0; unbeaten = 0; }
    if (win > bestWin) { bestWin = win; winEnd = rec; }
    if (unbeaten > bestUnbeaten) { bestUnbeaten = unbeaten; unbeatenEnd = rec; }
  }

  const entry = (key, label, best, text) => best
    ? { key, label, value: best.value, text: text(best.value), hint: bestLabel(best.rec), id: best.rec.id }
    : { key, label, value: null, text: null, hint: "", id: null };
  return [
    entry("accuracy", "Best accuracy", accuracy, (v) => v.toFixed(1)),
    entry("winStreak", "Longest win streak", bestWin ? { value: bestWin, rec: winEnd } : null, (v) => `${v} ${v === 1 ? "game" : "games"}`),
    entry("unbeaten", "Longest unbeaten run", bestUnbeaten ? { value: bestUnbeaten, rec: unbeatenEnd } : null, (v) => `${v} ${v === 1 ? "game" : "games"}`),
    entry("brilliants", "Most brilliants in a game", brilliants, (v) => String(v)),
    entry("topWin", "Highest-rated win", topWin, (v) => String(Math.round(v))),
    entry("fastestWin", "Fastest win", fastestWin, (v) => `${v} ${v === 1 ? "move" : "moves"}`),
  ];
}
