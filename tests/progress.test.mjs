import { test } from "node:test";
import assert from "node:assert/strict";

import {
  libraryRecords, sortChronological, progressPoints, summarizeProgress,
  openingKey, openingReport, underperformingOpenings, movingAverage, linePath,
  phaseReport, personalBests, playerSide, ownGames,
  sliceRange, filterGames, colourSplit, typeSplit, decisionProfile, accuracyHistogram,
  scoreTrend, momentum, stability, gradeSeries, sortRows, ERROR_KEYS,
  playedAt, orderTime, myBrilliantCount, dayKey, dailyActivity, metricEvidence,
  opponentReport, opponentKey, focusAreas, gameRows, ratingScale, libraryFlip,
} from "../lib/progress.js";

// Minimal library-record factory; only the fields progress.js reads.
const rec = (over = {}) => ({
  id: over.id || "g" + Math.random().toString(36).slice(2),
  savedAt: 1, myAcc: null, myRating: null, opRating: null,
  result: "", type: "", eco: "", opening: "", brilliantCount: 0, ...over,
});

test("libraryRecords drops non-records", () => {
  const out = libraryRecords([null, undefined, {}, { id: "a" }, { id: 7 }, { id: "" }, 7, "x"]);
  assert.deepEqual(out.map((r) => r.id), ["a"]);
  assert.deepEqual(libraryRecords("nope"), []);
  // The analyzer and this page's storage read both require a string id; a record this helper accepted
  // with a numeric one was counted here and dropped there.
  assert.deepEqual(libraryRecords([{ id: 7 }]), []);
});

test("sortChronological orders oldest to newest", () => {
  const out = sortChronological([rec({ id: "c", savedAt: 30 }), rec({ id: "a", savedAt: 10 }), rec({ id: "b", savedAt: 20 })]);
  assert.deepEqual(out.map((r) => r.id), ["a", "b", "c"]);
});

test("progressPoints normalizes fields and tolerates null accuracy/rating", () => {
  const [p] = progressPoints([rec({ id: "a", savedAt: 5, myAcc: 82.4, myRating: null, result: "win", type: "Blitz", myCounts: { brilliant: 2 }, date: "2026.01.02" })]);
  assert.equal(p.accuracy, 82.4);
  assert.equal(p.rating, null);
  assert.equal(p.result, "win");
  assert.equal(p.brilliants, 2);
  assert.equal(p.at, new Date(2026, 0, 2).getTime(), "a point is dated by the day it was played");
});

test("progressPoints keeps the rating line on ONE scale", () => {
  const [old, fresh] = progressPoints([
    rec({ id: "old", savedAt: 1, date: "2026.01.01", myRating: 1400 }),
    rec({ id: "new", savedAt: 2, date: "2026.01.02", myRating: 1500, myEstimate: 1750 }),
  ], { scale: "estimate" });
  assert.equal(old.rating, null, "no estimate: left out, never replaced by a different measurement");
  assert.equal(fresh.rating, 1750, "the review's own estimate");
  assert.equal(fresh.ratingScale, "estimate");
});

test("ratingScale picks the scale that covers the window, and never mixes the two", () => {
  assert.equal(ratingScale([]), null);
  const eloOnly = [rec({ id: "a", myRating: 1400 }), rec({ id: "b", myRating: 1500 })];
  assert.equal(ratingScale(eloOnly), "elo");
  const allNew = [rec({ id: "a", myRating: 1400, myEstimate: 1700 }), rec({ id: "b", myRating: 1500, myEstimate: 1750 })];
  assert.equal(ratingScale(allNew), "estimate", "a tie goes to the review's own number");
  const mixed = [rec({ id: "a", myRating: 1400 }), rec({ id: "b", myRating: 1500 }), rec({ id: "c", myEstimate: 1900 })];
  assert.equal(ratingScale(mixed), "elo", "two recorded Elos beat one estimate");
  assert.deepEqual(progressPoints(mixed).map((p) => p.rating), [1400, 1500, null],
    "an old Elo and a new estimate are never averaged together");
  const s = summarizeProgress(mixed);
  assert.equal(s.ratingScale, "elo");
  assert.equal(s.ratedGames, 2);
  assert.equal(s.missingRating, 1, "the game with no value on this scale is counted, not zeroed");
  assert.equal(s.rating, 1450);
});

/* ---------------- ordering: games played, not games analyzed ---------------- */

test("playedAt reads the PGN date and ignores unknown ones", () => {
  assert.equal(playedAt({ date: "2026.01.02" }), new Date(2026, 0, 2).getTime());
  assert.equal(playedAt({ date: "2026-1-2" }), new Date(2026, 0, 2).getTime());
  assert.equal(playedAt({ date: "????.??.??" }), null);
  assert.equal(playedAt({ date: "" }), null);
  assert.equal(playedAt({}), null);
  assert.equal(playedAt(null), null);
  assert.equal(playedAt({ date: "2026.13.40" }), null, "an impossible date is not a date");
  assert.equal(orderTime({ date: "2026.01.02", savedAt: 9 }), new Date(2026, 0, 2).getTime());
  assert.equal(orderTime({ savedAt: 9 }), 9, "an undated game falls back to its save time");
  assert.equal(orderTime({}), 0);
});

