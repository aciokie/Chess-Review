// Parent injection is synchronous and worker-local. Each stage receives the exact
// earlier result for identical controls; changed inputs retain their original
// parent behavior. Direct calls retain the
// original research parent behavior for concordance tests.
let base = null, endpoint = null;
export const stagedParent = (original, input) => base && JSON.stringify(input) === endpoint ? base : original(input);
export function withConceptParent(result, run, input) {
  if (base) throw Error('Nested concept stage');
  base = result; endpoint = JSON.stringify(input);
  try { return run(); } finally { base = null; endpoint = null; }
}
