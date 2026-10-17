import {CONCEPT_VERSION} from './profile.js';
import {INTEGRATION_FINGERPRINT} from './integration-profile.js';

export const conceptKey = input => JSON.stringify([CONCEPT_VERSION, INTEGRATION_FINGERPRINT, input]);
const empty = () => ({findings: [], issues: [], unavailable: [], errors: [], timeMs: 0});

// Single isolated worker, bounded jobs, history-sensitive reuse. Disabled means no worker.
export class ConceptSession {
  constructor({worker = () => new Worker(new URL('./worker.js', import.meta.url), {type: 'module'}),
    changed = () => {}, demandOnly = false, timeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    Object.assign(this, {factory: worker, changed, timeoutMs, demandOnly});
    // Native Window timer methods must not receive this session as their receiver.
    this.setTimer = (fn, ms) => setTimer(fn, ms);
    this.clearTimer = id => clearTimer(id);
    this.cache = new Map(); this.entries = new Map(); this.enabled = false; this.queue = [];
  }
  configure(inputs, enabled) {
    if (!enabled && this.active) {
      const active = this.entries.get(this.active);
      active.timeMs = Math.max(active.timeMs, performance.now() - this.started); active.status = 'paused';
    }
    this.stop(); this.queue = []; this.enabled = enabled;
    if (!enabled) { this.changed(); return; }
    this.entries.clear();
    for (const input of inputs) this.include(input);
    this.changed(); this.next();
  }
  include(input, selected = false) {
    if (!this.enabled) return null;
    const key = conceptKey(input);
    if (!this.entries.has(key)) {
      const saved = this.cache.get(key);
      this.entries.set(key, saved ? {...saved, reused: true} : {...empty(), status: 'pending', input});
      if (!saved && (!this.demandOnly || selected)) this.queue.push(key);
    }
    if (selected && this.active && this.active !== key) {
      this.entries.get(this.active).status = 'paused';
      const previous = this.active; this.stop();
      this.queue = this.queue.filter(k => k !== previous);
    }
    const entry = this.entries.get(key);
    if (entry.status !== 'complete' && !this.queue.includes(key) && key !== this.active && (selected || !this.demandOnly)) this.queue.push(key);
    if (selected && this.queue.includes(key)) this.queue = [key, ...this.queue.filter(k => k !== key)];
    this.next(); return key;
  }
  cancelSelected() {
    if (this.active) this.entries.get(this.active).status = 'paused';
    this.stop(); this.queue = [];
  }
  stop() {
    this.clearTimer(this.timer); this.timer = null;
    this.worker?.terminate(); this.worker = null; this.active = null;
  }
  watch(key, message) {
    this.clearTimer(this.timer);
    const run = this.run;
    this.timer = this.setTimer(() => {
      if (this.active === key && this.run === run) this.fail(message, true);
    }, this.timeoutMs);
  }
  next() {
    if (!this.enabled || this.active || !this.queue.length) return;
    // A selected move may start before finish's queued yield executes. Cancel
    // that yield before arming the new watchdog so its handle cannot be lost.
    this.clearTimer(this.timer); this.timer = null; this.run = (this.run || 0) + 1;
    const key = this.queue.shift(), entry = this.entries.get(key);
    this.active = key; entry.status = 'running'; this.started = performance.now();
    try {
      if (!this.worker) {
        this.worker = this.factory(); const current = this.worker;
        this.worker.onmessage = ({data}) => {
          if (this.worker !== current || data.key !== this.active) return;
          const old = this.entries.get(data.key);
          if (data.phase === 'facts') old.firstResponseMs = performance.now() - this.started;
          Object.assign(old, data.result, {status: data.phase === 'complete' ? 'complete' : 'running'});
          if (data.phase === 'complete') this.finish(data.key);
          else {
            this.watch(data.key, 'Wall-clock budget exhausted; unfinished proof search abstained.');
            this.changed();
          }
        };
        this.worker.onerror = event => { if (this.worker === current) this.fail('Worker error: ' + (event.message || 'unavailable')); };
      }
      this.watch(key, 'Wall-clock budget exhausted; unfinished concept analysis abstained.');
      this.worker.postMessage({key, input: entry.input});
    } catch (error) { this.fail('Concept worker unavailable: ' + error.message); }
  }
  fail(message, budget = false) {
    const key = this.active;
    if (!key) return;
    const entry = this.entries.get(key);
    entry.errors.push(message); entry.timeMs = Math.max(entry.timeMs, performance.now() - this.started);
    if (budget) { entry.issues.push(message); entry.unavailable.push('Unfinished detectors unavailable after worker budget exhaustion.'); }
    this.worker?.terminate(); this.worker = null; this.finish(key);
  }
  finish(key) {
    this.clearTimer(this.timer); this.timer = null;
    const entry = this.entries.get(key); entry.status = 'complete';
    // Failure/timeouts are visible but retried on the next enabled session.
    if (!entry.errors.length) {
      const {input, ...saved} = entry; this.cache.set(key, saved);
      if (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value);
    }
    this.active = null; this.changed();
    // Yield after failure too, avoiding recursive startup failures across a long game.
    if (this.enabled) {
      const timer = this.setTimer(() => {
        if (this.timer !== timer) return;
        this.timer = null; this.next();
      }, 0);
      this.timer = timer;
    }
  }
  metrics(keys = [...this.entries.keys()]) {
    const entries = [...new Set(keys)].map(key => this.entries.get(key)).filter(Boolean);
    return {firstResponseMaxMs: Math.max(0,...entries.map(e=>e.firstResponseMs||0)), timeMs: entries.reduce((s, e) => s + e.timeMs, 0), processed: entries.filter(e => e.status === 'complete').length,
      total: entries.length, found: entries.reduce((s, e) => s + e.findings.length, 0), reused: entries.filter(e => e.reused).length,
      errors: entries.flatMap(e => e.errors), unavailable: entries.flatMap(e => e.unavailable), issues: entries.flatMap(e => e.issues)};
  }
}
