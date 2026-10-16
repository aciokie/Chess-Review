import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("detector-worker.js exists and handles messages", () => {
  const code = readFileSync("detector-worker.js", "utf8");
  assert.ok(code.includes("onmessage"), "handles onmessage");
  assert.ok(code.includes("detectIdeas"), "defines detectIdeas");
});

test("analysis.js includes Concepts panel and worker controls", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("showConceptsPanel"), "contains showConceptsPanel setting");
  assert.ok(code.includes("toggleConceptsWorker"), "contains toggleConceptsWorker");
  assert.ok(code.includes("renderConceptsPanel"), "contains renderConceptsPanel");
});
