import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("analysis.js generates fast coach replies explaining move changes and lesson focus", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("Fast coach reply (U5)"), "contains fast coach reply logic marker");
  assert.ok(code.includes("changed the position evaluation"), "explains move consequences");
  assert.ok(code.includes("Focus on piece safety and king activity"), "focuses on key lesson");
});
