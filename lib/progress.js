// lib/progress.js — pure aggregation behind the Progress page (accuracy/rating trend + opening
// report). Everything here reads only the records the analyzer already saves to
// browserAPI.storage.local["library"]; it never touches storage, the engine or the network, so the
// helpers run directly in Node (see tests/progress.test.mjs).
//
// A library record (see saveToLibrary in analysis.js) is shaped like:
//   { id, savedAt, pgn, meta, meSide, myName, opName, myAcc, opAcc, myRating, opRating,
//     result, type, eco, opening, date, url, hasBrilliant, brilliantCount, myBrilliant, fav, solved }
// Only complete analyses are ever saved, so every record is a finished game. `result` is
// "win" | "loss" | "draw" | "" and all accuracy/rating fields may be null.

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
