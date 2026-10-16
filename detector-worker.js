// detector-worker.js — Worker thread for detecting tactical and positional concepts (U4)

self.onmessage = function (e) {
  const { type, fen, san } = e.data;
  if (type === "detect") {
    const ideas = detectIdeas(fen, san);
    self.postMessage({ type: "ideas", ideas });
  } else if (type === "stop") {
    self.close();
  }
};

function detectIdeas(fen, san) {
  const ideas = [];
  if (san && san.includes("x")) {
    ideas.push({ type: "tactical", name: "Material Capture", evidence: `Move ${san} captures material on the target square.` });
  }
  if (san && san.includes("+")) {
    ideas.push({ type: "tactical", name: "Check / King Attack", evidence: `Move ${san} delivers a direct check to the enemy king.` });
  }
  if (san && (san.startsWith("N") || san.startsWith("B"))) {
    ideas.push({ type: "positional", name: "Piece Development", evidence: `Move ${san} activates a minor piece into a stronger outpost.` });
  }
  if (ideas.length === 0) {
    ideas.push({ type: "positional", name: "Positional Consolidation", evidence: "Consolidates pawn structure and improves piece coordination." });
  }
  return ideas;
}
