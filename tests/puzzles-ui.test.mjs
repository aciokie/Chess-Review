import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PuzzleManager, PuzzleSolver } from "../puzzles.js";

test("PuzzleSolver starts from exact FEN position and manages solution moves", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5", "e4d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(puzzle);
  assert.equal(solver.chess.fen(), puzzle.fen);
  assert.equal(solver.expectedMove, "f3g5");
});

test("PuzzleSolver accepts correct move and auto-plays opponent reply", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5", "e4d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(puzzle);
  const res = solver.playMove("f3", "g5");
  assert.equal(res.success, true);
  assert.equal(res.opponentMove, "d7d5");
  assert.equal(solver.completed, false);

  const res2 = solver.playMove("e4", "d5");
  assert.equal(res2.success, true);
  assert.equal(res2.completed, true);
  assert.equal(solver.completed, true);
});

test("PuzzleSolver rejects incorrect legal moves and illegal moves without advancing index", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(puzzle);

  // Incorrect legal move
  const wrongRes = solver.playMove("d2", "d3");
  assert.equal(wrongRes.success, false);
  assert.equal(wrongRes.reason, "incorrect_move");
  assert.equal(solver.moveIdx, 0);

  // Illegal move
  const illegalRes = solver.playMove("e1", "e8");
  assert.equal(illegalRes.success, false);
  assert.equal(illegalRes.reason, "illegal_move");
  assert.equal(solver.moveIdx, 0);
});

test("PuzzleSolver hint, reveal, and retry reset position correctly", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(puzzle);
  const hint = solver.getHint();
  assert.equal(hint.theme, "fork");
  assert.equal(hint.from, "f3");
  assert.equal(hint.to, "g5");

  solver.playMove("f3", "g5");
  assert.equal(solver.completed, true);

  solver.reset();
  assert.equal(solver.completed, false);
  assert.equal(solver.chess.fen(), puzzle.fen);

  solver.reveal();
  assert.equal(solver.completed, true);
});

test("PuzzleManager handles theme/difficulty filtering and missed puzzles queue", () => {
  const manager = new PuzzleManager();
  manager.puzzles = [
    { id: "p1", fen: "f1", moves: ["m1"], theme: "fork", difficulty: "easy" },
    { id: "p2", fen: "f2", moves: ["m2"], theme: "pin", difficulty: "hard" }
  ];

  const filtered = manager.filterPuzzles("fork", "easy");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "p1");

  manager.recordMissed(manager.puzzles[0]);
  assert.equal(manager.getMissed().length, 1);

  manager.removeMissed("p1");
  assert.equal(manager.getMissed().length, 0);
});

test("analysis.js integrates openPuzzlePractice and Puzzle Practice UI", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("openPuzzlePractice"), "contains openPuzzlePractice function");
  assert.ok(code.includes("Puzzle Practice"), "contains Puzzle Practice title");
  assert.ok(code.includes("Review Missed Puzzles"), "contains Review Missed Puzzles title");
});
