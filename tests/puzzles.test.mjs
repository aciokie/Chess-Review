import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("data/puzzles.json contains exactly 25,000 unique valid puzzle records", () => {
  const data = JSON.parse(readFileSync("data/puzzles.json", "utf8"));
  assert.equal(data.puzzles.length, 25000, "contains exactly 25000 puzzles");
  const ids = new Set(data.puzzles.map((p) => p.id));
  assert.equal(ids.size, 25000, "all puzzle IDs are unique");
});

test("puzzles.js defines PuzzleManager and themes", () => {
  const code = readFileSync("puzzles.js", "utf8");
  assert.ok(code.includes("PuzzleManager"), "defines PuzzleManager class");
  assert.ok(code.includes("PUZZLE_THEMES"), "defines PUZZLE_THEMES");
  assert.ok(code.includes("DIFFICULTY_BANDS"), "defines DIFFICULTY_BANDS");
});
