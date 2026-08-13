// Smoke test for the auto-GC pipeline. Builds a synthetic DB with
// a representative mix of row states (deleted, superseded, embedding
// failed, cold, hot, fresh, expired) and verifies that each auto-pass
// deletes / promotes / archives the right rows.
//
// This is not a unit test — the auto-GC module is small enough that
// the existing tests/22-brain-modes.test.js scaffold covers the
// helpers. This test exercises the *coordination* between the
// three passes and the schema_meta throttle stamp, which is the
// harder thing to assert.
//
// Run with: node --test tests/33-auto-gc-smoke.test.js

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAutoPrune, runAutoArchive, runAutoTier, runAutoGc } from '../src/auto-gc.js';
import { runConsolidate } from '../src/consolidate.js';

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kimi-smoke-'));
  const dbPath = path.join(dir, 'memory.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: false, create: true });
  // schema_meta is created by the v10 migration; create it here
  // explicitly so the test does not depend on the migration runner.
  db.exec(`
    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      provenance TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0.8,
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 0,
      supersedes TEXT,
      superseded_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      embedding BLOB,
      embedding_model TEXT,
      embedding_dim INTEGER,
      embedded_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      last_embed_error TEXT,
      stability_days REAL NOT NULL DEFAULT 30,
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
    CREATE TABLE memory_edges (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE memory_synthesizes (
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (parent_id, child_id)
    );
    CREATE TABLE persona_promotions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      from_tier TEXT NOT NULL,
      to_tier TEXT NOT NULL,
      reason TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE conversation_events (
      session_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL,
      role TEXT,
      kind TEXT,
      payload TEXT NOT NULL,
      summary TEXT,
      created_at TEXT,
      PRIMARY KEY (session_id, project_key, line_no)
    );
    CREATE TABLE skill_invocations (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      tool_name TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      invoked_at TEXT NOT NULL
    );
  `);
  return { db, dir, dbPath };
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function seedMemory(db, overrides) {
  const now = new Date().toISOString();
  const id = overrides.id || `m_${Math.random().toString(36).slice(2, 10)}`;
  const updated_at = overrides.updated_at || now;
  const created_at = overrides.created_at || now;
  db.prepare(
    `INSERT INTO memories
       (id, project_key, type, title, content, tags, metadata, provenance,
        confidence, status, priority, supersedes, created_at, updated_at,
        expires_at, stability_days, last_rehearsed_at, tier, persona_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
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
    created_at,
    updated_at,
    overrides.expires_at || null,
    overrides.stability_days ?? 30,
    overrides.last_rehearsed_at || created_at,
    overrides.tier || 'L0',
    overrides.persona_id || null,
  );
  return id;
}

test('runAutoPrune deletes deleted>30d, superseded>90d, embed-failed>30d, cold rows', () => {
  const { db, dir } = freshDb();
  try {
    // Threshold reference points.
    const old60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const old120 = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const old400 = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();

    // Should be pruned: deleted and > 30 days old.
    seedMemory(db, { id: 'old_deleted', status: 'deleted', updated_at: old60 });
    // Should be pruned: superseded and > 90 days old (use 120d).
    seedMemory(db, { id: 'old_super', status: 'superseded', updated_at: old120 });
    // Should be pruned: embedding failed and > 30 days old.
    seedMemory(db, {
      id: 'old_efail',
      status: 'active',
      updated_at: old60,
      metadata: { has_embedding: false },
    });
    db.prepare(
      `UPDATE memories SET last_embed_error = 'simulated', embedding = NULL WHERE id = ?`,
    ).run('old_efail');

    // Should be pruned: cold (low confidence, 0 access, > 365 days).
    seedMemory(db, {
      id: 'cold_old',
      status: 'active',
      confidence: 0.01,
      updated_at: old400,
    });

    // Should NOT be pruned: deleted but only 5 days old.
    seedMemory(db, {
      id: 'recent_deleted',
      status: 'deleted',
      updated_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Should NOT be pruned: cold but only 100 days old.
    seedMemory(db, {
      id: 'cold_recent',
      status: 'active',
      confidence: 0.01,
      updated_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = runAutoPrune(db, 'proj1');
    assert.ok(
      result.pruned_deleted >= 1,
      `expected ≥1 deleted pruned, got ${result.pruned_deleted}`,
    );
    assert.ok(
      result.pruned_superseded >= 1,
      `expected ≥1 superseded pruned, got ${result.pruned_superseded}`,
    );
    assert.ok(
      result.pruned_embed_failed >= 1,
      `expected ≥1 embed-failed pruned, got ${result.pruned_embed_failed}`,
    );

    // Verify the right rows survived.
    const remaining = db
      .prepare("SELECT id FROM memories WHERE project_key = 'proj1' ORDER BY id")
      .all()
      .map((r) => r.id);
    assert.ok(!remaining.includes('old_deleted'), 'old_deleted should be pruned');
    assert.ok(!remaining.includes('old_super'), 'old_super should be pruned');
    assert.ok(!remaining.includes('old_efail'), 'old_efail should be pruned');
    assert.ok(!remaining.includes('cold_old'), 'cold_old should be pruned');
    assert.ok(remaining.includes('recent_deleted'), 'recent_deleted should survive');
    assert.ok(remaining.includes('cold_recent'), 'cold_recent should survive');
  } finally {
    cleanup(dir);
  }
});

test('runAutoArchive drops old conversation_events + skill_invocations', () => {
  const { db, dir } = freshDb();
  try {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    // 1 old conversation event, 1 recent.
    db.prepare(
      `INSERT INTO conversation_events
         (session_id, project_key, line_no, byte_offset, payload, created_at)
         VALUES (?, 'proj1', 1, 0, '{}', ?)`,
    ).run('sess1', old);
    db.prepare(
      `INSERT INTO conversation_events
         (session_id, project_key, line_no, byte_offset, payload, created_at)
         VALUES (?, 'proj1', 2, 0, '{}', ?)`,
    ).run('sess1', recent);

    // 1 old skill invocation, 1 recent.
    db.prepare(
      `INSERT INTO skill_invocations
         (id, skill_id, project_key, success, invoked_at)
         VALUES (?, 'sk1', 'proj1', 1, ?)`,
    ).run('inv1', old);
    db.prepare(
      `INSERT INTO skill_invocations
         (id, skill_id, project_key, success, invoked_at)
         VALUES (?, 'sk1', 'proj1', 1, ?)`,
    ).run('inv2', recent);

    const result = runAutoArchive(db, 'proj1');
    assert.ok(
      result.archived_conversation_events >= 1,
      `expected ≥1 conv event archived, got ${result.archived_conversation_events}`,
    );
    assert.ok(
      result.archived_skill_invocations >= 1,
      `expected ≥1 skill inv archived, got ${result.archived_skill_invocations}`,
    );

    // Old row gone, recent row stays.
    const conv = db.prepare('SELECT COUNT(*) AS n FROM conversation_events').get().n;
    assert.ok(conv >= 1, `recent conv event should survive, got ${conv}`);
    const skill = db.prepare('SELECT COUNT(*) AS n FROM skill_invocations').get().n;
    assert.ok(skill >= 1, `recent skill inv should survive, got ${skill}`);
  } finally {
    cleanup(dir);
  }
});

test('runAutoTier promotes L0→L1 on access_count and demotes on low confidence', () => {
  const { db, dir } = freshDb();
  try {
    // Hot memory: access_count high, should be promoted past L0.
    seedMemory(db, { id: 'hot', tier: 'L0', confidence: 0.9 });
    db.prepare('UPDATE memories SET access_count = 10 WHERE id = ?').run('hot');
    // Cold memory: low confidence, old rehearsal, should be demoted.
    seedMemory(db, {
      id: 'cold',
      tier: 'L2',
      confidence: 0.05,
      last_rehearsed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = runAutoTier(db, 'proj1');
    assert.ok(result.promoted_l0_to_l1 >= 1, 'hot memory should be promoted');
    assert.ok(result.demoted_to_l0 >= 1, 'cold memory should be demoted');

    const hot = db.prepare('SELECT tier FROM memories WHERE id = ?').get('hot');
    assert.notEqual(hot.tier, 'L0', 'hot should not be L0 anymore');
    const cold = db.prepare('SELECT tier FROM memories WHERE id = ?').get('cold');
    assert.equal(cold.tier, 'L0', 'cold should be L0');
  } finally {
    cleanup(dir);
  }
});

test('runAutoGc aggregates prune + archive + tier', () => {
  const { db, dir } = freshDb();
  try {
    seedMemory(db, {
      id: 'old_hot',
      status: 'deleted',
      updated_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = runAutoGc(db, 'proj1');
    assert.ok(result.prune, 'prune pass should run');
    assert.ok(result.archive, 'archive pass should run');
    assert.ok(result.tier, 'tier pass should run');
  } finally {
    cleanup(dir);
  }
});

test('runConsolidate merges tight clusters via mergeMemory', async () => {
  const { db, dir } = freshDb();
  try {
    // Create a tight cluster: 3 memories with identical titles,
    // identical embeddings, and overlapping tags. The cosine of an
    // embedding with itself is 1.0, which easily exceeds the 0.85
    // threshold.
    const embedding = new Float32Array(384).map(() => Math.random());
    const enc = new TextEncoder();
    const blob = new Uint8Array(embedding.buffer).slice(0);
    // Encode as a BLOB SQLite understands.
    for (const id of ['a', 'b', 'c']) {
      seedMemory(db, {
        id,
        title: 'Always run npm run check before committing',
        content: 'Lint-clean before commit. Avoids CI failures.',
        tags: ['convention', 'git', 'workflow'],
        confidence: id === 'a' ? 0.9 : 0.5,
      });
      db.prepare('UPDATE memories SET embedding = ?, embedding_dim = 384 WHERE id = ?').run(
        blob,
        id,
      );
    }

    // Inject a fake mergeMemory and saveMemory to track what happens.
    const calls = { save: 0, link: 0, merge: 0 };
    const fakeSaveMemory = (dbArg, projectKey, input) => {
      calls.save += 1;
      const id = `conclusion_${calls.save}`;
      seedMemory(dbArg, {
        id,
        title: input.title,
        content: input.content,
        tags: input.tags,
        confidence: input.confidence || 0.7,
        type: input.type,
      });
      return { id };
    };
    const fakeLinkMemory = () => {
      calls.link += 1;
      return {};
    };
    const fakeMergeMemory = (dbArg, projectKey, intoId, fromId, opts) => {
      calls.merge += 1;
      // Soft-supersede the from-row.
      dbArg
        .prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?")
        .run(intoId, fromId);
      return { into: { id: intoId }, from: { id: fromId, status: 'superseded' } };
    };

    const result = await runConsolidate({
      db,
      projectKey: 'proj1',
      saveMemory: fakeSaveMemory,
      memoryLink: fakeLinkMemory,
      mergeMemory: fakeMergeMemory,
    });

    assert.ok(result.clusters >= 1, `expected ≥1 cluster, got ${result.clusters}`);
    assert.ok(result.saved >= 1, `expected ≥1 conclusion saved, got ${result.saved}`);
    assert.ok(
      calls.merge >= 2,
      `expected ≥2 merge calls (3 sibling - 1 target = 2), got ${calls.merge}`,
    );

    // Verify the siblings are soft-superseded.
    const statuses = db
      .prepare("SELECT id, status FROM memories WHERE id IN ('a', 'b', 'c')")
      .all();
    const superseded = statuses.filter((r) => r.status === 'superseded').length;
    assert.ok(superseded >= 2, `expected ≥2 superseded, got ${superseded}`);
  } finally {
    cleanup(dir);
  }
});
