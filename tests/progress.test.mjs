import { test } from "node:test";
import assert from "node:assert/strict";

import {
  libraryRecords, sortChronological, progressPoints, summarizeProgress,
  openingKey, openingReport, underperformingOpenings, movingAverage, linePath,
  phaseReport, personalBests,
} from "../lib/progress.js";

// Minimal library-record factory; only the fields progress.js reads.
const rec = (over = {}) => ({
  id: over.id || "g" + Math.random().toString(36).slice(2),
  savedAt: 1, myAcc: null, myRating: null, opRating: null,
  result: "", type: "", eco: "", opening: "", brilliantCount: 0, ...over,
});

test("libraryRecords drops non-records", () => {
  const out = libraryRecords([null, undefined, {}, { id: "a" }, 7, "x"]);
  assert.deepEqual(out.map((r) => r.id), ["a"]);
  assert.deepEqual(libraryRecords("nope"), []);
});

test("sortChronological orders oldest to newest", () => {
  const out = sortChronological([rec({ id: "c", savedAt: 30 }), rec({ id: "a", savedAt: 10 }), rec({ id: "b", savedAt: 20 })]);
  assert.deepEqual(out.map((r) => r.id), ["a", "b", "c"]);
});

test("progressPoints normalizes fields and tolerates null accuracy/rating", () => {
  const [p] = progressPoints([rec({ id: "a", savedAt: 5, myAcc: 82.4, myRating: null, result: "win", type: "Blitz", brilliantCount: 2, date: "2026.01.02" })]);
  assert.equal(p.accuracy, 82.4);
  assert.equal(p.rating, null);
  assert.equal(p.result, "win");
  assert.equal(p.brilliants, 2);
});

test("progressPoints maps an unknown result to empty", () => {
  const [p] = progressPoints([rec({ result: "??" })]);
  assert.equal(p.result, "");
});

test("summarizeProgress computes win rate (draws out) and score (draws half)", () => {
  const s = summarizeProgress([
    rec({ id: "1", savedAt: 1, result: "win", myAcc: 90, myRating: 1600 }),
    rec({ id: "2", savedAt: 2, result: "win", myAcc: 80, myRating: 1500 }),
    rec({ id: "3", savedAt: 3, result: "loss", myAcc: 70, myRating: 1400 }),
    rec({ id: "4", savedAt: 4, result: "draw", myAcc: 60, myRating: null }),
  ]);
  assert.equal(s.games, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.draws, 1);
  assert.equal(s.winRate, (200 / 3)); // 2 wins / 3 decided, draws excluded
  assert.equal(s.score, (100 * (2 + 0.5)) / 4);
  assert.equal(s.accuracy, 75);
  assert.equal(s.rating, 1500);      // the null rating is ignored
  assert.equal(s.first, 1);
  assert.equal(s.last, 4);
});

test("summarizeProgress is all-null/zero safe on an empty library", () => {
  const s = summarizeProgress([]);
  assert.deepEqual([s.games, s.wins, s.losses, s.draws, s.brilliants], [0, 0, 0, 0, 0]);
  assert.equal(s.winRate, null);
  assert.equal(s.score, null);
  assert.equal(s.accuracy, null);
  assert.equal(s.rating, null);
});

test("openingKey separates ECO+name and buckets unnamed games", () => {
  assert.deepEqual(openingKey({ eco: "C50", opening: "Italian Game" }), { key: "C50|Italian Game", eco: "C50", name: "Italian Game" });
  assert.equal(openingKey({}).key, "unknown");
  assert.equal(openingKey({ eco: "A00" }).name, "A00");
});

test("openingReport groups, counts and scores by opening", () => {
  const report = openingReport([
    rec({ id: "1", eco: "C50", opening: "Italian Game", result: "win", myAcc: 90, opRating: 1500, savedAt: 1 }),
    rec({ id: "2", eco: "C50", opening: "Italian Game", result: "loss", myAcc: 80, opRating: 1600, savedAt: 2 }),
    rec({ id: "3", eco: "C50", opening: "Italian Game", result: "draw", myAcc: 70, opRating: 1400, savedAt: 3 }),
    rec({ id: "4", eco: "B01", opening: "Scandinavian", result: "loss", myAcc: 60, savedAt: 4 }),
  ]);
  const italian = report.find((g) => g.eco === "C50");
  assert.equal(italian.games, 3);
  assert.equal(italian.wins, 1);
  assert.equal(italian.draws, 1);
  assert.equal(italian.winRate, 50); // 1 win / 2 decided, the draw is excluded
  assert.equal(italian.score, (100 * 1.5) / 3);
  assert.equal(italian.accuracy, 80);
  assert.equal(italian.opponentRating, 1500);
  assert.equal(italian.lastId, "3");
  // Sorted by games desc, so the 3-game opening leads.
  assert.equal(report[0].eco, "C50");
});

test("openingReport honours minGames", () => {
  const records = [
    rec({ id: "1", eco: "C50", opening: "Italian", result: "win" }),
    rec({ id: "2", eco: "B01", opening: "Scandi", result: "win" }),
  ];
  assert.equal(openingReport(records, { minGames: 2 }).length, 0);
  assert.equal(openingReport(records, { minGames: 1 }).length, 2);
});

