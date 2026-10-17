import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PuzzleSolver } from "../puzzles.js";

test("Puzzle Practice board interaction and solver synchronization", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5", "e4d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(puzzle);

  // Board starts at FEN position
  assert.equal(solver.chess.fen(), puzzle.fen);

  // Correct move 1 (f3g5) triggers solver + opponent reply (d7d5)
  const res1 = solver.playMove("f3", "g5");
  assert.equal(res1.success, true);
  assert.equal(res1.opponentMove, "d7d5");
  assert.equal(solver.chess.get("d5")?.type, "p");

  // Incorrect legal move does not advance index
  const resWrong = solver.playMove("a2", "a3");
  assert.equal(resWrong.success, false);
  assert.equal(solver.moveIdx, 2);

  // Correct move 2 (e4d5) completes puzzle
  const res2 = solver.playMove("e4", "d5");
  assert.equal(res2.success, true);
  assert.equal(res2.completed, true);

  // Retry restores initial FEN
  solver.reset();
  assert.equal(solver.chess.fen(), puzzle.fen);

  // Reveal updates position to completed sequence
  solver.reveal();
  assert.equal(solver.completed, true);
});

test("analysis.js contains puzzle board rendering and click handlers", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("puzzle-board"), "renders puzzle-board element");
  assert.ok(code.includes("handleSqClick"), "contains board square click handler");
  assert.ok(code.includes("executeMove"), "routes moves to executeMove solver logic");
});
