// Group geometry for the Reorganize canvas (ported from upstream's lib/panel-layout.js).
// Pure functions: they take a layout of { x, y, w, h, scale } boxes and return a new layout,
// so a gesture can apply them to the boxes it froze when it began and every pointer move
// recomputes from that frozen start instead of accumulating rounding errors.
import { panelScale } from "./full-hd-layout.js";

/** Union box of the named panels, or null when none of them is placed. */
export function panelGroupBounds(layout, keys) {
  const boxes = keys.map((key) => layout[key]).filter(Boolean);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** Scale a group about its own top-left corner. Each box keeps its offset ratio; the content
 *  scale (what actually shrinks the panel's text/controls) is clamped to the same 0.25–4 range
 *  panelScale accepts, and the scale factor itself is limited so no member leaves that range. */
export function scalePanelGroup(layout, keys, factor) {
  const bounds = panelGroupBounds(layout, keys), out = { ...layout };
  if (!bounds || !Number.isFinite(factor)) return out;
  const scales = keys.filter((key) => layout[key]).map((key) => panelScale(layout[key]));
  factor = Math.max(Math.max(...scales.map((scale) => .25 / scale)), Math.min(Math.min(...scales.map((scale) => 4 / scale)), factor));
  for (const key of keys) {
    const b = layout[key]; if (!b) continue;
    out[key] = { ...b, x: bounds.x + (b.x - bounds.x) * factor, y: bounds.y + (b.y - bounds.y) * factor,
      w: b.w * factor, h: b.h * factor, scale: Math.max(.25, Math.min(4, panelScale(b) * factor)) };
  }
  return out;
}

/** Move a group by a delta, never letting its union box cross the canvas origin. */
export function movePanelGroup(layout, keys, dx, dy) {
  const bounds = panelGroupBounds(layout, keys), out = { ...layout };
  if (!bounds) return out;
  dx = Math.max(-bounds.x, dx); dy = Math.max(-bounds.y, dy);
  for (const key of keys) if (layout[key]) out[key] = { ...layout[key], x: layout[key].x + dx, y: layout[key].y + dy };
  return out;
}
