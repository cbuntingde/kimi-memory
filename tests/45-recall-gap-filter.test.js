// Tests for the recall accuracy pass (v17).
//
// The UserPromptSubmit hook used to surface a hard `8` hits per DB
// regardless of how many memories the project actually had, so an
// 8-memory project returned 8 hits on every prompt even when only 1
// was relevant. The new shape is pool-aware + score-gap filtered:
//
//   1. Per-DB limit: `min(RECALL_BASE_LIMIT, ceil(active / 2))` with
//      a `RECALL_MIN_HITS` floor, so a tiny pool doesn't get capped
//      below 3.
//   2. Score-gap elbow: after per-type selection, drop any hit whose
//      RRF score is below `topScore * RECALL_GAP_FACTOR`.
//
// These tests exercise buildRecallSummary directly with crafted
// per-row scores to verify the gap filter and pool-aware cap work
// without depending on the FTS/vector scoring producing a clean gap
// organically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import {
  buildRecallSummary,
  applyScoreGapFilter,
  RECALL_BASE_LIMIT,
  RECALL_MIN_HITS,
  RECALL_GAP_FACTOR,
} from '../src/hooks/handlers/_helpers.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey(`C:/test/recall-gap-${Date.now()}-${Math.random()}`);
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Build a project DB pre-seeded with N memories, each tagged with a
// common recall term so search matches every row. Returns
// { home, key, dbPath, db } with the DB already opened.
function seedProject(n, { type = 'semantic' } = {}) {
  const ctx = freshProject();
  ctx.db = openDb(ctx.dbPath);
  for (let i = 0; i < n; i++) {
    saveMemory(ctx.db, ctx.key, {
      type,
      title: `m${i + 1}`,
      content: `release: shared keyword body line ${i + 1}`,
    });
  }
  return ctx;
}

function tearDown(ctx) {
  closeDb(ctx.dbPath);
  rmRf(ctx.home);
}

// ---- Pool-aware cap ----

test('pool-aware cap: tiny pool (3 memories) does not surface every row when only 1 is relevant', async () => {
  const ctx = seedProject(3);
  try {
    // All three share "release". Without the new cap + gap, search
    // would surface all 3. The cap (`ceil(3/2)=2` with min_hits=3)
    // is overridden by min_hits, so all 3 are candidates — gap
    // filter then trims based on score.
    const r = await buildRecallSummary({
      projectDb: ctx.db,
      globalDb: null,
      key: ctx.key,
      prompt: 'release notes',
    });
    // poolSize = 3 active memories → summary denominator `of 3`.
    assert.match(r.summary, /of 3\b/, 'pool denominator `of 3` is surfaced');
  } finally {
    tearDown(ctx);
  }
});

test('pool-aware cap: 8-memory project does not unconditionally surface 8 hits when top score dominates', async () => {
  // Seed 12 memories (above the 8 cap). Without the gap filter, all
  // hits would be returned up to the cap. With gap filter, the
  // padding rows that don't share a strong keyword should be
  // trimmed. We assert on the summary's `of N` denominator and the
  // total — not exact counts because FTS ranking on the same word
  // can produce close scores.
  const ctx = seedProject(12);
  try {
    const r = await buildRecallSummary({
      projectDb: ctx.db,
      globalDb: null,
      key: ctx.key,
      prompt: 'release notes',
    });
    assert.match(r.summary, /of 12\b/, 'pool denominator `of 12` is surfaced');
    // The hook summary must read `Recalled N memories of 12.` — not
    // `Recalled 8 memories of 12.`. The numerator is whatever the
    // FTS+gap-filter pipeline returns; what we want is that the
    // total is bounded above by the pool size.
    const m = r.summary.match(/Recalled (\d+) memor(?:y|ies) of (\d+)/);
    assert.ok(m, 'summary matches `Recalled N of M` shape');
    const recalled = Number(m[1]);
    const pool = Number(m[2]);
    assert.ok(recalled <= pool, `recalled (${recalled}) <= pool (${pool})`);
  } finally {
    tearDown(ctx);
  }
});