test("a game is ordered by when it was played, not by when it was analyzed", () => {
  const records = [
    rec({ id: "monday", date: "2026.01.05", savedAt: Date.UTC(2026, 0, 6) }),
    rec({ id: "weekend", date: "2026.01.10", savedAt: Date.UTC(2026, 0, 6) }),   // analyzed FIRST, played LAST
    rec({ id: "undated", savedAt: Date.UTC(2026, 0, 20) }),                     // no PGN date: the save time decides
  ];
  assert.deepEqual(sortChronological(records).map((r) => r.id), ["monday", "weekend", "undated"]);
  assert.deepEqual(sliceRange(records, 2).map((r) => r.id), ["weekend", "undated"],
    "\"last 2\" is the two most recent games played, so a re-analysis cannot promote an old game");
});

test("summarizeProgress dates the window by when the games were played", () => {
  const s = summarizeProgress([
    rec({ id: "1", date: "2026.01.01", savedAt: 5000 }),
    rec({ id: "2", date: "2026.02.01", savedAt: 1000 }),
  ]);
  assert.equal(s.first, new Date(2026, 0, 1).getTime());
  assert.equal(s.last, new Date(2026, 1, 1).getTime());
});

test("progressPoints carries the opponent so the charts can label a point", () => {
  const [p] = progressPoints([rec({ id: "a", myName: "Ann", opName: "Bob" })]);
  assert.equal(p.opponent, "Bob");
  assert.equal(progressPoints([rec({ id: "b" })])[0].opponent, "", "missing names stay empty, not undefined");
});

test("brilliants count the tracked side only, never the opponent's", () => {
  assert.equal(myBrilliantCount({ brilliantCount: 3, myCounts: { brilliant: 1 } }), 1);
  assert.equal(myBrilliantCount({ brilliantCount: 3, myBrilliant: true }), 1, "older records only have the flag");
  assert.equal(myBrilliantCount({ brilliantCount: 3, myBrilliant: false }), 0);
  assert.equal(myBrilliantCount({ brilliantCount: 3 }), 0, "no per-side data: claim nothing");
  const s = summarizeProgress([
    rec({ id: "1", brilliantCount: 3, myCounts: { brilliant: 1 } }),
    rec({ id: "2", brilliantCount: 1, myBrilliant: true }),
    rec({ id: "3", brilliantCount: 9 }),
  ]);
  assert.equal(s.brilliants, 2, "1 + 1 + 0, not the 13 both sides produced");
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
    rec({ id: "1", savedAt: 1, result: "win", myAcc: 70, myBrilliant: true, brilliantCount: 1, opRating: 1400, plies: 60, date: "2026.01.01", opName: "A" }),
    rec({ id: "2", savedAt: 2, result: "win", myAcc: 92.4, brilliantCount: 0, opRating: 1700, plies: 40, date: "2026.01.02", opName: "B" }),
    rec({ id: "3", savedAt: 3, result: "loss", myAcc: 88, myCounts: { brilliant: 2 }, brilliantCount: 3, opRating: 1500, plies: 80, date: "2026.01.03", opName: "C" }),
    rec({ id: "4", savedAt: 4, result: "win", myAcc: 80, brilliantCount: 9, opRating: 1600, plies: 24, date: "2026.01.04", opName: "D" }),
  ];
  const best = Object.fromEntries(personalBests(records).map((b) => [b.key, b]));
  assert.equal(best.accuracy.id, "2");
  assert.equal(best.accuracy.text, "92.4");
  assert.equal(best.accuracy.hint, "2026.01.02 · vs B");
  assert.equal(best.winStreak.value, 2);                 // the two opening wins
  assert.equal(best.winStreak.text, "2 games");
  assert.equal(best.unbeaten.value, 2);
  assert.equal(best.brilliants.id, "3");
  assert.equal(best.brilliants.text, "2", "only your brilliants count, not the opponent's 9 in game 4");
  assert.equal(best.topWin.id, "2");
  assert.equal(best.topWin.text, "1700");
  assert.equal(best.fastestWin.id, "4");
  assert.equal(best.fastestWin.text, "12 moves", "24 plies is a 12-move win");
});

test("personalBests leaves a category empty until a game qualifies for it", () => {
  const best = Object.fromEntries(personalBests([rec({ id: "1", result: "loss" })]).map((b) => [b.key, b]));
  for (const key of ["accuracy", "winStreak", "unbeaten", "brilliants", "topWin", "fastestWin"]) {
    assert.equal(best[key].text, null, `${key} should be empty`);
    assert.equal(best[key].id, null);
  }
  assert.deepEqual(personalBests([]).map((b) => b.text), [null, null, null, null, null, null]);
});

// Progress tracks ONE account (the handle from the popup's manual panel), so a library that also
// holds games reviewed for other people cannot move your numbers.
test("playerSide finds the tracked account in either seat, case-insensitively", () => {
  const white = rec({ myName: "Ann", opName: "Bob", meSide: "w" });
  const black = rec({ myName: "Ann", opName: "Bob", meSide: "b" });
  assert.equal(playerSide(white, "ann"), "w", "the saved side");
  assert.equal(playerSide(black, "ann"), "b");
  assert.equal(playerSide(white, "bob"), "b", "the opponent's seat");
  assert.equal(playerSide(black, " BO B " .trim()), null);
  assert.equal(playerSide(white, "  bob  "), "b", "trimmed");
  assert.equal(playerSide(white, ""), null, "no handle means no match");
  assert.equal(playerSide(white, null), null);
  assert.equal(playerSide(null, "ann"), null);
});

