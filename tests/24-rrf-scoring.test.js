// Tests for v10 Reciprocal Rank Fusion (RRF) scoring.
// Validates the pure combineRrfScores helper and confirms searchMemories
// uses RRF instead of the previous 0.5/0.5 weighted-sum blend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, combineRrfScores, saveMemory, searchMemories } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/rrf');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('combineRrfScores: pure math, both channels beat one channel', () => {
  const k = 60;
  // Both channels at rank 1 should beat a single channel at rank 1.
  const both = combineRrfScores({ ftsRank: 1, vecRank: 1, k });
  const onlyFts = combineRrfScores({ ftsRank: 1, vecRank: Number.POSITIVE_INFINITY, k });
  const onlyVec = combineRrfScores({ ftsRank: Number.POSITIVE_INFINITY, vecRank: 1, k });
  assert.ok(both > onlyFts, `both (${both}) > onlyFts (${onlyFts})`);
  assert.ok(both > onlyVec, `both (${both}) > onlyVec (${onlyVec})`);
  // both ~= 2/61 = 0.0328
  assert.ok(Math.abs(both - 2 / 61) < 1e-9);
  // onlyFts ~= 1/61
  assert.ok(Math.abs(onlyFts - 1 / 61) < 1e-9);
});

test('combineRrfScores: missing channel means Infinity and contributes 0', () => {
  const k = 60;
  // NaN guards: the helper must not throw on NaN / negative / 0.
  assert.equal(combineRrfScores({ ftsRank: Number.NaN, vecRank: 1, k }), 1 / (k + 1));
  assert.equal(combineRrfScores({ ftsRank: 1, vecRank: Number.NaN, k }), 1 / (k + 1));
  assert.equal(combineRrfScores({ ftsRank: 0, vecRank: 1, k }), 1 / (k + 1));
  assert.equal(combineRrfScores({ ftsRank: -5, vecRank: 1, k }), 1 / (k + 1));
});

test('combineRrfScores: rank ordering is respected within a channel', () => {
  const k = 60;
  // Rank 1 > rank 5 within the same channel.
  const rank1 = combineRrfScores({ ftsRank: 1, vecRank: Number.POSITIVE_INFINITY, k });
  const rank5 = combineRrfScores({ ftsRank: 5, vecRank: Number.POSITIVE_INFINITY, k });
  assert.ok(rank1 > rank5, `rank1 (${rank1}) > rank5 (${rank5})`);
});

test('combineRrfScores: k=10 sharpens the curve (top hits dominate)', () => {
  const kSharp = 10;
  const topSharp = combineRrfScores({ ftsRank: 1, vecRank: 1, k: kSharp });
  const deepSharp = combineRrfScores({ ftsRank: 50, vecRank: 50, k: kSharp });
  assert.ok(topSharp / deepSharp > 5, `topSharp / deepSharp = ${topSharp / deepSharp}`);
});

test('searchMemories: back-compat — minScore=0 returns every FTS candidate', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'Alpha doc', content: 'alpha keyword unique' });
    saveMemory(db, key, { type: 'semantic', title: 'Beta doc', content: 'beta keyword unique' });
    saveMemory(db, key, { type: 'semantic', title: 'Gamma doc', content: 'gamma keyword unique' });
    // With minScore=0 every candidate is included.
    const hits = await searchMemories(db, key, 'alpha', {
      limit: 10,
      minScore: 0,
      includeScore: true,
    });
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 1);
    // The matching row scores higher than the non-matching rows.
    const alphaHit = hits.find((h) => h.title === 'Alpha doc');
    assert.ok(alphaHit, 'Alpha doc must be in the result set');
    assert.ok(typeof alphaHit.score === 'number' && alphaHit.score > 0);
    // includeScore exposes the per-channel ranks.
    assert.equal(typeof alphaHit.fts_rank, 'number');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories: top match wins even when the FTS-only / vec-only scores differ', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Title contains the query token so FTS hits rank 1; the other rows have
    // a tokenized match only via body content and rank lower.
    saveMemory(db, key, { type: 'semantic', title: 'kimi memory', content: 'one body' });
    saveMemory(db, key, { type: 'semantic', title: 'memory note', content: 'kimi body' });
    saveMemory(db, key, { type: 'semantic', title: 'other', content: 'unrelated body' });
    const hits = await searchMemories(db, key, 'kimi', { limit: 5, includeScore: true });
    assert.ok(hits.length >= 1);
    // The first hit must be the row whose title contains 'kimi'.
    assert.match(hits[0].title, /kimi/i, `top hit title was: ${hits[0].title}`);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories: default minScore floor surfaces rank-1 hits', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'orchid', content: 'a flower' });
    saveMemory(db, key, { type: 'semantic', title: 'noise', content: 'unrelated' });
    const hits = await searchMemories(db, key, 'orchid', { limit: 5 });
    assert.equal(hits.length, 1, 'only the title-matching row should clear the RRF floor');
    assert.equal(hits[0].title, 'orchid');
  } finally {
    closeDb();
    rmRf(home);
  }
});
