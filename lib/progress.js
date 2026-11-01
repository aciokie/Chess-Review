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

const normName = (value) => String(value == null ? "" : value).trim().toLowerCase();

/**
 * Which side of a record the given account played ("w" | "b"), or null when they are neither player.
 * Matches either seat, because a library can also hold games saved from the opponent's perspective
 * (a friend's game, or a record saved before the handle was known).
 */
export function playerSide(record, username) {
  const who = normName(username);
  if (!who || !record) return null;
  const saved = record.meSide === "b" ? "b" : "w";
  if (normName(record.myName) === who) return saved;
  if (normName(record.opName) === who) return saved === "b" ? "w" : "b";
  return null;
}

/**
 * Only the games one account played, re-pointed so the "my*" fields always describe that account:
 * a record saved from the other seat gets its accuracy, rating and names swapped and its result
 * inverted. The opponent's per-phase accuracy is not stored, so those games contribute no phases.
 * Nothing is dropped when `username` is empty - callers decide what to show in that case.
 */
export function ownGames(records, username) {
  const out = [];
  for (const record of libraryRecords(records)) {
    const side = playerSide(record, username);
    if (!side) continue;
    const saved = record.meSide === "b" ? "b" : "w";
    if (side === saved) { out.push(record); continue; }
    out.push({
      ...record,
      meSide: side,
      myName: record.opName,
      opName: record.myName,
      myAcc: record.opAcc,
      opAcc: record.myAcc,
      myRating: record.opRating,
      opRating: record.myRating,
      myPhases: null,
      result: record.result === "win" ? "loss" : record.result === "loss" ? "win" : record.result,
    });
  }
  return out;
}

/* ---------------- filtering the report window ---------------- */

/** The newest `last` games (or all of them). Ranges are applied to every card on the page. */
export function sliceRange(records, last) {
  const ordered = sortChronological(records);
  return last && last > 0 ? ordered.slice(-last) : ordered;
}

/**
 * Keep the games matching every given filter. Each filter is optional; `colour` is "w" | "b",
 * `type` a time class and `result` "win" | "loss" | "draw".
 */
export function filterGames(records, { colour = "", type = "", result = "" } = {}) {
  return libraryRecords(records).filter((r) =>
    (!colour || (r.meSide === "b" ? "b" : "w") === colour)
    && (!type || r.type === type)
    && (!result || r.result === result));
}

/** White/Black split: volume, outcome and accuracy per colour, so a colour bias is visible. */
export function colourSplit(records) {
  const rows = [];
  for (const colour of ["w", "b"]) {
    const mine = filterGames(records, { colour });
    const points = progressPoints(mine);
    const wins = points.filter((p) => p.result === "win").length;
    const losses = points.filter((p) => p.result === "loss").length;
    const draws = points.filter((p) => p.result === "draw").length;
    const decided = wins + losses + draws;
    rows.push({
      key: colour,
      label: colour === "w" ? "White" : "Black",
      games: mine.length,
      wins, draws, losses,
      // Score like a tournament table: a win is 1, a draw ½, of the games that have a result.
      score: decided ? Math.round(((wins + draws / 2) / decided) * 1000) / 10 : null,
      accuracy: mean(points.map((p) => p.accuracy)),
    });
  }
  return rows;
}

/** The same split by time class (Bullet/Blitz/Rapid/Classical/Daily), most played first. */
export function typeSplit(records) {
  const byType = new Map();
  for (const record of libraryRecords(records)) {
    const key = record.type || "Unrated";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(record);
  }
  return [...byType.entries()]
    .map(([key, mine]) => {
      const points = progressPoints(mine);
      const wins = points.filter((p) => p.result === "win").length;
      const losses = points.filter((p) => p.result === "loss").length;
      const draws = points.filter((p) => p.result === "draw").length;
      const decided = wins + losses + draws;
      return {
        key, label: key, games: mine.length, wins, draws, losses,
        score: decided ? Math.round(((wins + draws / 2) / decided) * 1000) / 10 : null,
        accuracy: mean(points.map((p) => p.accuracy)),
      };
    })
    .sort((a, b) => b.games - a.games || a.key.localeCompare(b.key));
}

/* ---------------- decision quality ---------------- */

// The classifier's categories, grouped the way a player thinks about them. Kept here (not imported
// from analysis.js, which has no exports) because these are report labels, not scoring rules.
export const DECISION_GROUPS = [
  { key: "brilliant", label: "Brilliant", kind: "best" },
  { key: "great", label: "Great", kind: "best" },
  { key: "best", label: "Best", kind: "best" },
  { key: "excellent", label: "Excellent", kind: "good" },
  { key: "good", label: "Good", kind: "good" },
  { key: "book", label: "Book", kind: "book" },
  { key: "forced", label: "Forced", kind: "book" },
  { key: "inacc", label: "Inaccuracy", kind: "error" },
  { key: "mistake", label: "Mistake", kind: "error" },
  { key: "miss", label: "Miss", kind: "error" },
  { key: "blunder", label: "Blunder", kind: "error" },
];
export const ERROR_KEYS = DECISION_GROUPS.filter((g) => g.kind === "error").map((g) => g.key);

/**
 * Tally the classifier's categories over the window for both sides, from the per-game `myCounts` /
 * `opCounts` saved with each record. Returns null when no game in the window carries them (records
 * saved before the tallies existed), so the page can say "not available" instead of showing zeros.
 */
