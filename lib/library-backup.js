// lib/library-backup.js - pure export/import for the local Library and settings.
// A backup is a small, human-readable JSON snapshot of the keys the analyzer owns. Per-game
// analysis caches ("analysis:<id>") and the fetched-game cache ("gamecache:<...>") are deliberately
// EXCLUDED: they are large and are rebuilt on demand (re-analyzing an imported game), so a backup
// stays a few hundred KB even with a thousand games. No storage, DOM or network access happens
// here, so every helper runs directly in Node (see tests/library-backup.test.mjs).

import { libraryRecords } from "./progress.js";

export const BACKUP_FORMAT = "chess-review-backup";
export const BACKUP_VERSION = 1;

// The keys a backup carries. "library" and "settings" are the important ones; the rest keep the
// restore faithful (your handle, saved layout and the inferred-account history).
export const BACKUP_KEYS = ["library", "settings", "username", "layout", "layoutMode", "layoutVersion", "playerHistory:v1"];

const asNumber = (value) => {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

/** Snapshot the given storage keys into a versioned backup object (missing keys are simply absent). */
export function createBackup(store, { now = Date.now() } = {}) {
  const data = {};
  for (const key of BACKUP_KEYS) if (store?.[key] !== undefined) data[key] = store[key];
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), data };
}

/**
 * Validate and normalize a backup file's text. Returns { ok: true, backup } or { ok: false, error }
 * with a message safe to show the user. The library is filtered to real records so a corrupted or
 * hand-edited file can never inject junk into storage.
 */
export function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "That file is not valid JSON." }; }
  if (!raw || typeof raw !== "object" || raw.format !== BACKUP_FORMAT) {
    return { ok: false, error: "That is not a Chess Review backup file." };
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    return { ok: false, error: "That backup is missing its version." };
  }
  if (raw.version > BACKUP_VERSION) {
    return { ok: false, error: `That backup was made by a newer version (v${raw.version}).` };
  }
  const source = raw.data && typeof raw.data === "object" ? raw.data : {};
  return { ok: true, backup: { ...raw, data: { ...source, library: libraryRecords(source.library) } } };
}

/** Counts for the import confirmation. */
export function backupSummary(backup) {
  const data = backup?.data || {};
  return {
    games: libraryRecords(data.library).length,
    hasSettings: !!data.settings,
    hasPlayerHistory: !!(data["playerHistory:v1"] || data.playerHistory),
    exportedAt: typeof backup?.exportedAt === "string" ? backup.exportedAt : "",
  };
}

/**
 * Merge an imported library into the current one, keyed by game id. The copy with the newer
 * savedAt wins, so re-importing an older backup never rolls a record back. Newest games first, and
 * the list is capped at `limit` (mirrors LIBRARY_MAX in analysis.js) so an import cannot grow the
 * library past what the analyzer itself keeps.
 */
export function mergeLibraries(current, incoming, { limit = Infinity } = {}) {
  const byId = new Map();
  for (const rec of libraryRecords(current)) byId.set(rec.id, rec);
  let added = 0, updated = 0, unchanged = 0;
  for (const rec of libraryRecords(incoming)) {
    const prev = byId.get(rec.id);
    if (!prev) { byId.set(rec.id, rec); added++; continue; }
    if ((asNumber(rec.savedAt) ?? 0) > (asNumber(prev.savedAt) ?? 0)) { byId.set(rec.id, rec); updated++; }
    else unchanged++;
  }
  const library = [...byId.values()]
    .sort((a, b) => (asNumber(b.savedAt) ?? 0) - (asNumber(a.savedAt) ?? 0))
    .slice(0, limit);
  return { library, added, updated, unchanged };
}

/** Replace the library outright (used for "restore exactly"), still capped and newest-first. */
export function replaceLibrary(incoming, { limit = Infinity } = {}) {
  const library = libraryRecords(incoming)
    .slice()
    .sort((a, b) => (asNumber(b.savedAt) ?? 0) - (asNumber(a.savedAt) ?? 0))
    .slice(0, limit);
  return { library, added: library.length, updated: 0, unchanged: 0 };
}

/** The storage keys a backup would restore, filtered to the ones actually present in the file. */
export function restorableSettingsKeys(backup) {
  const data = backup?.data || {};
  return BACKUP_KEYS.filter((key) => key !== "library" && data[key] !== undefined);
}
