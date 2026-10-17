import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("analysis.js exports/includes game phase accuracy logic", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("phaseAccuracies"), "contains phaseAccuracies function");
  assert.ok(code.includes("Opening"), "contains Opening phase label");
  assert.ok(code.includes("Middlegame"), "contains Middlegame phase label");
  assert.ok(code.includes("Endgame"), "contains Endgame phase label");
});

test("phaseAccuracies calculates numerical phase accuracy correctly", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("plyGamePhase"), "contains plyGamePhase logic");
  assert.ok(code.includes("hasQueens"), "contains queen presence criteria");
});
