// Comprehensive tests for kimi-memory improvements.
// Covers error handling, search quality, and lifecycle management.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import modules under test
import { calculateBackoffMs } from '../src/retry.js';
import { normalizeFts5Query, buildTitleBoostedQuery } from '../src/search.js';
import { parseToml } from '../src/toml.js';

test('retry: exponential backoff with jitter', () => {
  // Test increasing delays
  const delay0 = calculateBackoffMs(0, 100, 10000, 0);
  const delay1 = calculateBackoffMs(1, 100, 10000, 0);
  const delay2 = calculateBackoffMs(2, 100, 10000, 0);

  assert(delay0 >= 90 && delay0 <= 110, 'delay0 should be ~100ms');
  assert(delay1 >= 190 && delay1 <= 210, 'delay1 should be ~200ms');
  assert(delay2 >= 390 && delay2 <= 410, 'delay2 should be ~400ms');
});

test('retry: respects max delay cap', () => {
  const delay = calculateBackoffMs(10, 100, 500, 0);
  assert(delay <= 500, 'delay should not exceed max');
});

test('search: normalize FTS5 query', () => {
  const q1 = normalizeFts5Query('deployment process');
  assert(q1.includes('OR'), 'should handle multiple terms');

  const q2 = normalizeFts5Query('"exact phrase"');
  assert.equal(q2, '"exact phrase"', 'should preserve quoted phrases');

  const q3 = normalizeFts5Query('-exclude term');
  // FTS5 doesn't accept a unary `-`; emit `NOT "..."` instead. An
  // all-negative query falls back to `"*"` as the positive side.
  // (Audit finding F-008.)
  assert.equal(q3, '"*" NOT "exclude term"', 'should emit FTS5 NOT clause');
});

test('search: build title-boosted query', () => {
  const query = buildTitleBoostedQuery('deployment');
  assert(query.includes('title:'), 'should boost title matches');
  assert(query.includes('OR'), 'should fall back to general search');
});

test('config: parse TOML-like values', () => {
  const content = `
[section1]
key1 = "quoted string"
key2 = unquoted
key3 = true
key4 = 42
key5 = [1, 2, 3]

[section2]
nested = "value"
# This is a comment
`;

  const parsed = parseToml(content);
  assert.equal(parsed.section1.key1, 'quoted string', 'should parse quoted strings');
  assert.equal(parsed.section1.key2, 'unquoted', 'should parse unquoted strings');
  assert.equal(parsed.section1.key3, true, 'should parse booleans');
  assert.equal(parsed.section1.key4, 42, 'should parse numbers');
  assert(Array.isArray(parsed.section1.key5), 'should parse arrays');
});

test('search: handle edge cases', () => {
  assert.equal(normalizeFts5Query(null), '', 'null query should be empty');
  assert.equal(normalizeFts5Query(''), '', 'empty query should be empty');
  assert.equal(normalizeFts5Query('   '), '', 'whitespace query should be empty');
});
