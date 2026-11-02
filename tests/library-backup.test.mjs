import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKUP_FORMAT, BACKUP_VERSION, createBackup, parseBackup, backupSummary,
  mergeLibraries, replaceLibrary, restorableSettingsKeys,
} from "../lib/library-backup.js";
import { libraryRecords } from "../lib/progress.js";

const rec = (over = {}) => ({ id: over.id || "g", savedAt: 1, myAcc: null, ...over });
const file = (data, extra = {}) => JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, ...extra, data });

test("createBackup snapshots only the keys the analyzer owns", () => {
  const backup = createBackup(
    { library: [rec({ id: "a" })], settings: { sound: false }, username: "me", layout: { x: 1 }, "unrelated:key": 1 },
    { now: Date.UTC(2026, 0, 2) });
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(backup.exportedAt, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(Object.keys(backup.data).sort(), ["layout", "library", "settings", "username"]);
  assert.equal(backup.data["unrelated:key"], undefined);
  assert.equal(createBackup(null).data.library, undefined);
});

test("parseBackup rejects non-JSON, foreign files, missing and newer versions", () => {
  assert.equal(parseBackup("{").ok, false);
  assert.match(parseBackup("{}").error, /not a Chess Review backup/);
  assert.match(parseBackup(JSON.stringify({ format: BACKUP_FORMAT, data: {} })).error, /missing its version/);
  assert.match(parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, data: {} })).error, /newer version/);
});

test("parseBackup sanitizes the library and summarizes the file", () => {
  const parsed = parseBackup(file({ library: [rec({ id: "a" }), null, {}, "x", 7], settings: { sound: false } },
    { exportedAt: "2026-01-01T00:00:00.000Z" }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.backup.data.library.map((r) => r.id), ["a"]);
  assert.deepEqual(backupSummary(parsed.backup),
    { games: 1, hasSettings: true, hasPlayerHistory: false, exportedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(backupSummary(null), { games: 0, hasSettings: false, hasPlayerHistory: false, exportedAt: "" });
});

test("mergeLibraries adds new games and keeps the newer copy of an existing one", () => {
  const current = [rec({ id: "a", savedAt: 10, myAcc: 70 }), rec({ id: "b", savedAt: 20, myAcc: 60 })];
  const incoming = [
    rec({ id: "a", savedAt: 30, myAcc: 90 }),   // newer -> wins
    rec({ id: "b", savedAt: 5, myAcc: 40 }),    // older -> ignored
    rec({ id: "c", savedAt: 40, myAcc: 80 }),   // new
  ];
  const { library, added, updated, unchanged } = mergeLibraries(current, incoming);
  assert.deepEqual({ added, updated, unchanged }, { added: 1, updated: 1, unchanged: 1 });
  assert.deepEqual(library.map((r) => r.id), ["c", "a", "b"]);   // newest first
  assert.equal(library.find((r) => r.id === "a").myAcc, 90);
  assert.equal(library.find((r) => r.id === "b").myAcc, 60);
});

test("an imported numeric id is coerced to a string so the game survives", () => {
  // Every other reader requires a string id (analysis.js and progress.js cleanLibrary), so a backup
  // carrying a numeric id used to be counted as imported and then silently dropped on the next read.
  const parsed = parseBackup(file({ library: [{ id: 7, savedAt: 1, pgn: "1. e4" }] }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.backup.data.library.map((r) => r.id), ["7"], "ids are strings everywhere else");
  assert.equal(backupSummary(parsed.backup).games, 1);
  const merged = mergeLibraries([], parsed.backup.data.library);
  assert.deepEqual(merged.library.map((r) => r.id), ["7"]);
  assert.equal(merged.library[0].pgn, "1. e4", "the rest of the record is untouched");
  assert.deepEqual(replaceLibrary(parsed.backup.data.library).library.map((r) => r.id), ["7"]);
  assert.equal(libraryRecords(merged.library).length, 1, "and it is a record for the Progress page");
});

test("a record whose id cannot be a string is still refused", () => {
  const incoming = [{ id: null, savedAt: 1 }, { id: {}, savedAt: 2 }, { id: NaN, savedAt: 3 }, { id: Infinity, savedAt: 4 }, { id: "", savedAt: 5 }];
  assert.deepEqual(mergeLibraries([], incoming).library, []);
  assert.deepEqual(replaceLibrary(incoming).library, []);
  assert.equal(backupSummary(parseBackup(file({ library: incoming })).backup).games, 0);
});

test("mergeLibraries caps the result and replaceLibrary restores exactly", () => {
  const incoming = [1, 2, 3, 4].map((n) => rec({ id: String(n), savedAt: n }));
  assert.equal(mergeLibraries([], incoming, { limit: 2 }).library.length, 2);
  assert.deepEqual(replaceLibrary(incoming, { limit: 3 }).library.map((r) => r.id), ["4", "3", "2"]);
  assert.deepEqual(replaceLibrary([null, "x", rec({ id: "z" })]).library.map((r) => r.id), ["z"]);
});

test("restorableSettingsKeys lists present non-library keys only", () => {
  assert.deepEqual(restorableSettingsKeys(createBackup({ library: [], settings: {}, username: "me" })).sort(), ["settings", "username"]);
  assert.deepEqual(restorableSettingsKeys(null), []);
});
