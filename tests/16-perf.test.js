// Performance guard. Establishes a baseline for the hot paths so
// future regressions in searchMemories, saveMemoryBulk, or the
// FTS+vector combine are caught at CI time. Numbers below were
// measured on the dev machine (Node 24, Windows 11, NVMe SSD) and
// are intentionally generous: the budgets are about "no surprise
// tenfold regression", not "this is the fastest possible path".
//
// Embeddings are disabled via _helpers.js (KIMI_MEMORY_EMBEDDINGS=off
// is the default), so the search path falls through to FTS5-only.
// That is the worst case for the SQL combine and the best case for
// the perType bucketing (no cosine to compute) — a useful lower
// bound. The same numbers should hold once embeddings are enabled,
// with the bulk of the extra cost on the encoder side which has
// its own timeout.
//
// Skipped by setting KIMI_MEMORY_PERF=off (default: on). On a
// loaded CI runner the budgets might be too tight; an operator can
// bump them by overriding the per-test constants below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  saveMemoryBulk,
  searchMemories,
  listMemories,
  memoryCounts,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey, canonicalizeRoot } from '../src/project-key.js';

const PERF = process.env.KIMI_MEMORY_PERF !== 'off';

// Budgets in milliseconds. Generous on purpose — these are CI
// regression guards, not microbenchmarks. Bump them in CI if a
// particular host is slower than the dev baseline.
const BUDGETS = {
  seed_5k_ms: 30_000,
  recall_5k_default_ms: 250,
  recall_5k_perType_ms: 500,
  list_5k_ms: 250,
  bulk_save_1k_ms: 3_000,
  single_save_ms: 50,
  count_5k_ms: 50,
};

function freshProject() {
  const home = mkTempHome();
  const cwd = canonicalizeRoot('C:/test/perf-5k');
  const key = deriveProjectKey(cwd);
  return { home, cwd, key, dbPath: projectDbPath(home, key) };
}

// 5000 mixed-type memories. The body uses a small vocabulary of
// common tokens (release, tabs, indent, deploy, lint) so the FTS
// index has real data to scan during the recall benchmarks.
function seedCorpus(db, key, n) {
  const types = ['semantic', 'procedural', 'working', 'episodic'];
  const tokens = ['release', 'tabs', 'indent', 'deploy', 'lint', 'review', 'format', 'test'];
  const items = [];
  for (let i = 0; i < n; i++) {
    const t = types[i % types.length];
    const w0 = tokens[i % tokens.length];
    const w1 = tokens[(i * 7) % tokens.length];
    const w2 = tokens[(i * 13) % tokens.length];
    items.push({
      type: t,
      title: `${t} note ${i} ${w0}`,
      content: `${t} body ${i}: ${w0} ${w1} ${w2} for the project context`,
      tags: [w0],
    });
  }
  // saveMemoryBulk keeps the seeding fast: one transaction for all
  // 5k rows instead of 5k individual writes.
  saveMemoryBulk(db, key, items);
}

test('seed + single save: 5k corpus under the seed budget', { skip: !PERF }, () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const t0 = process.hrtime.bigint();
    seedCorpus(db, key, 5000);
    const seedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(
      seedMs < BUDGETS.seed_5k_ms,
      `5k seed took ${seedMs.toFixed(0)}ms (budget ${BUDGETS.seed_5k_ms}ms)`,
    );
    // Single save (the dominant case the agent hits) should be
    // quick — an extra save on top of 5k existing rows.
    const t1 = process.hrtime.bigint();
    saveMemory(db, key, {
      type: 'semantic',
      title: 'after-bench',
      content: 'a note added after the 5k seed',
    });
    const singleMs = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.ok(
      singleMs < BUDGETS.single_save_ms,
      `single save took ${singleMs.toFixed(1)}ms (budget ${BUDGETS.single_save_ms}ms)`,
    );
    closeDb();
  } finally {
    rmRf(home);
  }
});

test(
  'searchMemories: default (top-N FTS) under the recall budget on 5k',
  { skip: !PERF },
  async () => {
    const { home, key, dbPath } = freshProject();
    try {
      const db = openDb(dbPath);
      seedCorpus(db, key, 5000);
      // Warm up: first call materialises the FTS query plan.
      await searchMemories(db, key, 'release', { limit: 10 });
      const t0 = process.hrtime.bigint();
      const hits = await searchMemories(db, key, 'release', { limit: 10 });
      const recallMs = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(hits.length > 0, 'recall returns at least one hit on the seeded corpus');
      assert.ok(
        recallMs < BUDGETS.recall_5k_default_ms,
        `default recall took ${recallMs.toFixed(1)}ms (budget ${BUDGETS.recall_5k_default_ms}ms)`,
      );
      closeDb();
    } finally {
      rmRf(home);
    }
  },
);

