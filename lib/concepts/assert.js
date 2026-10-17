// Browser assertion subset for the promoted plain-data certificate checkers.
// Fail closed. No Node runtime, test runner or external service is required.
export function isDeepStrictEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (ArrayBuffer.isView(a)) return a.constructor === b.constructor && a.byteLength === b.byteLength && new Uint8Array(a.buffer, a.byteOffset, a.byteLength).every((x,i) => x === new Uint8Array(b.buffer, b.byteOffset, b.byteLength)[i]);
  if (a instanceof Date) return Object.is(+a, +b);
  if (!Array.isArray(a) && ![Object.prototype, null].includes(Object.getPrototypeOf(a))) throw Error('Unsupported certificate object');
  const ka = Reflect.ownKeys(a), kb = Reflect.ownKeys(b);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && isDeepStrictEqual(a[k], b[k]));
}
const fail = message => { throw Error(message || 'Certificate assertion failed'); };
const assert = (value, message) => { if (!value) fail(message); };
assert.ok = assert; assert.fail = fail;
assert.equal = (a,b,m) => { if (!Object.is(a,b)) fail(m); };
assert.notEqual = (a,b,m) => { if (Object.is(a,b)) fail(m); };
assert.deepEqual = (a,b,m) => { if (!isDeepStrictEqual(a,b)) fail(m); };
assert.notDeepEqual = (a,b,m) => { if (isDeepStrictEqual(a,b)) fail(m); };
assert.match = (s,re,m) => { if (typeof s !== 'string' || !re.test(s)) fail(m); };
assert.doesNotMatch = (s,re,m) => { if (typeof s !== 'string' || re.test(s)) fail(m); };
assert.throws = (fn,re) => { let caught; try { fn(); } catch (e) { caught = e; } if (!caught || re && !re.test(caught.message)) fail(); };
export default assert;
