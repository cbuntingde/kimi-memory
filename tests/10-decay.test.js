// Tests for the importance + decay primitives: reinforceMemory (a
// signal-driven bump that grows stability and stamps rehearsal) and
// decayMemories (an Ebbinghaus-curve rewrite of `confidence` based on
// stability_days and last_rehearsed_at). Both were upgraded in v9
// from a linear confidence scaling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf, StdioMcp } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  getMemory,
  listMemories,
  reinforceMemory,
  decayMemories,
  reinforceIfStale,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { retrievability, derivedConfidence, growStability } from '../src/decay.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/decay-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Stamp last_rehearsed_at to a specific UTC timestamp so we can test
// the decay math without waiting real time. The new model reads from
// last_rehearsed_at, not last_accessed_at.
function rehearsalAt(db, id, iso) {
  db.prepare(
    'UPDATE memories SET last_rehearsed_at=?, last_accessed_at=?, updated_at=? WHERE id=?',
  ).run(iso, iso, iso, id);
}

test('reinforceMemory: bumps access_count + last_accessed_at and nudges confidence by 0.05', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'tabs',
      content: 'use tabs',
      confidence: 0.5,
    });
    const r = reinforceMemory(db, key, m.id);
    assert.equal(r.access_count, 1);
    assert.ok(typeof r.last_accessed_at === 'string' && r.last_accessed_at.length > 0);
    assert.equal(r.confidence, 0.55, 'confidence nudged from 0.5 → 0.55');
    // A second call nudges again (capped at 1.0).
    const r2 = reinforceMemory(db, key, m.id);
    assert.equal(r2.access_count, 2);
    assert.ok(Math.abs(r2.confidence - 0.6) < 1e-6);
    // v9: each reinforce also stamps last_rehearsed_at and grows
    // stability_days by 1.5x.
    assert.ok(typeof r2.last_rehearsed_at === 'string');
    assert.ok(r2.stability_days >= 30 * 1.5 * 1.5 - 1e-6, `stability grew: ${r2.stability_days}`);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('reinforceMemory: caps confidence at 1.0; returns null on missing memory', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'tabs',
      content: 'use tabs',
      confidence: 0.98,
    });
    const r = reinforceMemory(db, key, m.id);
    assert.equal(r.confidence, 1.0, 'capped at 1.0');
    assert.equal(reinforceMemory(db, key, 'no-such-id'), null);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('reinforceMemory: only operates on active rows; soft-deleted memories are not bumped', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 'tabs', content: 'use tabs' });
    db.prepare("UPDATE memories SET status='deleted' WHERE id=?").run(m.id);
    const r = reinforceMemory(db, key, m.id);
    assert.equal(r, null, 'a deleted memory is not reinforced');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('reinforceIfStale: debounces within 60s, fires after', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'hot',
      content: 'in flight',
      confidence: 0.5,
    });
    // First call: rehearsal is fresh, so the debounced variant is a
    // no-op (returns current row, doesn't bump confidence).
    const r1 = reinforceIfStale(db, key, m.id, { debounceMs: 60_000 });
    assert.equal(r1.confidence, 0.5);
    // Manually rewind last_rehearsed_at to before the debounce window.
    const longAgo = new Date(Date.now() - 120 * 1000).toISOString();
    db.prepare('UPDATE memories SET last_rehearsed_at=? WHERE id=?').run(longAgo, m.id);
    const r2 = reinforceIfStale(db, key, m.id, { debounceMs: 60_000 });
    assert.equal(r2.confidence, 0.55, 'after debounce window, confidence nudged');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('decayMemories: no-op when every memory is fresh', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Set confidence to 1.0 so the row is already at the curve — a
    // fresh rehearsal derives confidence ≈ 1.0, so the rewrite would
    // be a no-op. (Saving at 0.9 would be rewritten upward; that's a
    // different test below.)
    saveMemory(db, key, {
      type: 'semantic',
      title: 'fresh',
      content: 'just saved',
      confidence: 1.0,
    });
    const r = decayMemories(db, key);
    assert.equal(r.scanned, 1, 'one row scanned');
    assert.equal(r.rewritten, 0, 'fresh row stays at the curve (already ≈1.0)');
    const after = listMemories(db, key, {})[0];
    assert.ok(after.confidence >= 0.99, `fresh memory stays near 1.0, got ${after.confidence}`);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('decayMemories: bumps a fresh memory upward when its stored confidence is below the curve', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'fresh-but-low',
      content: 'just saved',
      confidence: 0.5,
    });
    const r = decayMemories(db, key);
    // R ≈ 1.0 → derived ≈ 1.0 → 0.5 is well below the curve → rewrite.
    assert.equal(r.scanned, 1);
    assert.equal(r.rewritten, 1, 'row rewritten upward to the curve');
    const after = listMemories(db, key, {})[0];
    assert.ok(after.confidence >= 0.99);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('decayMemories: drops confidence on rows that have been idle >30 days', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'old',
      content: 'ancient',
      confidence: 0.8,
    });
    const longAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    rehearsalAt(db, m.id, longAgo);
    const r = decayMemories(db, key);
    assert.equal(r.scanned, 1, 'one row scanned');
    assert.equal(r.rewritten, 1, 'one row rewritten');
    const after = getMemory(db, key, m.id, { includeSuperseded: true });
    // 60 days idle, 30-day stability → R = exp(-60/30) ≈ 0.135 → confidence ≈ 0.1 + 0.9 * 0.135 ≈ 0.22
    assert.ok(
      after.confidence > 0.15 && after.confidence < 0.5,
      `confidence dropped from 0.8 to ~${after.confidence.toFixed(3)} (Ebbinghaus curve)`,
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('decayMemories: never drops below the 0.1 floor', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'ancient',
      content: 'very old',
      confidence: 0.15,
    });
    const agesAgo = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000).toISOString();
    rehearsalAt(db, m.id, agesAgo);
    decayMemories(db, key);
    const after = getMemory(db, key, m.id, { includeSuperseded: true });
    assert.ok(after.confidence >= 0.1 - 1e-6, `confidence floored at 0.1, got ${after.confidence}`);
    assert.ok(after.confidence < 0.15, `confidence did drop, got ${after.confidence}`);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('decayMemories: idempotent — running twice in a row is a no-op the second time', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'old',
      content: 'x',
      confidence: 0.5,
    });
    const longAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    rehearsalAt(db, m.id, longAgo);
    const r1 = decayMemories(db, key);
    const r2 = decayMemories(db, key);
    assert.equal(r1.rewritten, 1, 'first pass rewrites the stale row');
    assert.equal(r2.rewritten, 0, 'second pass is a no-op (already on the curve)');
    const after = getMemory(db, key, m.id, { includeSuperseded: true });
    assert.ok(after.confidence >= 0.1);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('decayMemories: respects higher stability (long-stable memory decays slower)', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'stable',
      content: 'rehearsed often',
      confidence: 0.5,
    });
    // Boost stability to 180 days via 5 reinforces.
    db.prepare('UPDATE memories SET stability_days=180 WHERE id=?').run(m.id);
    const longAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    rehearsalAt(db, m.id, longAgo);
    decayMemories(db, key);
    const after = getMemory(db, key, m.id, { includeSuperseded: true });
    // 60 days idle, 180-day stability → R = exp(-60/180) ≈ 0.717 → confidence ≈ 0.1 + 0.9 * 0.717 ≈ 0.745
    assert.ok(
      after.confidence > 0.6,
      `high-stability memory decays slower, got ${after.confidence.toFixed(3)}`,
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('decay.js pure helpers: retrievability + growStability', () => {
  assert.ok(Math.abs(retrievability(0, 30) - 1.0) < 1e-9);
  assert.ok(Math.abs(retrievability(30, 30) - Math.exp(-1)) < 1e-9);
  assert.ok(retrievability(365, 30) < 0.001);
  // growStability grows by STABILITY_GROWTH (1.5) and caps at 365.
  assert.ok(Math.abs(growStability(30) - 45) < 1e-9, `30 → 45, got ${growStability(30)}`);
  assert.ok(growStability(0.5) >= 1, 'tiny stability grows to at least 1');
  assert.ok(growStability(300) <= 365, 'stability capped at 365');
  assert.ok(Math.abs(growStability(null) - 45) < 1e-9, 'null grows from initial (30) → 45');
  // derivedConfidence composes the curve.
  const now = new Date();
  const fresh = derivedConfidence(30, now.toISOString(), now);
  assert.ok(fresh >= 0.99, `fresh rehearsal → ~1.0, got ${fresh}`);
  const cold = derivedConfidence(
    30,
    new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(),
    now,
  );
  assert.ok(cold < 0.15, `ancient rehearsal → floor-ish, got ${cold}`);
});

test('MCP round-trip: memory_reinforce returns the bumped memory', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/decay-mcp';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const toolsList = await mcp.call('tools/list', {});
    const names = new Set((toolsList.tools || []).map((t) => t.name));
    assert.ok(names.has('memory_reinforce'), 'tool is declared');
    const save = await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 't',
      content: 'c',
      confidence: 0.5,
    });
    const id = JSON.parse(save.content[0].text).memory.id;
    const reinforce = await mcp.toolCall('memory_reinforce', { cwd, id });
    const payload = JSON.parse(reinforce.content[0].text);
    assert.equal(payload.operation, 'reinforced');
    assert.equal(payload.memory.id, id);
    assert.equal(payload.memory.confidence, 0.55);
    assert.equal(payload.memory.access_count, 1);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});