test("ownGames keeps only the tracked account and drops games reviewed for others", () => {
  const mine = rec({ id: "mine", myName: "Ann", opName: "Bob", meSide: "w" });
  const friends = rec({ id: "friends", myName: "Carl", opName: "Dana", meSide: "w" });
  const theirs = rec({ id: "theirs", myName: "Carl", opName: "ann", meSide: "w" });
  assert.deepEqual(ownGames([mine, friends, theirs], "Ann").map((r) => r.id), ["mine", "theirs"]);
  assert.deepEqual(ownGames([mine, friends], "").map((r) => r.id), [], "an unset handle matches nothing");
});

test("ownGames re-points a game saved from the opponent's seat", () => {
  const saved = rec({
    id: "g", myName: "Carl", opName: "Ann", meSide: "w",
    myAcc: 61, opAcc: 88, myRating: 1200, opRating: 1900, myEstimate: 1150, opEstimate: 1950,
    myGrade: 5.2, opGrade: 8.1, myCounts: { brilliant: 0, blunder: 5 }, opCounts: { brilliant: 2, blunder: 1 },
    myPhases: { opening: 55, middlegame: null, endgame: null }, result: "loss", brilliantCount: 3,
  });
  const [mine] = ownGames([saved], "Ann");
  assert.equal(mine.meSide, "b", "the tracked account was Black");
  assert.equal(mine.myName, "Ann");
  assert.equal(mine.opName, "Carl");
  assert.equal(mine.myAcc, 88, "accuracy follows the account, not the saved seat");
  assert.equal(mine.myRating, 1900);
  assert.equal(mine.myEstimate, 1950, "the review's estimate follows the account too");
  assert.equal(mine.myGrade, 8.1, "the grade must describe the tracked account");
  assert.equal(mine.myCounts.blunder, 1, "decision tallies are per side, so they are re-pointed");
  assert.equal(mine.opCounts.blunder, 5);
  assert.equal(mine.myBrilliant, null, "the old whole-game brilliant flag cannot be split");
  assert.equal(mine.result, "win", "a loss for the saved seat is a win for the tracked account");
  assert.equal(mine.myPhases, null, "the opponent's per-phase accuracy is not stored, so it must not be claimed");
  assert.equal(mine.brilliantCount, 3, "game-wide fields are untouched");
  assert.equal(saved.myAcc, 61, "the stored record is not mutated");
});

test("libraryFlip reopens a game on the tracked account's seat", () => {
  // Saved from Carl's seat (White), reviewed for Ann: the page reports Ann's game, so the review must
  // open as Black. The stored hint describes Carl's view and must not win here.
  const theirs = rec({ id: "theirs", meSide: "w", myName: "Carl", opName: "Ann", meta: { flip: false } });
  assert.equal(libraryFlip(theirs, "Ann"), true);
  assert.equal(libraryFlip(theirs, "ann"), true, "the handle matches case-insensitively");
  // The same game for its own seat keeps the perspective it was saved with, even when that was flipped
  // by hand: only the re-pointed records change.
  const mine = rec({ id: "mine", meSide: "w", myName: "Ann", opName: "Carl", meta: { flip: true } });
  assert.equal(libraryFlip(mine, "Ann"), true);
  assert.equal(libraryFlip(rec({ id: "plain", meSide: "b", myName: "Ann", opName: "Carl" }), "Ann"), true,
    "no stored hint falls back to the saved side");
  // Without a handle (or a record that names neither seat) nothing can be re-pointed.
  assert.equal(libraryFlip(rec({ id: "b", meSide: "b", myName: "Carl", opName: "Ann", meta: { flip: false } }), ""), false);
  assert.equal(libraryFlip(rec({ id: "c", meSide: "b", myName: "Carl", opName: "Dana" }), "Ann"), true);
  assert.equal(libraryFlip(null, "Ann"), false, "a missing record seats White");
  assert.equal(libraryFlip(rec({ id: "weird", meSide: "w", meta: { flip: "yes" } }), "Ann"), true, "the hint is coerced");
});

test("a tracked account's own games pass through unchanged", () => {
  const saved = rec({ id: "g", myName: "Ann", opName: "Bob", meSide: "b", myAcc: 70, result: "win", myPhases: { opening: 80 } });
  const [mine] = ownGames([saved], "ann");
  assert.equal(mine, saved, "same object, same fields - no needless copying");
});

/* ---------------- daily tracker + the evidence behind a card ---------------- */

test("dayKey names the local calendar day, or nothing without a PGN date", () => {
  assert.equal(dayKey({ date: "2026.10.02" }), "2026-10-02");
  assert.equal(dayKey({ date: "2026-1-2" }), "2026-01-02");
  assert.equal(dayKey({ date: "????.??.??" }), null);
  assert.equal(dayKey({}), null);
});

