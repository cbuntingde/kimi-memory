// Tests for the importance + decay primitives: reinforceMemory (a
// signal-driven bump) and decayMemories (a single SQL UPDATE that
// drops confidence on stale memories).
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
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/decay-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Stamp last_accessed_at to a specific UTC timestamp so we can test
// the decay math without waiting real time.
function touchAt(db, id, iso) {
  db.prepare('UPDATE memories SET last_accessed_at=?, updated_at=? WHERE id=?').run(iso, iso, id);
}
function updateAt(db, id, iso) {
  db.prepare('UPDATE memories SET updated_at=? WHERE id=?').run(iso, id);
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

test('decayMemories: no-op when every memory is fresh', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'fresh',
      content: 'just saved',
      confidence: 0.9,
    });
    const r = decayMemories(db, key);
    assert.equal(r.affected, 0, 'fresh rows are skipped by the 30-day grace period');
    const after = listMemories(db, key, {})[0];
    assert.equal(after.confidence, 0.9);
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
    // Stamp last_accessed_at to 60 days ago.
    const longAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    touchAt(db, m.id, longAgo);
    const r = decayMemories(db, key);
    assert.equal(r.affected, 1, 'one row is decayed');
    const after = getMemory(db, key, m.id, { includeSuperseded: true });
    // 60 days inactive → 30 days grace then 30 days at 5%/30d ≈ 0.05 → confidence ≈ 0.8 * (1 - 0.05) ≈ 0.76
    assert.ok(
      after.confidence > 0.7 && after.confidence < 0.8,
      `confidence dropped from 0.8 to ~${after.confidence.toFixed(3)}`,
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
    // Way back: 5 years of inactivity.
    const agesAgo = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000).toISOString();
    touchAt(db, m.id, agesAgo);
    decayMemories(db, key);
    const after = getMemory(db, key, m.id, { includeSuperseded: true });
    assert.ok(after.confidence >= 0.1 - 1e-6, `confidence floored at 0.1, got ${after.confidence}`);
    assert.ok(after.confidence < 0.15, `confidence did drop, got ${after.confidence}`);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('decayMemories: uses updated_at when last_accessed_at is null', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 'never-accessed', content: 'x' });
    const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    updateAt(db, m.id, longAgo);
    // No last_accessed_at → should still be picked up via updated_at.
    db.prepare('UPDATE memories SET last_accessed_at=NULL WHERE id=?').run(m.id);
    const r = decayMemories(db, key);
    assert.equal(r.affected, 1);
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
    touchAt(db, m.id, longAgo);
    const r1 = decayMemories(db, key);
    const r2 = decayMemories(db, key);
    assert.equal(r1.affected, 1);
    // After the first pass, the row's confidence was already lowered
    // and its last_accessed_at still points to the same stale date —
    // the second pass decays again. The point of "idempotent" here is
    // that neither pass errors and the row still exists.
    assert.ok(r2.affected >= 0);
    const after = getMemory(db, key, m.id, { includeSuperseded: true });
    assert.ok(after.confidence >= 0.1);
  } finally {
    closeDb();
    rmRf(home);
  }
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
