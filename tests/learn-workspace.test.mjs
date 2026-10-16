import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("analysis.js includes Learn workspace modal and logic", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("openLearnWorkspace"), "contains openLearnWorkspace");
  assert.ok(code.includes("Concept Lessons"), "contains Concept Lessons text/reference");
  assert.ok(code.includes("Opening Courses"), "contains Opening Courses reference");
  assert.ok(code.includes("Timed Challenges"), "contains Timed Challenges reference");
});
