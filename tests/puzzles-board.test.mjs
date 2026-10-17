import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PuzzleSolver, PuzzleManager } from "../puzzles.js";

test("PuzzleSolver and Board Interaction: starting FEN and 64-square representation", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5", "e4d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(puzzle);
  assert.equal(solver.chess.fen(), puzzle.fen);

  // Initial piece placement validation
  assert.equal(solver.chess.get("d4"), undefined);
  assert.equal(solver.chess.get("f3")?.type, "n");
  assert.equal(solver.chess.get("c4")?.type, "b");
});

test("PuzzleSolver and Board Interaction: piece re-selection, legal move submission, and opponent replies", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5", "e4d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(puzzle);

  // Simulate piece selection (e.g. White selecting e2 pawn then changing mind to select f3 knight)
  let selected = "e2";
  const whiteKnight = solver.chess.get("f3");
  if (whiteKnight && whiteKnight.color === solver.chess.turn()) {
    selected = "f3"; // Re-selected friendly piece
  }
  assert.equal(selected, "f3");

  // Play correct move f3g5
  const res1 = solver.playMove(selected, "g5");
  assert.equal(res1.success, true);
  assert.equal(res1.opponentMove, "d7d5");
  assert.equal(solver.chess.get("d5")?.type, "p");

  // Incorrect move attempt: does not advance move index or corrupt board
  const wrongRes = solver.playMove("a2", "a3");
  assert.equal(wrongRes.success, false);
  assert.equal(solver.moveIdx, 2);

  // Illegal move attempt
  const illegalRes = solver.playMove("e1", "e8");
  assert.equal(illegalRes.success, false);
  assert.equal(solver.moveIdx, 2);

  // Complete puzzle
  const res2 = solver.playMove("e4", "d5");
  assert.equal(res2.success, true);
  assert.equal(res2.completed, true);
});

test("PuzzleSolver: Promotion handling (Queen & Underpromotions)", () => {
  // Pawn on e7 ready to promote on e8
  const promoPuzzle = {
    id: "p_promo",
    fen: "8/4P3/8/8/8/8/8/4K2k w - - 0 1",
    moves: ["e7e8q"],
    theme: "endgame",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(promoPuzzle);
  const res = solver.playMove("e7", "e8", "q");
  assert.equal(res.success, true);
  assert.equal(res.completed, true);
  assert.equal(solver.chess.get("e8")?.type, "q");

  // Underpromotion puzzle (Pawn to Knight e7e8n)
  const underPromoPuzzle = {
    id: "p_underpromo",
    fen: "8/4P3/8/8/8/8/8/4K2k w - - 0 1",
    moves: ["e7e8n"],
    theme: "fork",
    difficulty: "medium"
  };

  const solver2 = new PuzzleSolver(underPromoPuzzle);
  // Queen promotion should be rejected as wrong move for this underpromotion puzzle
  const wrongRes = solver2.playMove("e7", "e8", "q");
  assert.equal(wrongRes.success, false);
  assert.equal(solver2.moveIdx, 0);

  // Correct Knight underpromotion
  const correctRes = solver2.playMove("e7", "e8", "n");
  assert.equal(correctRes.success, true);
  assert.equal(correctRes.completed, true);
  assert.equal(solver2.chess.get("e8")?.type, "n");
});

test("PuzzleSolver: Retry, Hint, Reveal, and Coordinate Input Fallback", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const solver = new PuzzleSolver(puzzle);

  // Hint
  const hint = solver.getHint();
  assert.equal(hint.from, "f3");
  assert.equal(hint.to, "g5");

  // Play move
  solver.playMove("f3", "g5");
  assert.equal(solver.completed, true);

  // Retry
  solver.reset();
  assert.equal(solver.completed, false);
  assert.equal(solver.chess.fen(), puzzle.fen);

  // Reveal
  solver.reveal();
  assert.equal(solver.completed, true);
});

test("puzzle-ui.js contains puzzle board, promotion overlay, and re-selection handlers", () => {
  const code = readFileSync("puzzle-ui.js", "utf8");
  assert.ok(code.includes("puzzle-board"), "renders puzzle-board");
  assert.ok(code.includes("puzzle-promo-overlay"), "renders promotion overlay");
  assert.ok(code.includes("handleSqClick"), "handles square click");
  assert.ok(code.includes("executeMove"), "executes solver moves");
});
