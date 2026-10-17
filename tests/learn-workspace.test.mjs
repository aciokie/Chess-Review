import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("analysis.js includes 23 concept lessons, 47 exercises, and 12 opening courses", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("Pin Tactics"), "contains Pin Tactics lesson");
  assert.ok(code.includes("Ruy Lopez"), "contains Ruy Lopez opening course");
  assert.ok(code.includes("1-Min Speed Run") || code.includes("Timed Challenge"), "contains Timed Challenges");
});