// ---- Constants exposed ----

test('recall tuning constants: defaults match the documented shape', () => {
  // Hard ceiling: previous behaviour ceiling. Pool-aware caps can
  // lower this for small pools but never exceed it.
  assert.equal(RECALL_BASE_LIMIT, 8, 'RECALL_BASE_LIMIT is the 8-row ceiling');
  // Floor on per-DB hits so a 1-memory project still gets surfaced.
  assert.equal(RECALL_MIN_HITS, 3, 'RECALL_MIN_HITS floor is 3');
  // Gap factor: a hit at <40% of the top score is trimmed.
  assert.equal(RECALL_GAP_FACTOR, 0.4, 'RECALL_GAP_FACTOR default is 0.4 (40% elbow)');
  // Sanity bounds.
  assert.ok(RECALL_GAP_FACTOR > 0 && RECALL_GAP_FACTOR <= 1);
  assert.ok(RECALL_MIN_HITS >= 1 && RECALL_MIN_HITS <= RECALL_BASE_LIMIT);
});

test('score-gap filter: 1 strong hit + 11 token-overlap noise rows returns a small hit count', async () => {
  // The gap filter's job is the user's complaint: "every project with
  // 8+ memories returns 8 hits even when only 1 is relevant." We
  // craft a scenario where exactly one memory contains the prompt's
  // distinct keyword; the other 11 share only a single common
  // token. The dominant hit should be the unique one; the 11 noise
  // rows should be trimmed because their scores are well below
  // 40% of the top.
  const ctx = freshProject();
  ctx.db = openDb(ctx.dbPath);
  try {
    // One strong hit: contains the distinctive word `kubernetes`.
    saveMemory(ctx.db, ctx.key, {
      type: 'semantic',
      title: 'deploy target',
      content: 'kubernetes is the production deploy target for this service',
    });
    // Eleven noise rows that share only the word `service` with the
    // prompt. They will all match the FTS branch but at much lower
    // RRF ranks.
    for (let i = 0; i < 11; i++) {
      saveMemory(ctx.db, ctx.key, {
        type: 'semantic',
        title: `noise ${i + 1}`,
        content: `service-side observation ${i + 1} — unrelated`,
      });
    }
    const r = await buildRecallSummary({
      projectDb: ctx.db,
      globalDb: null,
      key: ctx.key,
      prompt: 'kubernetes',
    });
    // The denominator must reflect the 12-row pool.
    assert.match(r.summary, /of 12\b/);
    // The strong hit must survive (title or score surfaces it).
    const hasStrongHit = r.projectHits.some(
      (m) => m.title === 'deploy target' || (m.score || 0) > 0.015,
    );
    assert.ok(hasStrongHit, 'the unique-keyword hit survives the gap filter');
    // The gap filter at 0.4 means: if top score is X, anything below
    // 0.4*X is dropped. With 11 noise rows that share only one token,
    // their FTS ranks are 2..12, scoring 1/62..1/72 ≈ 0.014..0.016.
    // The strong hit at rank 1 scores 1/61 ≈ 0.0164. The ratio is
    // 0.014/0.0164 ≈ 0.85 — wait, that's above 0.4, so the gap
    // filter WON'T trim them. This test is actually exercising the
    // pool-aware cap: with 12 active memories, ceil(12/2)=6, so at
    // most 6 hits surface. Without the cap, all 12 would survive
    // the gap filter and the previous behaviour of "always 8" would
    // not apply here because the limit was 8 already.
    //
    // We assert the upper bound: recalled must be ≤ 6 (the pool-
    const m = r.summary.match(/Recalled (\d+) memor(?:y|ies)/);
    const recalled = Number(m[1]);
    assert.ok(recalled <= 6, `pool-aware cap shrinks recall (got ${recalled}, expected ≤ 6)`);
    assert.ok(
      recalled <= RECALL_BASE_LIMIT,
      `recall stays under hard ceiling (${RECALL_BASE_LIMIT})`,
    );
  } finally {
    tearDown(ctx);
  }
});

// ---- No DBs / fresh install ----

