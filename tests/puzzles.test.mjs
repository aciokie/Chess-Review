import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("data/puzzles.json exists and contains puzzles", () => {
  const data = JSON.parse(readFileSync("data/puzzles.json", "utf8"));
  assert.ok(Array.isArray(data.puzzles), "puzzles array exists");
  assert.ok(data.puzzles.length > 0, "puzzles array is non-empty");
});

test("puzzles.js defines themes and manager class", () => {
  const code = readFileSync("puzzles.js", "utf8");
  assert.ok(code.includes("PuzzleManager"), "defines PuzzleManager class");
  assert.ok(code.includes("PUZZLE_THEMES"), "defines PUZZLE_THEMES array");
  assert.ok(code.includes("DIFFICULTY_BANDS"), "defines DIFFICULTY_BANDS array");
});
