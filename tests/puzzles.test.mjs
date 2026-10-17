import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePuzzleRecord, validatePuzzleDataset, PUZZLE_THEMES, DIFFICULTY_BANDS } from "../puzzles.js";

test("validatePuzzleDataset approves all 25,000 puzzles in data/puzzles.json", () => {
  const raw = readFileSync("data/puzzles.json", "utf8");
  const data = JSON.parse(raw);

  const res = validatePuzzleDataset(data);
  assert.equal(res.valid, true, `Validation failed: ${res.error}`);
  assert.equal(res.count, 25000, "Dataset contains exactly 25,000 puzzles");
});

test("validatePuzzleRecord rejects malformed records", () => {
  assert.ok(validatePuzzleRecord(null));
  assert.ok(validatePuzzleRecord({}));
  assert.ok(validatePuzzleRecord({ id: "p1" })); // missing FEN
  assert.ok(validatePuzzleRecord({ id: "p1", fen: "invalid_fen" })); // bad FEN
  assert.ok(validatePuzzleRecord({ id: "p1", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", moves: [] })); // empty moves
  assert.ok(validatePuzzleRecord({ id: "p1", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", moves: ["e2e5"], theme: "fork", difficulty: "easy" })); // illegal move
  assert.ok(validatePuzzleRecord({ id: "p1", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", moves: ["e2e4"], theme: "invalid_theme", difficulty: "easy" })); // bad theme
  assert.ok(validatePuzzleRecord({ id: "p1", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", moves: ["e2e4"], theme: "fork", difficulty: "super_hard" })); // bad difficulty
});

test("validatePuzzleDataset rejects duplicate content and IDs", () => {
  const validP1 = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5"],
    theme: "fork",
    difficulty: "easy"
  };
  const validP2 = {
    id: "p0002",
    fen: "r1b1k2r/ppppqppp/2n5/4P3/2B5/2P2N2/P4PPP/R2QK2R b KQkq - 0 9",
    moves: ["c6e5"],
    theme: "pin",
    difficulty: "medium"
  };

  // Duplicate ID
  const dupIdData = { puzzles: [validP1, { ...validP2, id: "p0001" }] };
  assert.equal(validatePuzzleDataset(dupIdData).valid, false);

  // Duplicate FEN/Content
  const dupContentData = { puzzles: [validP1, { ...validP1, id: "p0002" }] };
  assert.equal(validatePuzzleDataset(dupContentData).valid, false);
});

test("puzzles.js exports themes and difficulty bands", () => {
  assert.equal(PUZZLE_THEMES.length, 12, "contains 12 themes");
  assert.equal(DIFFICULTY_BANDS.length, 3, "contains 3 difficulty bands");
});