test("dailyActivity fills a continuous window and counts each day", () => {
  const now = new Date(2026, 10, 1, 12).getTime();          // 1 Nov 2026, noon
  const daily = dailyActivity([
    rec({ id: "a", date: "2026.11.01" }),
    rec({ id: "b", date: "2026.11.01", result: "win", myAcc: 80, myEstimate: 1600 }),
    rec({ id: "c", date: "2026.10.31", result: "loss" }),
    rec({ id: "d", date: "2026.10.30", result: "draw", myAcc: 60 }),
    rec({ id: "undated", savedAt: 5 }),
    rec({ id: "old", date: "2026.01.01" }),                 // before the window
  ], { days: 7, now });
  assert.equal(daily.cells.length, 7, "every day is a cell, even with no games");
  assert.equal(daily.cells.at(-1).key, "2026-11-01");
  assert.equal(daily.cells.at(-1).games, 2);
  assert.equal(daily.cells.at(-1).wins, 1);
  assert.equal(daily.cells.at(-1).accuracy, 80);
  assert.equal(daily.cells.at(-1).rating, 1600);
  assert.equal(daily.cells.at(-2).key, "2026-10-31");
  assert.equal(daily.cells.at(-2).losses, 1);
  assert.equal(daily.games, 4, "the undated and out-of-window games are not silently counted");
  assert.equal(daily.undated, 1);
  assert.equal(daily.outside, 1);
  assert.equal(daily.activeDays, 3);
  assert.equal(daily.max, 2);
  assert.equal(daily.streak, 3, "three consecutive days ending today");
  assert.equal(daily.best, 3);
  assert.equal(daily.today, "2026-11-01");
});

test("playedAt rejects a game dated in the future", () => {
  const now = new Date(2026, 10, 1, 12).getTime();          // 1 Nov 2026, noon
  assert.equal(playedAt({ date: "2026.11.01" }, { now }), new Date(2026, 10, 1).getTime(), "today is a real day");
  assert.equal(playedAt({ date: "2026.11.02" }, { now }), new Date(2026, 10, 2).getTime(),
    "tomorrow is accepted: a PGN written in another timezone may be a day ahead");
  assert.equal(playedAt({ date: "2026.11.03" }, { now }), null, "the day after tomorrow cannot have been played");
  assert.equal(playedAt({ date: "2027.05.05" }, { now }), null, "a clock-skewed PGN is undated, not future-dated");
  assert.equal(playedAt({ date: "2026.10.31" }, { now }), new Date(2026, 9, 31).getTime(), "the past is untouched");
});

test("dailyActivity counts a future-dated game as undated instead of dropping it", () => {
  const now = new Date(2026, 10, 1, 12).getTime();
  const daily = dailyActivity([
    rec({ id: "played", date: "2026.10.31", result: "win" }),
    rec({ id: "future", date: "2027.05.05", result: "win" }),   // would otherwise fall outside the window
  ], { days: 84, now });
  assert.equal(daily.games, 1);
  assert.equal(daily.undated, 1, "reported as unplaceable, not silently missing from the cards' count");
  assert.equal(daily.outside, 0);
});

test("dailyActivity does not call a run that ended last week a current streak", () => {
  const now = new Date(2026, 10, 1, 12).getTime();
  const daily = dailyActivity([rec({ id: "x", date: "2026.10.29" })], { days: 7, now });
  assert.equal(daily.streak, 0);
  assert.equal(daily.best, 1);
  assert.equal(daily.bestEnd, "2026-10-29");
});

test("filterGames scopes to a single played day", () => {
  const all = [rec({ id: "a", date: "2026.10.01" }), rec({ id: "b", date: "2026.10.02" }), rec({ id: "c" })];
  assert.deepEqual(filterGames(all, { day: "2026-10-02" }).map((r) => r.id), ["b"]);
  assert.equal(filterGames(all, { day: "" }).length, 3);
  assert.equal(filterGames(all, { day: "2026-10-02", result: "win" }).length, 0, "combines with the other filters");
});

test("metricEvidence lists the games behind a number, highest first", () => {
  const ev = metricEvidence([
    rec({ id: "a", date: "2026.10.01", myAcc: 70, opName: "A", result: "loss", myWorst: { ply: 13, cat: "blunder" } }),
    rec({ id: "b", date: "2026.10.02", myAcc: 90, opName: "B", result: "win" }),
    rec({ id: "c", date: "2026.10.03", myAcc: null, result: "win" }),
  ], "accuracy");
  assert.equal(ev.games, 2, "a game with no accuracy is skipped, never treated as zero");
  assert.equal(ev.mean, 80);
  assert.deepEqual(ev.rows.map((r) => r.id), ["b", "a"]);
  assert.equal(ev.rows[0].text, "90");
  assert.equal(ev.rows[1].ply, 13, "the worst move rides along for the deep link");
  assert.equal(ev.rows[1].category, "blunder");
  assert.equal(ev.min, 70);
  assert.equal(ev.max, 90);
  assert.equal(metricEvidence([], "nope"), null);
});

test("metricEvidence does not average score and win rate on the wrong scale", () => {
  const records = [
    rec({ id: "w", result: "win", date: "2026.10.01" }),
    rec({ id: "d", result: "draw", date: "2026.10.02" }),
    rec({ id: "l", result: "loss", date: "2026.10.03" }),
    rec({ id: "x", result: "", date: "2026.10.04" }),
  ];
  const score = metricEvidence(records, "score");
  assert.equal(score.games, 3, "a game without a result cannot contribute");
  assert.equal(score.mean, 50, "the mean is the same percentage the card shows");
  assert.deepEqual(score.rows.map((r) => r.text), ["loss", "draw", "win"], "newest first");
  const winRate = metricEvidence(records, "winRate");
  assert.equal(winRate.games, 2, "draws are excluded");
  assert.equal(winRate.mean, 50);
});

