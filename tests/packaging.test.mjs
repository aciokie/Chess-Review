import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("packaging includes puzzles.js, detector-worker.js, and data/puzzles.json", async () => {
  const root = path.resolve(".");
  execFileSync("node", ["scripts/package.mjs"], { cwd: root, encoding: "utf8" });

  const latestReleaseRaw = await readFile(path.join(root, "web-ext-artifacts/latest-release.json"), "utf8");
  const latestRelease = JSON.parse(latestReleaseRaw);
  const recordRaw = await readFile(latestRelease.recordPath, "utf8");
  const record = JSON.parse(recordRaw);

  for (const pkg of record.packages) {
    const files = await readdir(pkg.sourceDir, { recursive: true });
    assert.ok(files.includes("puzzles.js"), `${pkg.browser} package contains puzzles.js`);
    assert.ok(files.includes("detector-worker.js"), `${pkg.browser} package contains detector-worker.js`);
    assert.ok(files.includes(path.join("data", "puzzles.json")), `${pkg.browser} package contains data/puzzles.json`);
  }
});
