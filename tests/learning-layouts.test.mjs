import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("analysis.js includes 5 learning layout options", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("learningLayout"), "contains learningLayout setting");
  assert.ok(code.includes("morph_in_place"), "contains morph_in_place");
  assert.ok(code.includes("studio_morph"), "contains studio_morph");
  assert.ok(code.includes("minimal_morph"), "contains minimal_morph");
  assert.ok(code.includes("board_morph"), "contains board_morph");
  assert.ok(code.includes("separate_page"), "contains separate_page");
});