test("metricEvidence pools the error rate instead of averaging per-game rates", () => {
  const ev = metricEvidence([
    rec({ id: "big", myCounts: counts({ best: 90, inacc: 5, blunder: 5 }) }),   // 10 errors in 100 moves
    rec({ id: "small", myCounts: counts({ best: 1, blunder: 1 }) }),            // 1 error in 2 moves
  ], "errorRate");
  assert.equal(ev.pooled.num, 11);
  assert.equal(ev.pooled.den, 102);
  assert.equal(Math.round(ev.pooled.value * 10) / 10, 10.8);
  assert.deepEqual(ev.rows.map((r) => r.id), ["small", "big"], "worst first");
  assert.equal(Math.round(ev.rows[0].value), 50);
});

test("metricEvidence sums your brilliants and never the opponent's", () => {
  const ev = metricEvidence([
    rec({ id: "a", brilliantCount: 4, myCounts: counts({ brilliant: 1 }) }),
    rec({ id: "b", brilliantCount: 2, myCounts: counts({ brilliant: 2 }) }),
  ], "brilliants");
  assert.equal(ev.total, 3);
  assert.equal(ev.games, 2);
  assert.equal(ev.rows[0].id, "b", "highest first");
});

test("metricEvidence caps the rows but keeps the full sample size", () => {
  const many = Array.from({ length: 20 }, (_, i) => rec({ id: `g${i}`, savedAt: 100 + i, myAcc: 50 + i }));
  const ev = metricEvidence(many, "accuracy", { limit: 5 });
  assert.equal(ev.rows.length, 5);
  assert.equal(ev.shown, 5);
  assert.equal(ev.games, 20);
  assert.equal(ev.mean, 59.5);
});

/* ---------------- report window: ranges and filters ---------------- */

const series = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => rec({
  id: `g${i}`, savedAt: 100 + i, myAcc: 50 + i, result: i % 3 === 0 ? "win" : i % 3 === 1 ? "loss" : "draw",
  type: i % 2 ? "Blitz" : "Rapid", meSide: i % 2 ? "b" : "w", ...over(i),
}));

test("sliceRange keeps the newest N games and everything when unset", () => {
  const all = series(10);
  assert.deepEqual(sliceRange(all, 3).map((r) => r.id), ["g7", "g8", "g9"], "newest three, oldest first");
  assert.equal(sliceRange(all, 0).length, 10);
  assert.equal(sliceRange(all, null).length, 10);
  assert.equal(sliceRange(all, 99).length, 10, "a range wider than the library is harmless");
});

test("filterGames applies colour, time class and result together", () => {
  const all = series(6);
  assert.equal(filterGames(all, { colour: "b" }).length, 3);
  assert.equal(filterGames(all, { type: "Blitz" }).length, 3);
  assert.equal(filterGames(all, { result: "draw" }).length, 2);
  const both = filterGames(all, { colour: "b", type: "Blitz" });
  assert.ok(both.every((r) => r.meSide === "b" && r.type === "Blitz"));
  assert.equal(filterGames(all, {}).length, 6, "no filters = everything");
});

test("colourSplit reports volume, score and accuracy per colour", () => {
  const rows = colourSplit([
    rec({ id: "1", meSide: "w", result: "win", myAcc: 90 }),
    rec({ id: "2", meSide: "w", result: "loss", myAcc: 70 }),
    rec({ id: "3", meSide: "b", result: "draw", myAcc: 80 }),
  ]);
  const [white, black] = rows;
  assert.equal(white.label, "White");
  assert.equal(white.games, 2);
  assert.equal(white.score, 50, "one win of two decided games");
  assert.equal(white.accuracy, 80);
  assert.equal(black.games, 1);
  assert.equal(black.score, 50, "a single draw scores half");
  assert.equal(black.accuracy, 80);
});

test("colourSplit and typeSplit stay null-safe with no games", () => {
  assert.deepEqual(colourSplit([]).map((r) => r.games), [0, 0]);
  assert.deepEqual(colourSplit([]).map((r) => r.score), [null, null]);
  assert.deepEqual(typeSplit([]), []);
});

test("typeSplit groups by time class, most played first", () => {
  const rows = typeSplit(series(6));
  assert.deepEqual(rows.map((r) => r.key), ["Blitz", "Rapid"], "three each, ties broken by name");
  assert.equal(rows[0].games, 3);
  const untyped = typeSplit([rec({ id: "x", type: "" })]);
  assert.equal(untyped[0].label, "Unrated", "a game with no time class is still counted");
});

/* ---------------- decision quality ---------------- */

const counts = (over = {}) => ({ brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, forced: 0, inacc: 0, mistake: 0, miss: 0, blunder: 0, ...over });

test("decisionProfile tallies both sides and computes your error rate", () => {
  const profile = decisionProfile([
    rec({ id: "1", myCounts: counts({ best: 20, inacc: 3, mistake: 2, blunder: 1 }), opCounts: counts({ best: 10, blunder: 5 }) }),
    rec({ id: "2", myCounts: counts({ best: 10, mistake: 4 }), opCounts: counts({ inacc: 2 }) }),
  ]);
  assert.equal(profile.games, 2);
  assert.equal(profile.moves, 40, "20 + 5 + 10 + 5 of my classified moves");
  assert.equal(profile.me.mistake, 6);
  assert.equal(profile.them.blunder, 5);
  assert.equal(profile.errorMoves, 10, "inacc + mistake + miss + blunder");
  assert.equal(profile.errorRate, 25, "10 errors in 40 classified moves");
  const row = profile.rows.find((r) => r.key === "blunder");
  assert.equal(row.me, 1);
  assert.equal(row.them, 5);
  assert.equal(row.share, 2.5);
});