test(
  'searchMemories: perType (balanced) under the recall budget on 5k',
  { skip: !PERF },
  async () => {
    const { home, key, dbPath } = freshProject();
    try {
      const db = openDb(dbPath);
      seedCorpus(db, key, 5000);
      // Warm up. Use a token that lands in every type so perType has
      // a balanced set to pick from; "release" appears in every
      // seeded row's content.
      await searchMemories(db, key, 'release', { limit: 10, perType: true, perTypeLimit: 2 });
      const t0 = process.hrtime.bigint();
      const hits = await searchMemories(db, key, 'release', {
        limit: 10,
        perType: true,
        perTypeLimit: 2,
      });
      const recallMs = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(hits.length > 0, 'perType recall returns at least one hit');
      // perType widens the FTS LIMIT (max(limit*5, 100)) and runs the
      // bucketing pass. Generous budget for the wider scan.
      assert.ok(
        recallMs < BUDGETS.recall_5k_perType_ms,
        `perType recall took ${recallMs.toFixed(1)}ms (budget ${BUDGETS.recall_5k_perType_ms}ms)`,
      );
      // The perType correctness properties (balance across types,
      // per-type cap) are exhaustively covered by the per-type tests
      // in tests/13-recall-per-type.test.js. Here we only assert that
      // hits landed, not what they look like — the perf test is
      // about latency, not semantics.
      closeDb();
    } finally {
      rmRf(home);
    }
  },
);

test('listMemories + memoryCounts: linear over 5k, under the budget', { skip: !PERF }, () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    seedCorpus(db, key, 5000);
    // Warm up.
    listMemories(db, key, { limit: 10 });
    memoryCounts(db, key);
    // listMemories caps at 500 rows per call (a hard cap in the
    // helper to keep the result set bounded). To exercise the
    // 5k-row scan we page through the result 10x with limit=500.
    const t0 = process.hrtime.bigint();
    let total = 0;
    for (let offset = 0; offset < 5000; offset += 500) {
      total += listMemories(db, key, { limit: 500, offset }).length;
    }
    const listMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(total, 5000, 'paged list returns all 5k rows');
    assert.ok(
      listMs < BUDGETS.list_5k_ms,
      `paged list 5k took ${listMs.toFixed(1)}ms (budget ${BUDGETS.list_5k_ms}ms)`,
    );
    const t1 = process.hrtime.bigint();
    const counts = memoryCounts(db, key);
    const countMs = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.equal(counts.active, 5000, 'memoryCounts.active = 5000');
    assert.ok(
      countMs < BUDGETS.count_5k_ms,
      `memoryCounts took ${countMs.toFixed(1)}ms (budget ${BUDGETS.count_5k_ms}ms)`,
    );
    closeDb();
  } finally {
    rmRf(home);
  }
});

test('saveMemoryBulk: 1k atomic save under the bulk budget', { skip: !PERF }, () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const items = Array.from({ length: 1000 }, (_, i) => ({
      type: 'semantic',
      title: `bulk ${i}`,
      content: `bulk body ${i}: release and tests`,
    }));
    // Warm up: a tiny bulk so the prepared-statement cache is hot.
    // The warmup uses distinct titles from the real save so the
    // supersede logic does not retire the warmup rows.
    const warmup = Array.from({ length: 5 }, (_, i) => ({
      type: 'semantic',
      title: `warmup ${i}`,
      content: 'warmup body',
    }));
    saveMemoryBulk(db, key, warmup);
    const t0 = process.hrtime.bigint();
    saveMemoryBulk(db, key, items);
    const bulkMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(
      bulkMs < BUDGETS.bulk_save_1k_ms,
      `1k bulk save took ${bulkMs.toFixed(0)}ms (budget ${BUDGETS.bulk_save_1k_ms}ms)`,
    );
    // And it really persisted: memoryCounts reports the full 1k
    // plus the 5 warmup rows. listMemories caps at 500 per page
    // so use the count.
    const counts = memoryCounts(db, key);
    assert.equal(counts.active, 1005, 'all 1k rows + 5 warmup rows landed');
    closeDb();
  } finally {
    rmRf(home);
  }
});
