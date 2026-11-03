// Puzzle outcomes are separate from review grades: no engine category or score.
export function puzzleResultBadge(document, result) {
  const correct = result === 'correct';
  const label = correct ? 'Correct' : 'Incorrect';
  const badge = document.createElement('span');
  badge.className = 'sq-badge grade-badge puzzle-result-badge';
  badge.dataset.result = result;
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', label);
  badge.title = label;
  const vector = (tag, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const svg = vector('svg', {viewBox:'0 0 100 100', width:100, height:100, 'aria-hidden':'true'});
  svg.append(
    vector('circle', {cx:50, cy:50, r:49, fill:correct ? '#81b64c' : '#ee4a2f'}),
    vector('path', {d:correct ? 'M27 51 43 67 74 34' : 'M33 33 67 67 M67 33 33 67', fill:'none', stroke:'#fff', 'stroke-width':10, 'stroke-linecap':'round', 'stroke-linejoin':'round'}),
  );
  badge.append(svg);
  return badge;
}
