import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Chess } from "../lib/chess.js";

test("data/puzzles.json contains exactly 25,000 unique valid puzzle records", () => {
  const data = JSON.parse(readFileSync("data/puzzles.json", "utf8"));
  assert.equal(data.puzzles.length, 25000, "contains exactly 25000 puzzles");

  const ids = new Set();
  const fens = new Set();
  const themes = new Set();
  const diffs = new Set();

  for (const p of data.puzzles) {
    assert.ok(p.id, "puzzle has id");
    assert.ok(!ids.has(p.id), "puzzle ID is unique: " + p.id);
    ids.add(p.id);

    assert.ok(p.fen, "puzzle has fen");
    assert.ok(!fens.has(p.fen), "puzzle FEN position is unique");
    fens.add(p.fen);

    assert.ok(Array.isArray(p.moves) && p.moves.length > 0, "puzzle has moves array");

    // Validate position and solution move legality using lib/chess.js
    const chess = new Chess(p.fen);
    for (const m of p.moves) {
      const res = chess.move({
        from: m.slice(0, 2),
        to: m.slice(2, 4),
        promotion: m.slice(4, 5) || undefined,
      });
      assert.ok(res, `Move ${m} is legal in position ${p.fen} for puzzle ${p.id}`);
    }

    assert.ok(p.theme, "puzzle has theme");
    themes.add(p.theme);

    assert.ok(p.difficulty, "puzzle has difficulty");
    diffs.add(p.difficulty);
  }

  assert.equal(ids.size, 25000, "all 25,000 puzzle IDs are unique");
  assert.equal(fens.size, 25000, "all 25,000 puzzle FEN positions are unique");
  assert.equal(themes.size, 12, "all 12 required puzzle themes are present");
  assert.equal(diffs.size, 3, "all 3 difficulty bands are present");
});

test("puzzles.mjs correctly detects invalid solution moves", () => {
  const chess = new Chess();
  const moves = chess.moves({ verbose: true });
  const isIllegal = !moves.some((m) => m.from === "e2" && m.to === "e5");
  assert.ok(isIllegal, "e2e5 is an illegal move from starting position");
});

test("puzzles.js defines PuzzleManager and themes", () => {
  const code = readFileSync("puzzles.js", "utf8");
  assert.ok(code.includes("PuzzleManager"), "defines PuzzleManager class");
  assert.ok(code.includes("PUZZLE_THEMES"), "defines PUZZLE_THEMES");
  assert.ok(code.includes("DIFFICULTY_BANDS"), "defines DIFFICULTY_BANDS");
});
