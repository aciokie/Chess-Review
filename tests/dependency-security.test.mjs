import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

// Development-only dependencies of web-ext. They are excluded from the browser
// store ZIPs, but a poisoned dev toolchain can still attack the build machine,
// so the patched versions are pinned and their fixes are asserted here.
// Port of upstream a5f2ff3c (the node-forge backport it also covers is not
// present in this fork, so only these two advisories apply).
const require = createRequire(import.meta.url);
const fxRequire = createRequire(require.resolve('fx-runner'));
const {quote, parse} = fxRequire('shell-quote');
const {SourceMapConsumer} = require('source-map-js');

test('Firefox runner quoting rejects line terminators after a comment token', () => {
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => quote(['echo', 'ok', {comment: 'x'}, `a${terminator}id;#`]), TypeError);
    assert.throws(() => quote(parse('echo http://example.com/#frag').concat(`a${terminator}id;#`)), TypeError);
  }
  assert.deepEqual(parse(quote(['firefox', '--profile', 'path with spaces'])),
    ['firefox', '--profile', 'path with spaces']);
});

test('indexed source maps reject excessive section offsets and preserve valid maps', () => {
  const map = {version: 3, sources: ['input.js'], names: [], mappings: 'AAAA'};
  const indexed = line => ({version: 3, sections: [{offset: {line, column: 0}, map}]});
  assert.throws(() => new SourceMapConsumer(indexed(1e12)), /Section offset line must not exceed/);
  const consumer = new SourceMapConsumer(indexed(1));
  assert.deepEqual(consumer.originalPositionFor({line: 2, column: 1}),
    {source: 'input.js', line: 1, column: 0, name: null});
});
