// Prototype-pollution regression for src/toml.js.
//
// parseToml built its section tree by assigning through `node[parts[i]]`
// on plain objects, so a `[__proto__]` header made `node` become
// Object.prototype and every following line wrote an own property onto
// it: parseToml('[__proto__]\npolluted=1\n') set `({}).polluted === 1`,
// process-wide, from a file on disk — config.toml is read on every
// auto-extract pass. The parse now drops chain-walking names and writes
// through Object.defineProperty, which creates an own data property and
// can never reach a setter inherited from the chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../src/toml.js';

test('parseToml: a [__proto__] header cannot pollute Object.prototype', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const out = parseToml('[__proto__]\npolluted=1\n');

  assert.equal({}.polluted, undefined, 'a fresh object must not inherit the key');
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.prototype).sort(),
    before,
    'Object.prototype must gain no own property',
  );
  // The section has no addressable path, so it is dropped rather than
  // invented. The `polluted=1` line then lands as a plain top-level key
  // of the returned object — the same thing a table-less assignment at
  // the top of the file does — and not on the prototype chain.
  assert.deepEqual(out, { polluted: 1 });
  assert.ok(Object.prototype.hasOwnProperty.call(out, 'polluted'));
});

test('parseToml: constructor / prototype are dropped as keys and as header segments', () => {
  const out = parseToml('constructor = 1\n[prototype]\nx = 1\n');
  // The top-level `constructor` assignment is dropped, and the
  // `[prototype]` header is dropped with it (so `x` lands at top level
  // rather than becoming a property of Object.prototype).
  assert.deepEqual(out, { x: 1 });
  assert.equal(Object.prototype.x, undefined);
});

test('parseToml: an unsafe segment inside a dotted header is dropped, the rest nests', () => {
  const out = parseToml('[a.__proto__.b]\nx=1\n');

  assert.deepEqual(out, { a: { b: { x: 1 } } });
  assert.ok(Object.prototype.hasOwnProperty.call(out, 'a'), 'a is an own property of the result');
  // Before the fix this path walked into Object.prototype and wrote `b`
  // (then `b.x`) onto it.
  assert.equal(Object.prototype.b, undefined);
});

test('parseToml: a quoted "__proto__" is dropped too, and the prototype stays clean', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const out = parseToml('["__proto__"]\npolluted=1\n');

  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.deepEqual(out, { polluted: 1 });
});

test('parseToml: a quoted segment keeps a literal dot and still nests', () => {
  const out = parseToml('[models."a.b"]\nc=2\n');
  assert.deepEqual(out, { models: { 'a.b': { c: 2 } } });
  // The quoted segment is ONE key, so the dot inside it is not a path
  // split and nothing is written into a nested `models.a`.
  assert.deepEqual(Object.keys(out.models), ['a.b']);
});