test("decisionProfile says nothing rather than zero when no game carries tallies", () => {
  assert.equal(decisionProfile([rec({ id: "old" }), rec({ id: "older" })]), null);
  assert.equal(decisionProfile([]), null);
  assert.ok(ERROR_KEYS.includes("miss") && ERROR_KEYS.includes("blunder"));
});

test("accuracyHistogram bins the games and counts the total", () => {
  const { bins, total, size } = accuracyHistogram([
    rec({ id: "1", myAcc: 0 }), rec({ id: "2", myAcc: 9.9 }), rec({ id: "3", myAcc: 10 }),
    rec({ id: "4", myAcc: 55 }), rec({ id: "5", myAcc: 100 }), rec({ id: "6", myAcc: null }),
  ]);
  assert.equal(size, 10);
  assert.equal(total, 5, "the null accuracy is skipped");
  assert.equal(bins[0].count, 2, "0 and 9.9 share the first bin");
  assert.equal(bins[1].count, 1, "10 starts the second");
  assert.equal(bins[5].count, 1);
  assert.equal(bins[9].count, 1, "100 lands in the last bin, not out of range");
  assert.equal(bins.reduce((n, b) => n + b.count, 0), total);
});

/* ---------------- trends and form ---------------- */

test("scoreTrend is a rolling tournament score", () => {
  const rows = scoreTrend([
    rec({ id: "1", savedAt: 1, result: "win" }), rec({ id: "2", savedAt: 2, result: "loss" }),
    rec({ id: "3", savedAt: 3, result: "draw" }), rec({ id: "4", savedAt: 4, result: "win" }),
  ], 2);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].value, 1);
  assert.equal(rows[1].value, 0.5, "win + loss");
  assert.equal(rows[2].value, 0.25, "loss + draw");
  assert.equal(rows[3].value, 0.75, "draw + win");
  assert.equal(rows[0].id, "1", "points stay tied to their game");
});

test("scoreTrend ignores games without a result", () => {
  const rows = scoreTrend([rec({ id: "1", savedAt: 1, result: "" }), rec({ id: "2", savedAt: 2, result: "win" })], 10);
  assert.equal(rows[0].value, null);
  assert.equal(rows[1].value, 1);
});

test("momentum compares the recent window with the stretch before it", () => {
  const all = [
    ...series(5, () => ({ myAcc: 50, myRating: 1400, result: "loss" })),
    ...series(5, (i) => ({ id: `r${i}`, myAcc: 70, myRating: 1500, result: "win" })).map((r, i) => ({ ...r, savedAt: 1000 + i })),
  ];
  const m = momentum(all, 5);
  assert.equal(m.recentGames, 5);
  assert.equal(m.previousGames, 5);
  assert.equal(m.accuracy.recent, 70);
  assert.equal(m.accuracy.previous, 50);
  assert.equal(m.delta.accuracy, 20);
  assert.equal(m.delta.rating, 100);
  assert.equal(m.score.recent, 100, "the tournament score is a percentage, like accuracy");
  assert.equal(m.score.previous, 0);
  assert.equal(m.delta.score, 100, "100% vs 0%");
});

test("momentum returns nulls instead of inventing a comparison", () => {
  const m = momentum(series(3), 5);
  assert.equal(m.previousGames, 0);
  assert.equal(m.delta.accuracy, null);
  assert.equal(m.delta.score, null);
});

test("stability measures the spread of accuracy", () => {
  const even = stability([rec({ id: "1", savedAt: 1, myAcc: 80 }), rec({ id: "2", savedAt: 2, myAcc: 80 })]);
  assert.equal(even.mean, 80);
  assert.equal(even.sd, 0);
  const wild = stability([rec({ id: "1", savedAt: 1, myAcc: 60 }), rec({ id: "2", savedAt: 2, myAcc: 90 })]);
  assert.equal(wild.sd, 21.2, "sample standard deviation of 60/90");
  const one = stability([rec({ id: "1", savedAt: 1, myAcc: 70 })]);
  assert.equal(one.sd, null, "a single game has no spread");
});