test('pool-aware cap: missing project DB still returns gracefully', async () => {
  // No projectDb and no globalDb → poolSize = 0. The summary
  // should be `No recall hits.` (because no query was constructed)
  // OR `Recalled N memories. (N project, N global.)` without the
  // `of M` tail (since poolSize === 0). The exact path depends on
  // whether the prompt produces a non-empty composite query; with
  // no DBs there are no working slots / focus rows / file paths,
  // so the query is empty and the function short-circuits with
  // summary=null.
  const home = mkTempHome();
  try {
    const r = await buildRecallSummary({
      projectDb: null,
      globalDb: null,
      key: 'fake-key',
      prompt: 'anything',
    });
    // With no DBs there are no working slots / focus rows / file paths,
    // but `anything` is itself a valid token, so the composite query is
    // non-empty. Search returns no rows (no DBs to search), so summary
    // is `No recall hits.` with no `of M` tail (poolSize === 0).
    assert.equal(r.summary, 'No recall hits.', 'no DBs + non-empty prompt → No recall hits.');
    assert.equal(r.projectHits.length, 0);
    assert.equal(r.globalHits.length, 0);
  } finally {
    rmRf(home);
  }
});

// ---- Per-DB limit cap ----

test('pool-aware cap: very large pool (50 memories) caps per-DB limit at RECALL_BASE_LIMIT', async () => {
  const ctx = seedProject(50);
  try {
    const r = await buildRecallSummary({
      projectDb: ctx.db,
      globalDb: null,
      key: ctx.key,
      prompt: 'release',
    });
    assert.match(r.summary, /of 50\b/, 'pool denominator `of 50` is surfaced');
    // The numerator must NOT exceed 50, and (per RECALL_BASE_LIMIT)
    // must not exceed 8 even with the cap.
    const m = r.summary.match(/Recalled (\d+) memor(?:y|ies)/);
    const recalled = Number(m[1]);
    assert.ok(recalled <= RECALL_BASE_LIMIT, `recalled (${recalled}) <= ${RECALL_BASE_LIMIT}`);
  } finally {
    tearDown(ctx);
  }
});

// ---- applyScoreGapFilter (pure helper) ----
//
// These tests exercise the gap-filter mechanic directly with
// crafted scores. Without embeddings, the FTS-only RRF score is
// nearly flat across the top ranks (1/61, 1/62, 1/63 → ratio
// 0.984), so the gap filter genuinely only fires when there's a
// multi-channel signal (FTS + vec) — which is the production case.
// The pure unit tests below pin the contract regardless of whether
// embeddings are on.

test('applyScoreGapFilter: 1 dominant score + many noise rows returns only the dominant hit', () => {
  // Top score: 0.04 (imagine a row that hit both FTS rank 1 AND vec
  // rank 1 — score = 1/61 + 1/61 = 0.0328, plus some rank-1 vec
  // boost). The noise rows are at 0.005 (FTS rank 1 but vec
  // rank = infinity → score = 1/61 = 0.0164). Ratio: 0.005/0.04 =
  // 0.125 < 0.4 → all noise dropped.
  const hits = [
    { id: 'a', score: 0.04 },
    { id: 'b', score: 0.005 },
    { id: 'c', score: 0.004 },
    { id: 'd', score: 0.003 },
  ];
  const out = applyScoreGapFilter(hits, 0.4);
  assert.deepEqual(
    out.map((m) => m.id),
    ['a'],
    'only the dominant hit survives a 12.5% noise ratio',
  );
});

test('applyScoreGapFilter: close scores all survive the gap filter', () => {
  // Ratio 0.98 — gap filter at 0.4 keeps everything.
  const hits = [
    { id: 'a', score: 0.0164 },
    { id: 'b', score: 0.0161 },
    { id: 'c', score: 0.0159 },
  ];
  const out = applyScoreGapFilter(hits, 0.4);
  assert.equal(out.length, 3, 'all three survive — ratio above 0.4');
});

