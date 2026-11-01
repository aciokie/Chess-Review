// lib/progress.js — pure aggregation behind the Progress page (accuracy/rating trend + opening
// report). Everything here reads only the records the analyzer already saves to
// browserAPI.storage.local["library"]; it never touches storage, the engine or the network, so the
// helpers run directly in Node (see tests/progress.test.mjs).
//
// A library record (see saveToLibrary in analysis.js) is shaped like:
//   { id, savedAt, pgn, meta, meSide, myName, opName, myAcc, opAcc, myRating, opRating,
//     myEstimate, opEstimate, result, type, eco, opening, date, url, hasBrilliant, brilliantCount,
//     myBrilliant, fav, solved, plies, myPhases, myCounts, opCounts, myGrade, opGrade }
// Only complete analyses are ever saved, so every record is a finished game. `result` is
// "win" | "loss" | "draw" | "" and all accuracy/rating fields may be null.
// `myRating` is the platform Elo from the PGN; `myEstimate` is the rating the review itself estimated
// (the "≈ N elo" on the board) and is absent on older records. `date` is the PGN date of the GAME, so
// it is what the page orders by - `savedAt` only says when the game was analyzed.
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

// Sample standard deviation (n-1): the same measure the Consistency card reports.
const sdOf = (values) => {
  const clean = values.filter((v) => v != null);
  if (clean.length < 2) return null;
  const avg = mean(clean);
  return Math.sqrt(clean.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (clean.length - 1));
};

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// "YYYY-MM-DD" in the reader's timezone (the page formats dates locally).
const localDayKey = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Drop anything that isn't a game record (guards against a corrupted storage entry). */
export function libraryRecords(records) {
  return (Array.isArray(records) ? records : []).filter((r) => r && typeof r === "object" && r.id);
}

const normName = (value) => String(value == null ? "" : value).trim().toLowerCase();

/**
 * The day the game was PLAYED, from the PGN date header ("2026.01.02"), or null when it is missing or
 * unknown ("????.??.??"). Progress reports on games played, so ordering and the "last N" range use
 * this instead of `savedAt`: otherwise re-analyzing an old game would move it to the newest end of
 * every trend and into "recent form".
 */
export function playedAt(record) {
  const raw = String(record?.date || "").trim();
  const m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(raw);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Local midnight, because the page formats this into the reader's timezone: a UTC midnight would
  // print as the previous day anywhere west of Greenwich.
  const ms = new Date(year, month - 1, day).getTime();
  if (!Number.isFinite(ms)) return null;
  // A date the calendar does not have (2026.02.31) would silently roll into March. The PGN is simply
  // undated then - it must not be moved to a day it was not played on.
  const at = new Date(ms);
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day ? ms : null;
}

// Ordering key: the day played, else the save time for records whose PGN carries no date.
export const orderTime = (record) => playedAt(record) ?? asNumber(record?.savedAt) ?? 0;

/** The game's calendar day ("YYYY-MM-DD"), or null when the PGN has no usable date. */
export const dayKey = (record) => {
  const at = playedAt(record);
  return at == null ? null : localDayKey(at);
};

/**
 * YOUR brilliants in a game. `brilliantCount` covers both players, so it is never used here: the
 * per-side tally is authoritative, and the older `myBrilliant` flag ("did you have one") is the
 * fallback. A record from before either field claims nothing rather than the opponent's brilliants.
 */
export const myBrilliantCount = (record) => {
  const tally = asNumber(record?.myCounts?.brilliant);
  if (tally != null) return tally;
  return record?.myBrilliant === true ? 1 : 0;
};

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
      myEstimate: record.opEstimate,
      opEstimate: record.myEstimate,
      myPhases: null,
      // Per-side tallies and grades exist for BOTH seats, so they can be re-pointed at the tracked
      // account. The old whole-game brilliant count cannot be split, so it is not claimed for them.
      myCounts: record.opCounts,
      opCounts: record.myCounts,
      myGrade: record.opGrade,
      opGrade: record.myGrade,
      myBrilliant: null,
      // The worst decision is stored per side, so it follows the account like the tallies do.
      myWorst: record.opWorst ?? null,
      opWorst: record.myWorst ?? null,
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
 * `type` a time class, `result` "win" | "loss" | "draw", `day` a "YYYY-MM-DD" played date,
 * `opponent` a normalized name (see opponentKey) and `opening` an openingKey.
 */
