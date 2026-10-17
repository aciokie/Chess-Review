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
    ideas.push({ type: "tactical", name: "Material Capture / Exchange", evidence: `Move ${san} removes enemy material from the target square.` });
  }
  if (san && san.includes("+")) {
    ideas.push({ type: "tactical", name: "Check / King Attack", evidence: `Move ${san} delivers a direct check against the king.` });
  }
  if (san && (san.includes("N") || san.includes("B"))) {
    ideas.push({ type: "positional", name: "Outpost / Minor Piece Activation", evidence: `Move ${san} improves minor piece scope and outpost presence.` });
  }
  if (san && (san.includes("R") || san.includes("Q"))) {
    ideas.push({ type: "positional", name: "Open File & Heavy Piece Pressure", evidence: `Move ${san} exerts pressure along open corridors.` });
  }
  if (ideas.length === 0) {
    ideas.push({ type: "positional", name: "Positional Consolidation", evidence: "Solidifies pawn structure and harmonizes piece coordination." });
  }
  return ideas;
}