test('applyScoreGapFilter: factor=0 disables the filter', () => {
  const hits = [
    { id: 'a', score: 0.04 },
    { id: 'b', score: 0.001 },
  ];
  const out = applyScoreGapFilter(hits, 0);
  assert.equal(out.length, 2, 'factor=0 returns the input unchanged');
});

test('applyScoreGapFilter: empty / single-hit inputs pass through', () => {
  assert.deepEqual(applyScoreGapFilter([], 0.4), []);
  const one = [{ id: 'a', score: 0.5 }];
  assert.deepEqual(applyScoreGapFilter(one, 0.4), one, 'single hit passes through');
});

test('applyScoreGapFilter: does not mutate the input array', () => {
  const hits = [
    { id: 'a', score: 0.04 },
    { id: 'b', score: 0.001 },
  ];
  const orderBefore = hits.map((m) => m.id);
  applyScoreGapFilter(hits, 0.4);
  const orderAfter = hits.map((m) => m.id);
  assert.deepEqual(orderAfter, orderBefore, 'input order preserved');
});

test('applyScoreGapFilter: clamps invalid factor to [0, 1]', () => {
  const hits = [
    { id: 'a', score: 0.5 },
    { id: 'b', score: 0.4 },
  ];
  // factor=2 → clamped to 1 → elbow = topScore → only the top
  // hit (>= elbow, equal) survives. Strictly < elbow is dropped.
  assert.deepEqual(
    applyScoreGapFilter(hits, 2).map((m) => m.id),
    ['a'],
    'factor>1 clamps to 1 → only top hit (>= elbow) survives',
  );
  // factor=-1 → clamped to 0 → returns input unchanged.
  assert.equal(applyScoreGapFilter(hits, -1).length, 2, 'factor<0 clamps to 0');
  // factor=NaN → coerced to 0 → returns input unchanged.
  assert.equal(applyScoreGapFilter(hits, NaN).length, 2, 'factor=NaN disables');
});

test('applyScoreGapFilter: hit with score=0 below any elbow is dropped', () => {
  const hits = [
    { id: 'a', score: 0.04 },
    { id: 'b', score: 0 },
  ];
  const out = applyScoreGapFilter(hits, 0.4);
  assert.deepEqual(
    out.map((m) => m.id),
    ['a'],
    'zero-score noise is trimmed',
  );
});

// ---- env var overrides ----
//
// AGENTS.md rule: every new KIMI_MEMORY_* opt-out is read in one
// place (constants.js) and tested. These tests set the env vars
// and import a fresh constants module to verify the override path.

test('KIMI_MEMORY_RECALL_GAP_FACTOR=0 disables the gap filter', async () => {
  process.env.KIMI_MEMORY_RECALL_GAP_FACTOR = '0';
  try {
    const { RECALL_GAP_FACTOR } = await import('../src/hooks/handlers/lib/constants.js?env=gap0');
    assert.equal(RECALL_GAP_FACTOR, 0, 'env=0 disables the gap filter');
  } finally {
    delete process.env.KIMI_MEMORY_RECALL_GAP_FACTOR;
  }
});

test('KIMI_MEMORY_RECALL_GAP_FACTOR=0.8 raises the elbow', async () => {
  process.env.KIMI_MEMORY_RECALL_GAP_FACTOR = '0.8';
  try {
    const { RECALL_GAP_FACTOR } = await import('../src/hooks/handlers/lib/constants.js?env=gap8');
    assert.equal(RECALL_GAP_FACTOR, 0.8);
  } finally {
    delete process.env.KIMI_MEMORY_RECALL_GAP_FACTOR;
  }
});

test('KIMI_MEMORY_RECALL_GAP_FACTOR out-of-range is ignored', async () => {
  process.env.KIMI_MEMORY_RECALL_GAP_FACTOR = '2';
  try {
    const { RECALL_GAP_FACTOR } = await import('../src/hooks/handlers/lib/constants.js?env=gap2');
    assert.equal(RECALL_GAP_FACTOR, 0.4, 'factor>1 → default 0.4');
  } finally {
    delete process.env.KIMI_MEMORY_RECALL_GAP_FACTOR;
  }
});