export function decisionProfile(records) {
  const mine = libraryRecords(records);
  const keys = DECISION_GROUPS.map((g) => g.key);
  const blank = () => Object.fromEntries(keys.map((k) => [k, 0]));
  const me = blank(), them = blank();
  let games = 0, moves = 0, errorMoves = 0;
  for (const record of mine) {
    if (!record.myCounts && !record.opCounts) continue;
    games++;
    for (const key of keys) {
      me[key] += asNumber(record.myCounts?.[key]) ?? 0;
      them[key] += asNumber(record.opCounts?.[key]) ?? 0;
    }
  }
  if (!games) return null;
  for (const key of keys) moves += me[key];
  for (const key of ERROR_KEYS) errorMoves += me[key];
  return {
    games, moves,
    me, them,
    errors: ERROR_KEYS.reduce((acc, k) => { acc[k] = me[k]; return acc; }, {}),
    errorMoves,
    // Share of YOUR moves that were an inaccuracy or worse - the one number to watch here.
    errorRate: moves ? Math.round((errorMoves / moves) * 1000) / 10 : null,
    rows: DECISION_GROUPS.map((g) => ({
      ...g,
      me: me[g.key],
      them: them[g.key],
      share: moves ? Math.round((me[g.key] / moves) * 1000) / 10 : null,
    })),
  };
}

/** How many games land in each accuracy band (10 bins of 10 by default), for the histogram. */
export function accuracyHistogram(records, { size = 10 } = {}) {
  const bins = [];
  for (let from = 0; from < 100; from += size) {
    bins.push({ from, to: Math.min(100, from + size), count: 0 });
  }
  for (const point of progressPoints(records)) {
    const value = point.accuracy;
    if (value == null) continue;
    const index = Math.min(bins.length - 1, Math.max(0, Math.floor(value / size)));
    bins[index].count++;
  }
  const total = bins.reduce((sum, b) => sum + b.count, 0);
  return { bins, total, size };
}

/* ---------------- trends ---------------- */

/** Rolling tournament score (win 1, draw ½, loss 0) over a window, one point per game. */
export function scoreTrend(records, window = 10) {
  const points = progressPoints(records);
  const value = (p) => (p.result === "win" ? 1 : p.result === "draw" ? 0.5 : p.result === "loss" ? 0 : null);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1).map(value).filter((v) => v != null);
    out.push({ id: points[i].id, label: points[i].label, value: slice.length ? mean(slice) : null });
  }
  return out;
}

/**
 * Recent form vs the stretch before it: the same length window compared with the one it follows.
 * Nulls when either side lacks data, so the page can show "not enough games" instead of a fake 0.
 */
export function momentum(records, window = 5) {
  const points = progressPoints(records);
  // Every number below is expressed the same way (accuracy and score as percentages, rating in
  // rating points) so a delta is always "recent minus previous" in those units.
  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const scorePct = (ps) => {
    const decided = ps.filter((p) => p.result === "win" || p.result === "draw" || p.result === "loss");
    const value = decided.length ? mean(decided.map((p) => (p.result === "win" ? 1 : p.result === "draw" ? 0.5 : 0))) : null;
    return value == null ? null : value * 100;
  };
  const recent = points.slice(-window);
  const previous = points.slice(-window * 2, -window);
  const d = (a, b) => (a == null || b == null ? null : round1(a - b));
  return {
    window,
    recentGames: recent.length,
    previousGames: previous.length,
    accuracy: { recent: round1(mean(recent.map((p) => p.accuracy))), previous: round1(mean(previous.map((p) => p.accuracy))) },
    rating: { recent: round1(mean(recent.map((p) => p.rating))), previous: round1(mean(previous.map((p) => p.rating))) },
    score: { recent: round1(scorePct(recent)), previous: round1(scorePct(previous)) },
    delta: {
      accuracy: d(mean(recent.map((p) => p.accuracy)), mean(previous.map((p) => p.accuracy))),
      rating: d(mean(recent.map((p) => p.rating)), mean(previous.map((p) => p.rating))),
      score: d(scorePct(recent), scorePct(previous)),
    },
  };
}

/** Spread of the accuracy series: a low sd means repeatable play, a high one means a lottery. */
export function stability(records) {
  const values = progressPoints(records).map((p) => p.accuracy).filter((v) => v != null);
  if (values.length < 2) return { games: values.length, mean: values.length ? values[0] : null, sd: null };
  const avg = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return { games: values.length, mean: Math.round(avg * 10) / 10, sd: Math.round(Math.sqrt(variance) * 10) / 10 };
}

/** The saved move-grade series (0-10 per game), for its own trend line. Missing values stay null. */
export function gradeSeries(records) {
  return sortChronological(records).map((r) => {
    const grade = asNumber(r.myGrade);
    return { id: r.id, label: r.date || "", value: grade == null ? null : Math.round(grade * 10) / 10 };
  });
}

/** Sort opening rows by any column (used by the clickable table headers). */
export function sortRows(rows, key, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const x = a?.[key], y = b?.[key];
    if (typeof x === "number" || typeof y === "number") {
      const nx = x == null ? -Infinity : x, ny = y == null ? -Infinity : y;
      return (nx - ny) * sign;
    }
    return String(x ?? "").localeCompare(String(y ?? "")) * sign;
  });
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
    opponent: r.opName || "",
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