test("underperformingOpenings needs volume and a weak score", () => {
  const report = [
    { name: "Bad", games: 6, score: 20, winRate: 20 },
    { name: "Okay", games: 6, score: 70, winRate: 70 },
    { name: "Thin", games: 2, score: 0, winRate: 0 },
  ];
  const flagged = underperformingOpenings(report, { minGames: 5, maxScore: 45 });
  assert.deepEqual(flagged.map((g) => g.name), ["Bad"]);
});

test("movingAverage smooths nulls without breaking the series", () => {
  assert.deepEqual(movingAverage([10, 20, 30], 2), [10, 15, 25]);
  assert.deepEqual(movingAverage([null, 10, null], 3), [null, 10, 10]);
});

test("linePath returns an SVG path and skips gaps", () => {
  const path = linePath([0, null, 10], { width: 100, height: 100, pad: 0 });
  assert.ok(path.startsWith("M"));
  assert.equal(path.split("L").length - 1, 1); // two points → one line segment
  assert.equal(linePath([5], {}), "");         // a single point cannot form a line
  assert.equal(linePath([null, null], {}), "");
});

test("phaseReport averages each phase and skips games without phase data", () => {
  const out = phaseReport([
    rec({ id: "1", myPhases: { opening: 90, middlegame: 80, endgame: null } }),
    rec({ id: "2", myPhases: { opening: 70, middlegame: 60, endgame: 50 } }),
    rec({ id: "3" }),                                    // no phase data (an older record)
  ]);
  assert.equal(out.covered, 2);
  const by = Object.fromEntries(out.phases.map((p) => [p.key, p]));
  assert.deepEqual(Object.keys(by), ["opening", "middlegame", "endgame"]);
  assert.equal(by.opening.accuracy, 80);
  assert.equal(by.opening.games, 2);
  assert.equal(by.endgame.accuracy, 50);
  assert.equal(by.endgame.games, 1);
});

test("phaseReport only flags a worst phase once the evidence is thick enough", () => {
  const thin = phaseReport([rec({ id: "1", myPhases: { opening: 40, middlegame: 80 } })]);
  assert.equal(thin.covered, 1);
  assert.equal(thin.worst, null);                        // fewer than 3 games per phase
  const thick = phaseReport([1, 2, 3, 4].map((n) =>
    rec({ id: String(n), myPhases: { opening: 85, middlegame: 60, endgame: 70 } })));
  assert.equal(thick.worst, "middlegame");
  assert.equal(thick.phases.find((p) => p.key === "middlegame").games, 4);
});

test("phaseReport tolerates junk phase values", () => {
  const out = phaseReport([
    rec({ id: "1", myPhases: { opening: "nope", middlegame: 80 } }),   // junk phase ignored
    rec({ id: "2", myPhases: 5 }),                                     // not an object -> skipped
    rec({ id: "3", myPhases: { opening: 90 } }),
  ]);
  assert.equal(out.covered, 2);
  assert.equal(out.phases.find((p) => p.key === "opening").accuracy, 90);
  assert.equal(out.phases.find((p) => p.key === "opening").games, 1);
  assert.equal(out.phases.find((p) => p.key === "middlegame").accuracy, 80);
});

test("personalBests finds standout games and runs", () => {
  const records = [
    rec({ id: "1", savedAt: 1, result: "win", myAcc: 70, brilliantCount: 1, opRating: 1400, plies: 60, date: "2026.01.01", opName: "A" }),
    rec({ id: "2", savedAt: 2, result: "win", myAcc: 92.4, brilliantCount: 0, opRating: 1700, plies: 40, date: "2026.01.02", opName: "B" }),
    rec({ id: "3", savedAt: 3, result: "loss", myAcc: 88, brilliantCount: 3, opRating: 1500, plies: 80, date: "2026.01.03", opName: "C" }),
    rec({ id: "4", savedAt: 4, result: "win", myAcc: 80, brilliantCount: 0, opRating: 1600, plies: 24, date: "2026.01.04", opName: "D" }),
  ];
  const best = Object.fromEntries(personalBests(records).map((b) => [b.key, b]));
  assert.equal(best.accuracy.id, "2");
  assert.equal(best.accuracy.text, "92.4");
  assert.equal(best.accuracy.hint, "2026.01.02 · vs B");
  assert.equal(best.winStreak.value, 2);                 // the two opening wins
  assert.equal(best.winStreak.text, "2 games");
  assert.equal(best.unbeaten.value, 2);
  assert.equal(best.brilliants.id, "3");
  assert.equal(best.brilliants.text, "3");
  assert.equal(best.topWin.id, "2");
  assert.equal(best.topWin.text, "1700");
  assert.equal(best.fastestWin.id, "4");
  assert.equal(best.fastestWin.text, "12 moves");
});

test("personalBests leaves a category empty until a game qualifies for it", () => {
  const best = Object.fromEntries(personalBests([rec({ id: "1", result: "loss" })]).map((b) => [b.key, b]));
  for (const key of ["accuracy", "winStreak", "unbeaten", "brilliants", "topWin", "fastestWin"]) {
    assert.equal(best[key].text, null, `${key} should be empty`);
    assert.equal(best[key].id, null);
  }
  assert.deepEqual(personalBests([]).map((b) => b.text), [null, null, null, null, null, null]);
});
