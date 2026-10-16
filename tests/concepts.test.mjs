import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("detector-worker.js analyzes position and move evidence", () => {
  const code = readFileSync("detector-worker.js", "utf8");
  assert.ok(code.includes("detectIdeas"), "defines detectIdeas");
  assert.ok(code.includes("Material Capture"), "detects captures");
  assert.ok(code.includes("Check / King Attack"), "detects checks");
});

test("analysis.js integrates concepts worker lifecycle and UI", () => {
  const code = readFileSync("analysis.js", "utf8");
  assert.ok(code.includes("toggleConceptsWorker"), "defines worker toggle");
  assert.ok(code.includes("renderConceptsPanel"), "defines concepts panel renderer");
});
