// Regression tests for the two MUST-severity findings from the
// 2026-09-09 code-discipline audit that did not actually land in the
// tree when shipped. These tests pin the behaviour of the two fixes
// so a future refactor cannot silently regress them.
//
//   F1 — `persona_promotions.from_tier` records the *actual*
//        pre-transition tier, not the post-transition value the row
//        has after the UPDATE. The fix moved the SELECT before the
//        UPDATE inside `transitionIds` in src/auto-gc.js.
//
//   F2 — `maxJsonDepth` rejects inbound HTTP bodies nested deeper
//        than 64 levels before handing them to JSON.parse, so a
//        pathological `[[[...]]]` payload cannot reach V8's
//        call-stack limit inside the parser. Exported from
//        src/proxy/server.js and wired into readJson().
//
// The 2026-09-09 audit log at .audit-logs/code-discipline/ claims
// both fixes shipped; it was wrong. These tests are the long-lived
// guard against the same regression happening silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runAutoTier } from '../src/auto-gc.js';
import { maxJsonDepth } from '../src/proxy/server.js';

// ────────────────────────────────────────────────────────────────────
// F1 — persona_promotions.from_tier
// ────────────────────────────────────────────────────────────────────

// A copy of the seedMemory helper from tests/33-auto-gc-smoke.test.js
// — the same schema and the same AUTO_TIER_ACCESS_TO_L2 = 10 threshold
// the audit log cited. Promotes an L1 memory with high access_count
// to L2, then checks the persona_promotions audit row's from_tier.
function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kimi-f1-'));
  const dbPath = path.join(dir, 'memory.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      provenance TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0.8,
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 0,
      supersedes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      stability_days INTEGER NOT NULL DEFAULT 30,
      last_rehearsed_at TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      shared_with TEXT NOT NULL DEFAULT '[]',
      team_id TEXT,
      agent_id TEXT,
      user_id TEXT,
      session_id TEXT,
      task_id TEXT,
      tier TEXT NOT NULL DEFAULT 'L0',
      persona_id TEXT
    );
    CREATE TABLE persona_promotions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      from_tier TEXT NOT NULL,
      to_tier TEXT NOT NULL,
      reason TEXT,
      at TEXT NOT NULL
    );
  `);
  return { db, dir, dbPath };
}

function cleanup(db, dir) {
  // SQLite holds a file handle on Windows; close before rmSync so the
  // temp dir is actually removable. Failures here are non-fatal — the
  // next test creates a fresh temp dir.
  try {
    db.close();
  } catch {
    /* already closed */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function seedMemory(db, overrides) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories
       (id, project_key, type, title, content, tags, metadata, provenance,
        confidence, status, priority, supersedes, created_at, updated_at,
        expires_at, last_accessed_at, access_count, stability_days,
        last_rehearsed_at, tier, persona_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    overrides.project_key || 'proj1',
    overrides.type || 'semantic',
    overrides.title || 'untitled',
    overrides.content || '',
    JSON.stringify(overrides.tags || []),
    JSON.stringify(overrides.metadata || {}),
    JSON.stringify(overrides.provenance || {}),
    overrides.confidence ?? 0.8,
    overrides.status || 'active',
    overrides.priority ?? 0,
    overrides.supersedes || null,
    overrides.created_at || now,
    overrides.updated_at || now,
    overrides.expires_at || null,
    overrides.last_accessed_at || null,
    overrides.access_count ?? 0,
    overrides.stability_days ?? 30,
    overrides.last_rehearsed_at || now,
    overrides.tier || 'L0',
    overrides.persona_id || null,
  );
}

test('F1: persona_promotions.from_tier records the actual previous tier (L1→L2)', () => {
  const { db, dir, dbPath } = freshDb();
  try {
    seedMemory(db, { id: 'hot1', tier: 'L1', confidence: 0.9, access_count: 10 });
    const result = runAutoTier(db, 'proj1');
    assert.ok(result.promoted_l1_to_l2 >= 1, 'memory should be promoted L1→L2');

    const row = db
      .prepare('SELECT from_tier, to_tier FROM persona_promotions WHERE memory_id = ?')
      .get('hot1');
    assert.ok(row, 'audit row must exist for the promotion');
    // The fix (src/auto-gc.js, transitionIds) reads the previous tier
    // BEFORE the UPDATE. Before the fix, the SELECT was after the
    // UPDATE and saw the new tier, so this assertion failed:
    assert.equal(row.from_tier, 'L1', 'from_tier must be L1, not L2');
    assert.equal(row.to_tier, 'L2', 'to_tier must be L2');
  } finally {
    cleanup(db, dir);
  }
});

test('F1: persona_promotions.from_tier records the actual previous tier (L0→L1)', () => {
  const { db, dir } = freshDb();
  try {
    seedMemory(db, { id: 'hot0', tier: 'L0', confidence: 0.9, access_count: 5 });
    const result = runAutoTier(db, 'proj1');
    assert.ok(result.promoted_l0_to_l1 >= 1, 'memory should be promoted L0→L1');

    const row = db
      .prepare('SELECT from_tier, to_tier FROM persona_promotions WHERE memory_id = ?')
      .get('hot0');
    assert.ok(row, 'audit row must exist for the promotion');
    assert.equal(row.from_tier, 'L0', 'from_tier must be L0, not L1');
    assert.equal(row.to_tier, 'L1', 'to_tier must be L1');
  } finally {
    cleanup(db, dir);
  }
});

test('F1: a row already at the target tier does not produce an audit row', () => {
  const { db, dir } = freshDb();
  try {
    seedMemory(db, { id: 'already_l2', tier: 'L2', confidence: 0.9, access_count: 50 });
    runAutoTier(db, 'proj1');
    const row = db
      .prepare('SELECT * FROM persona_promotions WHERE memory_id = ?')
      .get('already_l2');
    assert.equal(row, undefined, 'no audit row for an already-at-target row');
  } finally {
    cleanup(db, dir);
  }
});

// ────────────────────────────────────────────────────────────────────
// F2 — maxJsonDepth guard
// ────────────────────────────────────────────────────────────────────

test('F2: maxJsonDepth accepts a shallow body', () => {
  const ok = maxJsonDepth('{"a":1,"b":[1,2,3]}');
  assert.equal(ok.ok, true);
  assert.ok(ok.depth <= 2, `shallow body should report a small depth; got ${ok.depth}`);
});

test('F2: maxJsonDepth accepts an empty body', () => {
  const ok = maxJsonDepth('');
  assert.equal(ok.ok, true);
});

test('F2: maxJsonDepth accepts exactly the limit (64 levels)', () => {
  // 64 nested arrays — depth climbs to 64, which is `maxLevels`.
  const body = '['.repeat(64) + ']'.repeat(64);
  const ok = maxJsonDepth(body, 64);
  assert.equal(ok.ok, true, `body at the limit must pass; depth=${ok.depth}`);
});

test('F2: maxJsonDepth rejects a body nested one level past the limit', () => {
  const body = '['.repeat(65) + ']'.repeat(65);
  const ok = maxJsonDepth(body, 64);
  assert.equal(ok.ok, false, 'body one level past the limit must fail');
  assert.ok(ok.depth > 64, `reporter should expose the actual depth; got ${ok.depth}`);
});

test('F2: maxJsonDepth rejects a deeply nested pathological body', () => {
  // 10k levels — would otherwise blow V8's call stack inside JSON.parse.
  const body = '['.repeat(10000) + ']'.repeat(10000);
  const ok = maxJsonDepth(body, 64);
  assert.equal(ok.ok, false);
});

test('F2: maxJsonDepth ignores bracket characters inside JSON strings', () => {
  // The shape-check walks the raw string and must NOT count `[` or `]`
  // that appear inside a JSON string value. A body of `{"k":"[[[]]"}`
  // has zero real nesting depth.
  const body = '{"k":"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]"}';
  const ok = maxJsonDepth(body, 64);
  assert.equal(
    ok.ok,
    true,
    `string-internal brackets must not count as nesting; depth=${ok.depth}`,
  );
});

test('F2: maxJsonDepth handles escaped quotes inside strings', () => {
  // The walker must skip the next character after a backslash inside
  // a JSON string, otherwise `"\"["` would falsely open a new string
  // context and miss the bracket.
  const body = '{"k":"\\""}'; // {"k":"\""}
  const ok = maxJsonDepth(body, 64);
  assert.equal(ok.ok, true, 'escaped quote must not corrupt the in-string tracker');
});
