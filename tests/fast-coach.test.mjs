import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("analysis.js contains fast coach reply logic focusing on lessons", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("Fast coach reply (U5)"), "contains fast coach reply marker/logic");
  assert.ok(code.includes("changed the position evaluation"), "contains explanation of move change");
  assert.ok(code.includes("Focus on piece safety and king activity"), "contains lesson focus");
});
