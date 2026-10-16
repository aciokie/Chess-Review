import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("styles.css defines CSS rules for all 5 learning layouts", () => {
  const css = readFileSync("styles.css", "utf8");
  assert.ok(css.includes(".stage.layout-morph-in-place"), "defines layout-morph-in-place");
  assert.ok(css.includes(".stage.layout-studio-morph"), "defines layout-studio-morph");
  assert.ok(css.includes(".stage.layout-minimal-morph"), "defines layout-minimal-morph");
  assert.ok(css.includes(".stage.layout-board-morph"), "defines layout-board-morph");
  assert.ok(css.includes(".stage.layout-separate-page"), "defines layout-separate-page");
});
