import {THEME_NAMES} from './content.js';

// Count finished attempts, not wrong moves. A retry can contain several wrong
// moves but still contributes only one result to each of its puzzle's types.
export function puzzleStatistics(progress, puzzles) {
  const types = Object.entries(THEME_NAMES).map(([theme,name])=>({theme,name,attempts:0,clean:0}));
  const byTheme = new Map(types.map(type=>[type.theme,type]));
  let attempts=0,clean=0;
  for (const puzzle of puzzles) {
    const record=progress.puzzles[puzzle.id];
    if (!record) continue;
    const count=Number.isSafeInteger(record.attempts)&&record.attempts>0?record.attempts:0;
    const solved=Number.isSafeInteger(record.clean)&&record.clean>0?Math.min(count,record.clean):0;
    attempts+=count;clean+=solved;
    for (const theme of new Set(puzzle.themes)) {
      const type=byTheme.get(theme);
      if (type) {type.attempts+=count;type.clean+=solved;}
    }
  }
  for (const type of types) {
    type.needsWork=type.attempts-type.clean;
    type.rate=type.attempts?type.clean/type.attempts:null;
  }
  types.sort((a,b)=>(a.rate===null)-(b.rate===null)||(b.rate??0)-(a.rate??0)||b.attempts-a.attempts||a.name.localeCompare(b.name));
  // A single result isn't a pattern. Highlights need at least three attempts;
  // equally performing types aren't presented as opposing strengths/weaknesses.
  const established=types.filter(type=>type.attempts>=3);
  const weakest=[...established].sort((a,b)=>a.rate-b.rate||b.attempts-a.attempts||a.name.localeCompare(b.name))
    .find(type=>type.rate<1)||null;
  const strongest=established.find(type=>type.rate>0&&(!weakest||type.rate>weakest.rate))||null;
  return {attempts,clean,needsWork:attempts-clean,rate:attempts?clean/attempts:null,types,weakest,strongest};
}