export function filterGames(records, { colour = "", type = "", result = "", day = "", opponent = "", opening = "" } = {}) {
  return libraryRecords(records).filter((r) =>
    (!colour || (r.meSide === "b" ? "b" : "w") === colour)
    // Same bucket key typeSplit produces, so the "Unrated" chip matches games whose type is blank
    // instead of filtering them all out.
    && (!type || (r.type || "Unrated") === type)
    && (!result || r.result === result)
    && (!day || dayKey(r) === day)
    && (!opponent || opponentKey(r) === opponent)
    && (!opening || openingKey(r).key === opening));
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

/* ---------------- opponents ---------------- */

// Names that are not a real opponent: the Live board writes its own seats as "White"/"Black", so a
// placeholder must never become the biggest "rival" in the report.
const PLACEHOLDER_NAMES = new Set(["white", "black", "?", "unknown", "player", "you", "opponent"]);

/** Normalized identity of the other player, or "" when the record does not name a real one. */
export const opponentKey = (record) => {
  const key = normName(record?.opName);
  return PLACEHOLDER_NAMES.has(key) ? "" : key;
};

/**
 * Head to head: one row per opponent, most played first, then whoever you score worst against. Records
 * with no usable name are counted in `unnamed` instead of being merged into one fake rival. `key` is
 * what the opponent filter matches, so a row can scope the page to that rival.
 */
export function opponentReport(records, { minGames = 1 } = {}) {
  const groups = new Map();
  let unnamed = 0;
  for (const record of libraryRecords(records)) {
    const key = opponentKey(record);
    if (!key) { unnamed++; continue; }
    if (!groups.has(key)) {
      groups.set(key, {
        key, name: String(record.opName).trim(), games: 0, wins: 0, draws: 0, losses: 0,
        accuracies: [], ratings: [], lastId: null, lastAt: -Infinity, lastSaved: -Infinity,
      });
    }
    const g = groups.get(key);
    g.games++;
    if (record.result === "win") g.wins++;
    else if (record.result === "loss") g.losses++;
    else if (record.result === "draw") g.draws++;
    const acc = asNumber(record.myAcc);
    if (acc != null) g.accuracies.push(acc);
    const rating = asNumber(record.opRating);
    if (rating != null) g.ratings.push(rating);
    const at = orderTime(record);
    const saved = asNumber(record.savedAt) ?? 0;
    // Keep the most recent spelling of the name, and the game to reopen from this row. Same-day games
    // break the tie on save order, so "most recent" does not depend on the order of the input.
    if (at > g.lastAt || (at === g.lastAt && saved >= g.lastSaved)) {
      g.lastAt = at; g.lastSaved = saved; g.lastId = record.id; g.name = String(record.opName).trim();
    }
  }
  const rows = [...groups.values()].map((g) => {
    const decided = g.wins + g.draws + g.losses;
    return {
      key: g.key, name: g.name, label: g.name, games: g.games,
      wins: g.wins, draws: g.draws, losses: g.losses,
      score: decided ? Math.round(((g.wins + g.draws / 2) / decided) * 1000) / 10 : null,
      accuracy: mean(g.accuracies),
      opponentRating: mean(g.ratings),
      lastId: g.lastId,
    };
  })
    .filter((g) => g.games >= minGames)
    .sort((a, b) => b.games - a.games || (a.score ?? 100) - (b.score ?? 100) || a.name.localeCompare(b.name));
  return { rows, unnamed, games: rows.reduce((n, g) => n + g.games, 0) };
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

/* ---------------- evidence behind a headline number ---------------- */
// Per-metric recipes for the drill-down panel: how one game contributes and how the games combine,
// so the page can show the arithmetic instead of only the result.
const myMoves = (r) => DECISION_GROUPS.reduce((n, g) => n + (asNumber(r.myCounts?.[g.key]) ?? 0), 0);
const myErrors = (r) => ERROR_KEYS.reduce((n, k) => n + (asNumber(r.myCounts?.[k]) ?? 0), 0);
const pct = (v) => `${Math.round(v * 10) / 10}%`;

const EVIDENCE = {
  // `ctx` carries the window's single rating scale, so this column never mixes the two scales either.
  games: {
    label: "Games",
    rule: "Every game in this window. Click one to reopen its review.",
    value: () => 1, text: (_, r) => r.result || "—", order: "none",
  },
  // Score and win rate are expressed as percentages here so the panel's mean is the number on the
  // card (50 means 50%, not 0.5).
  score: {
    label: "Score",
    rule: "Tournament score: a win is 1, a draw ½, a loss 0, averaged over the games that have a result.",
    value: (r) => (r.result === "win" ? 100 : r.result === "draw" ? 50 : r.result === "loss" ? 0 : null),
    text: (v) => (v === 100 ? "win" : v === 50 ? "draw" : "loss"), order: "none",
  },
  winRate: {
    label: "Win rate",
    rule: "Wins ÷ (wins + losses). Draws are deliberately left out, which is why this differs from score.",
    value: (r) => (r.result === "win" ? 100 : r.result === "loss" ? 0 : null),
    text: (v) => (v === 100 ? "win" : "loss"), order: "none",
  },
  accuracy: {
    label: "Avg accuracy",
    rule: "The mean of each game's accuracy as this review scored it. A game without a score is skipped, not counted as zero.",
    value: (r) => asNumber(r.myAcc), format: round1, order: "desc",
  },
  rating: {
    label: "Avg rating",
    rule: "One scale for the whole window: the review's own estimate (the board's \"≈ N elo\") when it covers at least as many games as the recorded Elo, else the Elo from the game record. The two are never averaged together.",
    value: (r, ctx) => (ctx?.scale === "elo" ? asNumber(r.myRating) : asNumber(r.myEstimate)),
    format: (v) => String(Math.round(v)), order: "desc",
  },
  errorRate: {
    label: "Error rate",
    rule: "Your inaccuracies + mistakes + misses + blunders ÷ all of your classified moves, pooled over the window — not an average of per-game rates.",
    value: (r) => { const moves = myMoves(r); return moves ? (100 * myErrors(r)) / moves : null; },
    totals: (r) => ({ num: myErrors(r), den: myMoves(r) }),
    format: pct, order: "desc",   // the worst games are the ones worth opening
  },
  consistency: {
    label: "Consistency",
    rule: "One sample standard deviation of the per-game accuracy — the spread, not the average. Lower is steadier.",
    value: (r) => asNumber(r.myAcc), format: (v) => v.toFixed(1), order: "desc", spread: true,
  },
  grade: {
    label: "Avg grade",
    rule: "The mean of the review's 0–10 per-move grade for each game.",
    value: (r) => asNumber(r.myGrade), format: (v) => v.toFixed(1), order: "desc",
  },
  brilliants: {
    label: "Brilliants",
    rule: "Your brilliants only: the per-side tally saved with each game, never the opponent's.",
    value: (r) => myBrilliantCount(r), format: (v) => String(v), order: "desc", sum: true,
  },
};

/**
 * The games behind one headline number: each game's contribution, the rule that combines them, and
 * the statistics to show beside it. Rows are ordered most-relevant-first and capped at `limit`; each
 * carries the game id and the ply of that game's worst decision, so a row can reopen the game or jump
 * straight to the move. Null for an unknown metric.
 */
export function metricEvidence(records, key, { limit = 12 } = {}) {
  const def = EVIDENCE[key];
  if (!def) return null;
  const rows = [];
  const ctx = { scale: ratingScale(records) };
  let num = 0, den = 0;
  for (const rec of sortChronological(records)) {
    const value = def.value(rec, ctx);
    if (value == null) continue;
    if (def.totals) { const t = def.totals(rec); num += t.num; den += t.den; }
    rows.push({
      id: rec.id,
      label: [rec.date, rec.opName ? `vs ${rec.opName}` : ""].filter(Boolean).join(" · "),
      opponent: rec.opName || "",
      result: RESULTS.has(rec.result) ? rec.result : "",
      value,
      text: def.format ? String(def.format(value)) : (def.text ? def.text(value, rec) : String(value)),
      ply: asNumber(rec.myWorst?.ply),
      category: rec.myWorst?.cat || "",
    });
  }
  const values = rows.map((r) => r.value);
  // "none" means the metric has no meaningful per-game size: keep newest first so the list reads
  // like a list of games, not a ranking.
  const ordered = def.order === "none"
    ? [...rows].reverse()
    : [...rows].sort((a, b) => (def.order === "asc" ? a.value - b.value : b.value - a.value));
  const shown = Math.min(Math.max(1, Math.floor(limit)), ordered.length);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const show = (v) => (v == null ? null : def.format ? String(def.format(v)) : String(v));
  return {
    key, label: def.label, rule: def.rule, order: def.order, spread: !!def.spread,
    games: rows.length,
    mean: round1(mean(values)),
    sd: round1(sdOf(values)),
    min, max,
    minText: show(min), maxText: show(max),
    total: def.sum ? values.reduce((sum, v) => sum + v, 0) : null,
    pooled: def.totals ? { num, den, value: den ? (100 * num) / den : null } : null,
    rows: ordered.slice(0, shown),
    shown,
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
  const sd = sdOf(values);
  return { games: values.length, mean: values.length ? round1(mean(values)) : null, sd: round1(sd) };
}

/** The saved move-grade series (0-10 per game), for its own trend line. Missing values stay null. */
export function gradeSeries(records) {
  return sortChronological(records).map((r) => {
    const grade = asNumber(r.myGrade);
    return { id: r.id, label: r.date || "", value: grade == null ? null : Math.round(grade * 10) / 10 };
  });
}

/**
 * Sort rows by any column (used by the clickable table headers). A row with no value for the column
 * always sorts last, in both directions: "accuracy ascending" must start with the worst real score,
 * not with the games that have no score at all.
 */
export function sortRows(rows, key, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const x = a?.[key], y = b?.[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const nx = typeof x === "number" ? x : Number(x);
    const ny = typeof y === "number" ? y : Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) return (nx - ny) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

/**
 * Oldest → newest by the day each game was played, so a chart reads left to right and "last N" means
 * the last N games you played. Same-day games fall back to save order, and games with no PGN date to
 * their save time.
 */
export function sortChronological(records) {
  return [...libraryRecords(records)].sort((a, b) =>
    (orderTime(a) - orderTime(b)) || ((asNumber(a.savedAt) ?? 0) - (asNumber(b.savedAt) ?? 0)));
}

/**
 * Which rating scale this set of games can be reported on, decided ONCE so an average, a trend or a
 * delta never mixes two different measurements. The review's own estimate wins when it covers at least
 * as many games as the recorded platform Elo; the platform Elo wins when it covers more. Null when the
 * games carry neither.
 */
export function ratingScale(records) {
  const list = libraryRecords(records);
  let estimated = 0, recorded = 0;
  for (const r of list) {
    if (asNumber(r.myEstimate) != null) estimated++;
    if (asNumber(r.myRating) != null) recorded++;
  }
  if (!estimated && !recorded) return null;
  return estimated >= recorded ? "estimate" : "elo";
}

/**
 * One point per game for the accuracy / rating / brilliants series. `rating` comes from ONE scale for
 * the whole series (see ratingScale) - an estimate is never averaged with a platform Elo, so a library
 * half-reviewed before estimates existed reads as a flat line rather than a jump. `at` is the ordering
 * time (day played), which is what the date range on the summary card describes.
 */
export function progressPoints(records, { scale = null } = {}) {
  const chosen = scale ?? ratingScale(records);
  return sortChronological(records).map((r) => ({
    id: r.id,
    label: r.date || "",
    savedAt: asNumber(r.savedAt),
    at: orderTime(r),
    result: RESULTS.has(r.result) ? r.result : "",
    type: r.type || "",
    opponent: r.opName || "",
    accuracy: asNumber(r.myAcc),
    rating: chosen === "elo" ? asNumber(r.myRating) : asNumber(r.myEstimate),
    ratingScale: chosen,
    ratingEstimated: chosen === "estimate",
    brilliants: myBrilliantCount(r),
  }));
}

/** Headline numbers for the dashboard cards. */
export function summarizeProgress(records) {
  const list = libraryRecords(records);
  const scale = ratingScale(list);
  const points = progressPoints(list, { scale });
  const accuracies = [];
  const ratings = [];
  let wins = 0, losses = 0, draws = 0, other = 0, brilliants = 0, missingRating = 0;
  for (const p of points) {
    if (p.result === "win") wins++;
    else if (p.result === "loss") losses++;
    else if (p.result === "draw") draws++;
    else other++;
    if (p.accuracy != null) accuracies.push(p.accuracy);
    if (p.rating != null) ratings.push(p.rating);
    else if (scale) missingRating++;
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
    // The single scale the rating number is built from, how many games carry it, and how many games in
    // the window have no rating on that scale at all (they are left out, never counted as zero).
    ratingScale: scale, ratedGames: ratings.length, missingRating,
    // The window is described by when the games were PLAYED, not when they were analyzed.
    first: points[0]?.at ?? null,
    last: points.at(-1)?.at ?? null,
  };
}

/* ---------------- daily tracker ---------------- */

/**
 * One row per calendar day over the trailing window (oldest → newest, ending today), so the page can
 * draw a contribution strip and scope itself to a single day. `at` is that day's local midnight, and
 * `key` is what the day filter matches. Games whose PGN carries no date cannot be placed on a day and
 * are counted in `undated` instead of being silently dropped.
 */
export function dailyActivity(records, { days = 84, now = Date.now() } = {}) {
  const span = Math.max(1, Math.floor(days));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const cells = [];
  const byKey = new Map();
  for (let back = span - 1; back >= 0; back--) {
    const d = new Date(today);
    d.setDate(d.getDate() - back);   // date arithmetic, not ms subtraction: DST days are not 24h
    const cell = { key: localDayKey(d.getTime()), at: d.getTime(), games: 0, wins: 0, draws: 0, losses: 0,
      accuracies: [], ratings: [] };
    cells.push(cell);
    byKey.set(cell.key, cell);
  }
  let undated = 0, outside = 0;
  // The same single rating scale the cards use, so a day's rating never mixes the two measurements.
  const scale = ratingScale(records);
  for (const rec of libraryRecords(records)) {
    const at = playedAt(rec);
    if (at == null) { undated++; continue; }
    const cell = byKey.get(localDayKey(at));
    if (!cell) { outside++; continue; }
    cell.games++;
    if (rec.result === "win") cell.wins++;
    else if (rec.result === "loss") cell.losses++;
    else if (rec.result === "draw") cell.draws++;
    const acc = asNumber(rec.myAcc);
    if (acc != null) cell.accuracies.push(acc);
    const rating = scale === "elo" ? asNumber(rec.myRating) : asNumber(rec.myEstimate);
    if (rating != null) cell.ratings.push(rating);
  }
  for (const cell of cells) {
    cell.accuracy = round1(mean(cell.accuracies));
    const rating = mean(cell.ratings);
    cell.rating = rating == null ? null : Math.round(rating);
    delete cell.accuracies;
    delete cell.ratings;
  }
  // Current streak: a run that includes today, or one that ended yesterday - you have not had a chance
  // to play today yet. A run that stopped earlier is history, not a current streak.
  let end = cells.length - 1;
  if (end >= 0 && !cells[end].games && end - 1 >= 0 && cells[end - 1].games) end--;
  let streak = 0;
  for (let i = end; i >= 0 && cells[i].games > 0; i--) streak++;
  let best = 0, bestEnd = null, run = 0;
  for (const cell of cells) {
    if (!cell.games) { run = 0; continue; }
    run++;
    if (run > best) { best = run; bestEnd = cell.key; }
  }
  return {
    cells,
    days: span,
    games: cells.reduce((n, c) => n + c.games, 0),
    undated, outside,
    activeDays: cells.filter((c) => c.games > 0).length,
    max: cells.reduce((n, c) => Math.max(n, c.games), 0),
    streak, best, bestEnd,
    first: cells[0].at,
    last: cells.at(-1).at,
    today: cells.at(-1).key,
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
    const at = orderTime(r);
    if (!g.last || at > g.last.at) g.last = { id: r.id, at };
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

/**
 * Openings played often enough but scored poorly — the "you keep losing this" list. The "unknown"
 * bucket is games whose opening was never recorded: that is a gap in the data, not an opening you can
 * work on, so it is never advised.
 */
export function underperformingOpenings(report, { minGames = 5, maxScore = 45 } = {}) {
  return report
    .filter((g) => g.key !== "unknown" && g.games >= minGames && g.score != null && g.score <= maxScore)
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
export function personalBests(records, { streakSource = null } = {}) {
  const ordered = sortChronological(records);   // oldest -> newest, so streaks read forward
  // A streak is a property of the sequence, so a filter that removes games (Result = Wins, one colour,
  // one time class) must not manufacture one: runs are counted over `streakSource` (every tracked game)
  // while the single-game bests still describe the window.
  const streakOrder = streakSource == null ? ordered : sortChronological(streakSource);
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
  const brilliants = pick((r) => myBrilliantCount(r) || null, (v, b) => v > b);
  const topWin = pick((r) => (r.result === "win" ? asNumber(r.opRating) : null), (v, b) => v > b);
  const fastestWin = pick((r) => (r.result === "win" && asNumber(r.plies) ? asNumber(r.plies) : null), (v, b) => v < b);

  let win = 0, unbeaten = 0, bestWin = 0, bestUnbeaten = 0, winEnd = null, unbeatenEnd = null;
  for (const rec of streakOrder) {
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
    // `plies` are half-moves; a win is counted in full moves (a 24-ply mate is a 12-move win).
    entry("fastestWin", "Fastest win", fastestWin, (v) => {
      const moves = Math.ceil(v / 2);
      return `${moves} ${moves === 1 ? "move" : "moves"}`;
    }),
  ];
}

/* ---------------- one row per game ---------------- */

/**
 * The window as a sortable table, one row per game: the identity of the game plus every number the
 * page shows, so the master list is just another view of the same records. `ply` is that game's worst
 * decision (null when it was clean or saved before the ply was recorded), which is what a "move N"
 * button jumps to.
 */
export function gameRows(records) {
  return sortChronological(records).map((r) => {
    const moves = myMoves(r);
    const errors = moves ? myErrors(r) : null;
    const plies = asNumber(r.plies);
    return {
      id: r.id,
      date: r.date || "",
      at: orderTime(r),
      opponent: r.opName || "",
      colour: r.meSide === "b" ? "b" : "w",
      colourLabel: r.meSide === "b" ? "Black" : "White",
      result: RESULTS.has(r.result) ? r.result : "",
      accuracy: asNumber(r.myAcc),
      grade: asNumber(r.myGrade),
      errors,
      errorRate: errors == null ? null : (100 * errors) / moves,
      plies,
      moves: plies ? Math.ceil(plies / 2) : null,
      opening: r.opening || r.eco || "",
      type: r.type || "",
      ply: asNumber(r.myWorst?.ply),
      category: r.myWorst?.cat || "",
    };
  });
}

/* ---------------- what to work on ---------------- */

export const PHASE_LABELS = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };
const phaseName = (key) => PHASE_LABELS[key] || key;
const PLURAL_ERROR = { inacc: "inaccuracies", mistake: "mistakes", miss: "misses", blunder: "blunders" };
// How much one of each error type costs, in "inaccuracy units" - used to rank the advice by cost, not
// by raw frequency.
const ERROR_COST = { inacc: 1, mistake: 2, miss: 2.5, blunder: 3 };
const one = (v) => (v == null ? "–" : String(Math.round(v * 10) / 10));

/**
 * The few concrete things worth working on in this window, ranked. Each entry is
 * { key, kind, title, detail, weight, target }; `target` says where the finding lives:
 *   { kind: "game", id, ply }                       open that review (at the move, when known)
 *   { kind: "colour", value, label }                scope the page to White/Black
 *   { kind: "opponent" | "opening", value, label }  scope the page to that rival / opening
 * `weight` is only meant to be compared loosely - it is "how far below a healthy number" measured in
 * that metric's own units (accuracy points, share of moves, score points). Returns [] when nothing
 * clears its threshold, so the page can say what it checked instead of inventing advice.
 */
export function focusAreas(records) {
  const mine = libraryRecords(records);
  const areas = [];
  // The record with the most extreme value, keeping the first found on a tie.
  const pick = (list, value, better) => list.reduce((acc, record) => {
    const v = value(record);
    if (v == null) return acc;
    return !acc || better(v, acc.value) ? { record, value: v } : acc;
  }, null);

  // 1. The weakest phase - only when it is clearly behind the other one, so a one-off is not advice.
  const phases = phaseReport(mine).phases.filter((p) => p.games >= 3 && p.accuracy != null);
  if (phases.length >= 2) {
    const worst = phases.reduce((a, b) => (b.accuracy < a.accuracy ? b : a));
    const best = phases.filter((p) => p !== worst).reduce((a, b) => (b.accuracy > a.accuracy ? b : a));
    const gap = best.accuracy - worst.accuracy;
    if (gap >= 4) {
      const game = pick(mine.filter((r) => asNumber(r.myPhases?.[worst.key]) != null),
        (r) => asNumber(r.myPhases[worst.key]), (a, b) => a < b);
      areas.push({
        key: "phase", kind: "phase", weight: gap,
        title: `Your ${phaseName(worst.key).toLowerCase()} is the weak link`,
        detail: `${one(worst.accuracy)} average accuracy in the ${phaseName(worst.key).toLowerCase()} over ${worst.games} games`
          + ` - ${one(gap)} below your ${phaseName(best.key).toLowerCase()} (${one(best.accuracy)}).`,
        // The game to open, but no ply: that game's worst move can be in any phase, and pointing at an
        // opening blunder as evidence about the endgame would be a lie.
        target: game ? { kind: "game", id: game.record.id } : null,
      });
    }
  }

  // 2. The error type that eats the biggest share of your moves.
  const profile = decisionProfile(mine);
  if (profile) {
    const errors = profile.rows.filter((r) => r.kind === "error" && r.share != null && r.me > 0);
    if (errors.length) {
      // Weighted by what each type costs, not just how often it happens: 8% inaccuracies is not a bigger
      // problem than 3% blunders. One blunder counts as three inaccuracies, a miss as two and a half.
      const cost = (row) => row.share * (ERROR_COST[row.key] || 1);
      const top = errors.reduce((a, b) => (cost(b) > cost(a) ? b : a));
      const game = pick(mine.filter((r) => (asNumber(r.myCounts?.[top.key]) ?? 0) > 0),
        (r) => asNumber(r.myCounts[top.key]), (a, b) => a > b);
      areas.push({
        key: "decision", kind: "decision", weight: cost(top),
        title: `${PLURAL_ERROR[top.key] || `${top.label}s`} cost you most`,
        detail: `${top.share}% of your moves (${top.me} of ${profile.moves}, ${round1(top.me / Math.max(1, profile.games))} per game)`
          + " - the costliest kind, counting a blunder as three inaccuracies.",
        // Land on a move only when that game's decisive move is this same error type; otherwise open the
        // game rather than presenting an unrelated blunder as an example of it.
        target: game ? {
          kind: "game", id: game.record.id,
          ply: game.record.myWorst?.cat === top.key ? asNumber(game.record.myWorst?.ply) : null,
        } : null,
      });
    }
  }

  // 3. A colour that is clearly behind the other.
  const colours = colourSplit(mine);
  if (colours.every((c) => c.games >= 3 && c.score != null)) {
    const strong = colours.reduce((a, b) => (b.score > a.score ? b : a));
    const weak = colours.find((c) => c !== strong);
    const gap = strong.score - weak.score;
    if (gap >= 8) {
      areas.push({
        key: "colour", kind: "colour", weight: gap,
        title: `${weak.label} is your weaker side`,
        detail: `${one(weak.score)}% score as ${weak.label} over ${weak.games} games, against ${one(strong.score)}% as ${strong.label}.`,
        target: { kind: "colour", value: weak.key, label: weak.label },
      });
    }
  }

  // 4. An opening that is played often enough to matter and scored badly.
  const openings = underperformingOpenings(openingReport(mine), { minGames: 5 });
  if (openings.length) {
    const g = openings[0];
    areas.push({
      key: "opening", kind: "opening", weight: Math.max(1, 45 - g.score),
      title: `${g.name} is not working`,
      detail: `${one(g.score)}% from ${g.games} games in this opening.`,
      target: { kind: "opening", value: g.key, label: g.name },
    });
  }

  // 5. An opponent you keep losing to.
  const rivals = opponentReport(mine).rows.filter((r) => r.games >= 3 && r.score != null);
  if (rivals.length) {
    const nemesis = rivals.reduce((a, b) => (b.score < a.score ? b : a));
    if (nemesis.score <= 40) {
      areas.push({
        key: "nemesis", kind: "nemesis", weight: Math.max(1, 40 - nemesis.score),
        title: `${nemesis.name} has your number`,
        detail: `${nemesis.wins}-${nemesis.draws}-${nemesis.losses} in ${nemesis.games} games (${one(nemesis.score)}% score).`,
        target: { kind: "opponent", value: nemesis.key, label: nemesis.name },
      });
    }
  }

  return areas.sort((a, b) => b.weight - a.weight);
}
