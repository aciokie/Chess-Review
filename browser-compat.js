// browser-compat.js — Firefox's `browser.*` namespace is Promise-native; Chrome's `chrome.*`
// namespace only gained Promise support under Manifest V3. Prefer the native `browser` global
// (Firefox/Zen) and fall back to `chrome` (Chrome/Chromium), so every `await browserAPI.x()` call
// resolves the same way in both. Falls through to `undefined` outside an extension context (e.g.
// the pure-Node tooling that imports gamecache.js).
const nativeAPI =
  typeof browser !== "undefined" ? browser
  : typeof chrome !== "undefined" ? chrome
  : undefined;

// Fallback storage backed by window.localStorage for standalone web/PWA mode
const localStoragePolyfill = {
  async get(key) {
    if (typeof localStorage === "undefined") return {};
    if (typeof key === "string") {
      try {
        const val = localStorage.getItem(key);
        return { [key]: val ? JSON.parse(val) : undefined };
      } catch {
        return {};
      }
    }
    if (Array.isArray(key)) {
      const res = {};
      for (const k of key) {
        try {
          const val = localStorage.getItem(k);
          if (val !== null) res[k] = JSON.parse(val);
        } catch {}
      }
      return res;
    }
    const res = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      try {
        res[k] = JSON.parse(localStorage.getItem(k));
      } catch {}
    }
    return res;
  },
  async set(values) {
    if (typeof localStorage === "undefined" || !values) return;
    for (const [k, v] of Object.entries(values)) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    }
  },
  async remove(keys) {
    if (typeof localStorage === "undefined" || !keys) return;
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      try {
        localStorage.removeItem(k);
      } catch {}
    }
  }
};

export const browserAPI = {
  runtime: {
    getURL: (path) => (nativeAPI?.runtime?.getURL ? nativeAPI.runtime.getURL(path) : path)
  },
  storage: {
    local: nativeAPI?.storage?.local || localStoragePolyfill
  },
  tabs: nativeAPI?.tabs
};
