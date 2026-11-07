// Reference layout for the automatic (non-custom) analysis view.
//
// Adapted from upstream's Full HD reference pass (lib/full-hd-layout.js): instead of laying out a
// fixed 1832-px canvas and fitting it with browser tab zoom, the composition is computed for the
// actual viewport at 100% zoom. The board takes as much height as the window allows, and the panel
// column fills the remaining width, so the composition sits flush with the window (no page margins)
// while the panels' content stays at its design size instead of being scaled up.
//
// The numbers below are the design's own pixels — the same space as DEFAULT_LAYOUT in analysis.js
// (board module 822 x 934 with two 60 px player strips, panel column 606 wide, and so on).
export const DESIGN = {
  margin: 16,           // outer margin (top/right/bottom)
  padL: 44,             // left margin: keeps the board clear of the Library rail's tab
  topbar: 60,           // .topbar height in styles.css
  boardW: 822,          // board module width = board square side at scale 1
  boardH: 934,          // board module height (square + both player strips) at scale 1
  strip: 60,            // .player-strip height (--strip-h) at scale 1
  evalW: 56,            // eval-bar width (wide enough for its score labels)
  evalGap: 26,          // eval bar -> board gap
  sideGap: 34,          // board -> panel column gap
  sideW: 606,           // two panel columns + their gap at scale 1
  subGap: 12,           // gap between panel columns
  reviewH: 136,         // insight panel row
  graphH: 178,          // eval graph / engine row
  controlsH: 54,        // controls row
  rowGap: 12,           // vertical gap between panel rows
  minBoard: 300,        // never compose a smaller board than this
  minSide: 320,         // the panel area keeps at least this much width
  minScale: 0.92,       // board component scale floor (below this text stops being readable)
  maxScale: 2,          // board component scale ceiling
  sideFlexRatio: 584,   // fixed panel rows + the smallest useful move/accuracy row, per scale unit
  maxPanelScale: 1.05,  // panel content scale ceiling (a wide column gets room, not bigger text)
  minColScale: 0.75,    // panel content scale floor
};

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

// A box's content scale; anything missing or nonsensical renders unscaled.
export const panelScale = box => Number.isFinite(box?.scale) && box.scale >= .25 && box.scale <= 4 ? box.scale : 1;

// The composition values plus the resulting boxes.
function compose(width, height) {
  const D = DESIGN;
  if (!(width >= 1100) || !(height >= 520)) return null;
  const AW = width - D.padL - D.margin;          // usable width (from left gutter to right margin)
  const AH = height - D.topbar - 2 * D.margin;   // usable height
  if (AW < 640 || AH < 320) return null;

  // Board component scale: never below the readable floor, grows with the window height.
  const s = clamp(AH / D.boardH, D.minScale, D.maxScale);
  const strip = D.strip * s;
  const chromeW = (D.evalW + D.evalGap + D.sideGap) * s;

  // The board takes the height (and as much of the leftover width as that allows); the panel column
  // fills the rest, flush with the window.
  const boardW = Math.max(D.minBoard,
    Math.min(AH - 2 * strip, AW - chromeW - D.minSide));
  const boardH = boardW + 2 * strip;
  const sideW = Math.max(D.minSide, AW - chromeW - boardW);
  // The panels' content scale follows their own width up to a calm ceiling: a wide column gets
  // more room, not bigger text (that is what made the panels look oversized before).
  const panelColW = (sideW - D.subGap) / 2;
  const designColW = (D.sideW - D.subGap) / 2;
  const sg = clamp(Math.min(panelColW / designColW, AH / D.sideFlexRatio), D.minColScale, D.maxPanelScale);

  // Centre the composition; when it would start under the Library rail, move it right (keeping
  // at least `margin` on the far side).
  const totalW = chromeW + boardW + sideW;
  let left = Math.round((width - totalW) / 2);
  if (left < D.padL) left = Math.min(D.padL, width - totalW - D.margin);
  left = Math.max(D.margin, left);
  const top = Math.round(D.margin + Math.max(0, (AH - boardH) / 2));

  const r = Math.round;
  const evalX = left;
  const boardX = left + (D.evalW + D.evalGap) * s;
  const sideX = boardX + boardW + D.sideGap * s;
  const gap = D.rowGap * sg;
  const subGap = D.subGap * sg;
  const upper = (sideW - subGap) / 2;
  // Review on top, then the flexible middle row (moves | accuracy), the graph/engine row (the graph
  // sits directly under the move list) and the full-width controls row.
  const reviewH = D.reviewH * sg;
  const middleY = top + reviewH + gap;
  const flex = boardH - (D.reviewH + D.graphH + D.controlsH + 3 * D.rowGap) * sg;
  const bottomY = middleY + flex + gap;
  const controlsY = bottomY + D.graphH * sg + gap;
  // The portrait is a floating overlay, but it must stay inside the insight panel's own box: its
  // height is bounded by that row, and its width follows the portrait's aspect.
  const coachH = Math.round(reviewH);
  const coachW = Math.round(coachH * 1.05);
  // Whole-pixel boxes: fractional module sizes leave sub-pixel seams between rows.
  const box = (x, y, w, h, scale) => ({ x: r(x), y: r(y), w: r(w), h: r(h), scale });

  return {
    board:    box(boardX, top, boardW, boardH, s),
    evalbar:  box(evalX, top + strip, D.evalW * s, boardW, s),
    coach:    box(sideX + sideW - coachW, top, coachW, coachH, sg),
    review:   box(sideX, top, sideW, reviewH, sg),
    moves:    box(sideX, middleY, upper, flex, sg),
    accuracy: box(sideX + upper + subGap, middleY, upper, flex, sg),
    graph:    box(sideX, bottomY, upper, D.graphH * sg, sg),
    engine:   box(sideX + upper + subGap, bottomY, upper, D.graphH * sg, sg),
    controls: box(sideX, controlsY, sideW, D.controlsH * sg, sg),
  };
}

/**
 * Compose the automatic layout for a viewport.
 * @param {number} width  viewport width (CSS px, i.e. window.innerWidth)
 * @param {number} height viewport height (CSS px, i.e. window.innerHeight)
 * @returns {Record<string, {x:number,y:number,w:number,h:number,scale:number}>|null}
 *   Boxes in stage-local pixels (the stage starts right below the top bar), or null when the
 *   window is too small — the caller then falls back to the responsive CSS grid.
 */
export function fullHdReferenceLayout(width, height) {
  return compose(width, height);
}