test("gradeSeries keeps one point per game and leaves gaps for old records", () => {
  const rows = gradeSeries([
    rec({ id: "old", savedAt: 1 }),
    rec({ id: "new", savedAt: 2, myGrade: 7.25 }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["old", "new"]);
  assert.equal(rows[0].value, null, "no grade stored");
  assert.equal(rows[1].value, 7.3, "rounded for display");
});

test("sortRows sorts by any column, both ways, without touching the input", () => {
  const rows = [{ key: "A", games: 2, score: 30 }, { key: "B", games: 10, score: 55 }, { key: "C", games: 5, score: null }];
  assert.deepEqual(sortRows(rows, "games").map((r) => r.key), ["B", "C", "A"]);
  assert.deepEqual(sortRows(rows, "games", "asc").map((r) => r.key), ["A", "C", "B"]);
  assert.deepEqual(sortRows(rows, "key", "asc").map((r) => r.key), ["A", "B", "C"]);
  assert.deepEqual(sortRows(rows, "score").map((r) => r.key), ["B", "A", "C"], "a missing score sorts last");
  assert.deepEqual(rows.map((r) => r.key), ["A", "B", "C"], "the original order is preserved");
});

/* ---------------- head to head, scoping, coaching ---------------- */

test("opponentReport groups by name and ignores placeholder seats", () => {
  const out = opponentReport([
    rec({ id: "1", opName: "Magnus", result: "loss", myAcc: 70, opRating: 2800 }),
    rec({ id: "2", opName: " magnus ", result: "win", myAcc: 90, opRating: 2800 }),
    rec({ id: "3", opName: "Hikaru", result: "draw", myAcc: 80 }),
    rec({ id: "4", opName: "White", result: "win" }),   // the Live board's own seat label
    rec({ id: "5", opName: "", result: "win" }),
  ]);
  assert.deepEqual(out.rows.map((r) => r.key), ["magnus", "hikaru"], "most played first, then the worse record");
  assert.equal(out.unnamed, 2, "placeholder and missing names are counted, not invented as a rival");
  const magnus = out.rows[0];
  assert.equal(magnus.games, 2);
  assert.equal(magnus.wins, 1);
  assert.equal(magnus.losses, 1);
  assert.equal(magnus.score, 50);
  assert.equal(magnus.accuracy, 80);
  assert.equal(magnus.opponentRating, 2800);
  assert.equal(magnus.lastId, "2", "the row carries its most recent game");
  assert.equal(opponentKey(rec({ opName: "black" })), "");
});

test("filterGames scopes by opponent and opening", () => {
  const records = [
    rec({ id: "1", opName: "Magnus", eco: "B90", opening: "Sicilian", meSide: "w" }),
    rec({ id: "2", opName: "Hikaru", eco: "C50", opening: "Italian", meSide: "b" }),
    rec({ id: "3", opName: "magnus", eco: "C50", opening: "Italian", meSide: "b" }),
  ];
  assert.deepEqual(filterGames(records, { opponent: "magnus" }).map((r) => r.id), ["1", "3"]);
  assert.deepEqual(filterGames(records, { opening: "C50|Italian" }).map((r) => r.id), ["2", "3"]);
  assert.deepEqual(filterGames(records, { opponent: "magnus", opening: "C50|Italian" }).map((r) => r.id), ["3"]);
});

test("focusAreas names the weakest phase and links the game behind it", () => {
  const areas = focusAreas([
    rec({ id: "1", myPhases: { opening: 88, middlegame: 86, endgame: 60 }, myWorst: { ply: 41, cat: "blunder" } }),
    rec({ id: "2", myPhases: { opening: 90, middlegame: 84, endgame: 64 } }),
    rec({ id: "3", myPhases: { opening: 86, middlegame: 88, endgame: 66 } }),
  ]);
  const phase = areas.find((a) => a.key === "phase");
  assert.match(phase.title, /endgame is the weak link/);
  assert.equal(phase.target.kind, "game");
  assert.equal(phase.target.id, "1", "the game with the worst endgame is the one to open");
  assert.equal(phase.target.ply, undefined, "no ply: that game's worst move may not be in the weak phase");
});

test("focusAreas flags the costliest error type and the weaker colour", () => {
  const counts = (inacc, mistake) => ({ inacc, mistake, best: 30 });
  const records = [
    rec({ id: "w1", meSide: "w", result: "win", myCounts: counts(1, 1) }),
    rec({ id: "w2", meSide: "w", result: "win", myCounts: counts(2, 1) }),
    rec({ id: "w3", meSide: "w", result: "win", myCounts: counts(1, 2) }),
    rec({ id: "b1", meSide: "b", result: "loss", myCounts: counts(6, 3) }),
    rec({ id: "b2", meSide: "b", result: "loss", myCounts: counts(5, 4) }),
    rec({ id: "b3", meSide: "b", result: "loss", myCounts: counts(4, 5) }),
  ];
  const areas = focusAreas(records);
  const decision = areas.find((a) => a.key === "decision");
  // 19 inaccuracies x1 = 19 against 16 mistakes x2 = 32: the costlier type wins, not the frequent one.
  assert.equal(decision.title, "mistakes cost you most");
  assert.equal(decision.target.id, "b3", "the game with the most of that type");
  assert.equal(decision.target.ply, null, "no ply when that game's worst move is something else");
  const colour = areas.find((a) => a.key === "colour");
  assert.equal(colour.target.kind, "colour");
  assert.equal(colour.target.value, "b");
  assert.equal(colour.title, "Black is your weaker side");
});

test("focusAreas flags a nemesis and an opening that is not working", () => {
  const records = Array.from({ length: 5 }, (_, i) =>
    rec({ id: `s${i}`, opName: "Rival", result: "loss", eco: "B90", opening: "Sicilian Defence" }));
  const areas = focusAreas(records);
  const opening = areas.find((a) => a.key === "opening");
  assert.equal(opening.title, "Sicilian Defence is not working");
  assert.equal(opening.target.kind, "opening");
  assert.equal(opening.target.value, "B90|Sicilian Defence");
  const nemesis = areas.find((a) => a.key === "nemesis");
  assert.equal(nemesis.target.value, "rival");
  assert.match(nemesis.detail, /0-0-5/);
  assert.deepEqual(areas.map((a) => a.weight), [...areas.map((a) => a.weight)].sort((a, b) => b - a),
    "ranked most severe first");
});

test("focusAreas says nothing when nothing clears its threshold", () => {
  const records = [
    rec({ id: "1", opName: "A", result: "win", myCounts: { best: 40 }, myPhases: { opening: 85, middlegame: 84, endgame: 83 } }),
    rec({ id: "2", opName: "B", result: "win", myCounts: { best: 40 }, myPhases: { opening: 84, middlegame: 85, endgame: 84 } }),
  ];
  assert.deepEqual(focusAreas(records), []);
});

test("gameRows exposes the table's numbers and the worst move", () => {
  const [row] = gameRows([rec({
    id: "g", date: "2026.02.03", opName: "Magnus", meSide: "b", result: "win", myAcc: 81.2,
    myGrade: 7.4, myCounts: { inacc: 2, mistake: 1, best: 30 }, plies: 61, opening: "Sicilian",
    myWorst: { ply: 41, cat: "blunder" },
  })]);
  assert.equal(row.colourLabel, "Black");
  assert.equal(row.errors, 3);
  assert.equal(row.moves, 31, "61 plies is a 31-move game");
  assert.equal(row.ply, 41);
  assert.equal(row.category, "blunder");
  assert.equal(row.errorRate, (3 / 33) * 100);
  assert.equal(row.at, new Date(2026, 1, 3).getTime());
});

/* ---------------- the bug-report regressions ---------------- */

test("the Unrated format chip matches games whose type is blank", () => {
  const records = [rec({ id: "1", type: "" }), rec({ id: "2", type: "Blitz" }), rec({ id: "3" })];
  assert.deepEqual(filterGames(records, { type: "Unrated" }).map((r) => r.id), ["1", "3"]);
  assert.equal(typeSplit(records).find((t) => t.key === "Unrated").games, 2);
});

test("playedAt rejects a day the month does not have", () => {
  assert.equal(playedAt({ date: "2026.02.31" }), null, "it would otherwise roll into March");
  assert.equal(playedAt({ date: "2026.04.31" }), null);
  assert.equal(playedAt({ date: "2024.02.29" }), new Date(2024, 1, 29).getTime(), "a leap day is real");
});

test("sortRows keeps rows with no value last in both directions", () => {
  const rows = [{ key: "A", score: 10 }, { key: "B", score: null }, { key: "C", score: 30 }];
  assert.deepEqual(sortRows(rows, "score", "asc").map((r) => r.key), ["A", "C", "B"]);
  assert.deepEqual(sortRows(rows, "score", "desc").map((r) => r.key), ["C", "A", "B"]);
});

test("streaks are counted over every tracked game, not the filtered window", () => {
  const all = [
    rec({ id: "w1", savedAt: 1, result: "win" }),
    rec({ id: "l1", savedAt: 2, result: "loss" }),
    rec({ id: "w2", savedAt: 3, result: "win" }),
    rec({ id: "w3", savedAt: 4, result: "win" }),
  ];
  const winsOnly = filterGames(all, { result: "win" });
  const naive = Object.fromEntries(personalBests(winsOnly).map((b) => [b.key, b]));
  assert.equal(naive.winStreak.value, 3, "the filter alone makes 3 unrelated wins look consecutive");
  const honest = Object.fromEntries(personalBests(winsOnly, { streakSource: all }).map((b) => [b.key, b]));
  assert.equal(honest.winStreak.value, 2, "the real run is the two at the end");
});

test("the current streak survives a day off, but not two", () => {
  const now = new Date(2026, 4, 10, 12).getTime();   // May 10
  const day = (d) => `2026.05.${String(d).padStart(2, "0")}`;
  const endedYesterday = dailyActivity([6, 7, 8, 9].map((d) => rec({ id: `d${d}`, date: day(d) })), { now });
  assert.equal(endedYesterday.streak, 4, "a run through yesterday is still current");
  const includesToday = dailyActivity([7, 8, 9, 10].map((d) => rec({ id: `d${d}`, date: day(d) })), { now });
  assert.equal(includesToday.streak, 4);
  const stale = dailyActivity([5, 6, 7, 8].map((d) => rec({ id: `d${d}`, date: day(d) })), { now });
  assert.equal(stale.streak, 0, "a run that stopped two days ago is history");
});

test("underperformingOpenings never advises on games with no opening recorded", () => {
  const report = openingReport(Array.from({ length: 6 }, (_, i) => rec({ id: `u${i}`, result: "loss" })));
  assert.equal(report.length, 1);
  assert.equal(report[0].key, "unknown");
  assert.deepEqual(underperformingOpenings(report), []);
});

test("focusAreas does not call the unknown-opening bucket an opening", () => {
  const areas = focusAreas(Array.from({ length: 6 }, (_, i) => rec({ id: `u${i}`, result: "loss", opName: "Rival" })));
  assert.equal(areas.some((a) => a.key === "opening"), false);
  assert.equal(areas.some((a) => a.key === "nemesis"), true, "the rival finding is still real");
});

test("focusAreas ranks error types by what they cost, not how often they happen", () => {
  const withWorst = (cat) => focusAreas([rec({
    id: "1", myCounts: { best: 100, inacc: 5, blunder: 3 }, myWorst: { ply: 11, cat },
  })]).find((a) => a.key === "decision");
  const top = withWorst("blunder");
  assert.equal(top.title, "blunders cost you most", "3 blunders outweigh 5 inaccuracies");
  assert.equal(top.target.ply, 11, "that game's decisive move IS a blunder");
  assert.equal(withWorst("inacc").target.ply, null, "no ply when the decisive move is a different type");
});
