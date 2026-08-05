// Comprehensive tests for kimi-memory improvements.
// Covers concurrency, error handling, search quality, and lifecycle management.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import modules under test
import { calculateBackoffMs, withRetry } from '../src/retry.js';
import {
  recordWriteStart,
  recordWriteEnd,
  getConcurrencyStatus,
  isSqliteBusyError,
} from '../src/concurrency.js';
import { normalizeFts5Query, buildTitleBoostedQuery, buildOrderByClause } from '../src/search.js';
import { getConversationsToArchive, getMemoriesToPrune, estimateDbSize } from '../src/lifecycle.js';
import { validateConfig, parseTomlLike, mergeConfigWithEnv } from '../src/config.js';

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

test('concurrency: track active writes', () => {
  const dbPath = '/test/db.sqlite';

  recordWriteStart(dbPath, 'insert_memory');
  let status = getConcurrencyStatus(dbPath);
  assert.equal(status.active_writes, 1, 'should track 1 active write');

  recordWriteStart(dbPath, 'save_bulk');
  status = getConcurrencyStatus(dbPath);
  assert.equal(status.active_writes, 2, 'should track 2 active writes');

  recordWriteEnd(dbPath, 'insert_memory', 100);
  status = getConcurrencyStatus(dbPath);
  assert.equal(status.active_writes, 1, 'should decrement to 1 active write');
});

test('concurrency: detect SQLITE_BUSY errors', () => {
  const error1 = new Error('database is locked');
  const error2 = new Error('SQLITE_BUSY');
  const error3 = new Error('other error');

  assert(isSqliteBusyError(error1), 'should detect "database is locked"');
  assert(isSqliteBusyError(error2), 'should detect SQLITE_BUSY');
  assert(!isSqliteBusyError(error3), 'should not detect other errors');
});

test('search: normalize FTS5 query', () => {
  const q1 = normalizeFts5Query('deployment process');
  assert(q1.includes('OR'), 'should handle multiple terms');

  const q2 = normalizeFts5Query('"exact phrase"');
  assert.equal(q2, '"exact phrase"', 'should preserve quoted phrases');

  const q3 = normalizeFts5Query('-exclude term');
  assert.equal(q3, '-exclude term', 'should preserve negation');
});

test('search: build title-boosted query', () => {
  const query = buildTitleBoostedQuery('deployment');
  assert(query.includes('title:'), 'should boost title matches');
  assert(query.includes('OR'), 'should fall back to general search');
});

test('search: build ORDER BY clauses', () => {
  const recent = buildOrderByClause('recent');
  const confidence = buildOrderByClause('confidence');
  const relevance = buildOrderByClause('relevance');

  assert(recent.includes('updated_at DESC'), 'recent should sort by date');
  assert(confidence.includes('confidence DESC'), 'confidence should sort by confidence');
  assert(relevance.includes('rank'), 'relevance should sort by rank');
});

test('lifecycle: identify conversations to archive', () => {
  const now = new Date();
  const old = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000); // 35 days old
  const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days old

  const conversations = [
    { id: '1', created_at: old.toISOString() },
    { id: '2', created_at: recent.toISOString() },
  ];

  const toArchive = getConversationsToArchive(conversations, 30);
  assert.equal(toArchive.length, 1, 'should identify 1 conversation for archival');
  assert.equal(toArchive[0].id, '1', 'should select the old conversation');
});

test('lifecycle: identify memories to prune', () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString(); // 95 days old

  const memories = [
    { id: '1', status: 'active', updated_at: now },
    { id: '2', status: 'deleted', updated_at: old },
    { id: '3', status: 'superseded', updated_at: old },
    { id: '4', status: 'active', expires_at: '2020-01-01T00:00:00Z' },
  ];

  const candidates = getMemoriesToPrune(memories, 90);
  assert.equal(candidates.length, 3, 'should identify 3 candidates');

  const reasons = candidates.map((c) => c.reason);
  assert(reasons.includes('deleted'), 'should include deleted memories');
  assert(reasons.includes('superseded'), 'should include superseded memories');
  assert(reasons.includes('expired'), 'should include expired memories');
});

test('lifecycle: estimate database size', () => {
  const estimate = estimateDbSize(1000, 500);
  assert(estimate.total_mb > 0, 'should calculate positive size');
  assert(
    estimate.total_bytes === estimate.memories + estimate.embeddings + estimate.indexes,
    'total should sum components',
  );
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

  const parsed = parseTomlLike(content);
  assert.equal(parsed.section1.key1, 'quoted string', 'should parse quoted strings');
  assert.equal(parsed.section1.key2, 'unquoted', 'should parse unquoted strings');
  assert.equal(parsed.section1.key3, true, 'should parse booleans');
  assert.equal(parsed.section1.key4, 42, 'should parse numbers');
  assert(Array.isArray(parsed.section1.key5), 'should parse arrays');
});

test('config: validate config with defaults', () => {
  const raw = {
    'kimi-memory': {
      disable_auto_extract: true,
      embed_timeout_ms: 8000,
    },
  };

  const result = validateConfig(raw);
  assert(result.ok, 'validation should succeed');
  assert.equal(result.value['kimi-memory'].disable_auto_extract, true);
  assert.equal(result.value['kimi-memory'].embed_timeout_ms, 8000);
});

test('config: merge with environment overrides', () => {
  const config = {
    'kimi-memory': {
      disable_auto_extract: false,
      embed_timeout_ms: 4000,
    },
  };

  const oldEnv = process.env.KIMI_MEMORY_AUTO_EXTRACT;
  try {
    process.env.KIMI_MEMORY_AUTO_EXTRACT = 'off';
    const merged = mergeConfigWithEnv(config);
    assert.equal(merged['kimi-memory'].disable_auto_extract, true, 'env should override');
  } finally {
    process.env.KIMI_MEMORY_AUTO_EXTRACT = oldEnv;
  }
});

test('concurrency stress: rapid writes', async () => {
  const dbPath = '/stress/test.db';
  const iterations = 100;

  // Simulate rapid concurrent writes
  for (let i = 0; i < iterations; i++) {
    recordWriteStart(dbPath, `write_${i}`);
  }

  let status = getConcurrencyStatus(dbPath);
  assert.equal(status.active_writes, iterations, `should track ${iterations} active writes`);

  // Simulate completions
  for (let i = 0; i < iterations; i++) {
    recordWriteEnd(dbPath, `write_${i}`, 10 + Math.random() * 50);
  }

  status = getConcurrencyStatus(dbPath);
  assert.equal(status.active_writes, 0, 'should clear all writes');
});

test('search: handle edge cases', () => {
  assert.equal(normalizeFts5Query(null), '', 'null query should be empty');
  assert.equal(normalizeFts5Query(''), '', 'empty query should be empty');
  assert.equal(normalizeFts5Query('   '), '', 'whitespace query should be empty');
});

test('config: handle invalid input', () => {
  const result = validateConfig(null);
  assert(result.ok, 'null config should use defaults');

  const result2 = validateConfig({});
  assert(result2.ok, 'empty config should use defaults');
});
