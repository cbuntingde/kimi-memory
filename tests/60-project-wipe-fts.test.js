// Regression tests for three defects in src/persist/project.js:
//   1. wipeProjectLifecycleLogs deleted dream_jobs before dream_proposals,
//      which raises FOREIGN KEY constraint failed on any project that ever
//      ran Dream (dream_proposals.job_id REFERENCES dream_jobs(id), no
//      ON DELETE CASCADE, PRAGMA foreign_keys = ON).
//   2. searchConversationEvents built unqualified predicates for the
//      conversation_events_fts JOIN, so every call threw
//      "ambiguous column name" into the bare catch and silently fell
//      through to the full-table LIKE scan. The lazy FTS backfill was
//      therefore unreachable.
//   3. resetProject selected the memory ids to clean out of memories_fts
//      AFTER deleting those rows, so memories_fts kept orphan rows, and
//      conversation_events_fts was never cleaned at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb } from '../src/persist/connection.js';
import { saveMemory } from '../src/persist/memories.js';
import {
  recordConversationEvent,
  searchConversationEvents,
  resetProject,
  wipeProjectLifecycleLogs,
  mirrorConversationEventsFts,
} from '../src/persist/project.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshDb(label) {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/' + label);
  return { home, key, db: openDb(projectDbPath(home, key)) };
}

function count(db, table, projectKey) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_key = ?`).get(projectKey).n;
}

// DEFECT 1 — children must be deleted before the parent.
test('wipeProjectLifecycleLogs deletes dream_proposals before dream_jobs (no FK violation)', () => {
  const { home, key, db } = freshDb('wipe-lifecycle');
  const otherKey = deriveProjectKey('C:/test/wipe-lifecycle-other');
  try {
    db.prepare(
      `INSERT INTO dream_jobs (id, project_key, status, enqueued_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('j1', key, 'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO dream_proposals (id, job_id, project_key, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('pr1', 'j1', key, 'merge', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO consolidation_runs (id, project_key, summary, at) VALUES (?, ?, ?, ?)`,
    ).run('cr1', key, '{}', '2026-01-01T00:00:00.000Z');
    // A sibling project's rows must survive the wipe.
    db.prepare(
      `INSERT INTO dream_jobs (id, project_key, status, enqueued_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('j2', otherKey, 'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO dream_proposals (id, job_id, project_key, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('pr2', 'j2', otherKey, 'merge', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const summary = wipeProjectLifecycleLogs(db, key);

    assert.deepEqual(summary, {
      dream_jobs_deleted: 1,
      dream_proposals_deleted: 1,
      consolidation_runs_deleted: 1,
    });
    assert.equal(count(db, 'dream_proposals', key), 0);
    assert.equal(count(db, 'dream_jobs', key), 0);
    assert.equal(count(db, 'consolidation_runs', key), 0);
    assert.equal(count(db, 'dream_jobs', otherKey), 1, 'sibling project untouched');
    assert.equal(count(db, 'dream_proposals', otherKey), 1, 'sibling project untouched');
    // No transaction was left open by the wipe.
    assert.ok(db.prepare('SELECT 1').get());
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('wipeProjectLifecycleLogs rolls back on error and leaves the rows in place', () => {
  const { home, key, db } = freshDb('wipe-lifecycle-rollback');
  try {
    db.prepare(
      `INSERT INTO dream_jobs (id, project_key, status, enqueued_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('j1', key, 'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO consolidation_runs (id, project_key, summary, at) VALUES (?, ?, ?, ?)`,
    ).run('cr1', key, '{}', '2026-01-01T00:00:00.000Z');
    // Force a mid-transaction failure: consolidation_runs disappears after
    // the proposals delete has already run.
    db.exec('DROP TABLE consolidation_runs');
    assert.throws(() => wipeProjectLifecycleLogs(db, key));
    assert.equal(count(db, 'dream_jobs', key), 1, 'rolled back, job still there');
    // The failed transaction must not leave the handle inside BEGIN.
    assert.ok(db.prepare('SELECT 1').get());
  } finally {
    closeDb();
    rmRf(home);
  }
});

// DEFECT 2 — the FTS join must actually be reachable.
test('searchConversationEvents reads through the FTS mirror and backfills it lazily', () => {
  const { home, key, db } = freshDb('search-fts');
  try {
    // Two token sets arranged so the LIKE fallback pattern
    // ('%beta%alpha%') cannot match, while the FTS OR-query can. A row
    // coming back therefore proves the SELECT ran through the FTS path.
    recordConversationEvent(db, key, 's1', 1, 0, {
      role: 'user',
      kind: 'message',
      summary: 'alpha note',
      raw: '{"text":"alpha"}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    recordConversationEvent(db, key, 's2', 1, 0, {
      role: 'assistant',
      kind: 'message',
      summary: 'beta note',
      raw: '{"text":"beta"}',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM conversation_events_fts').get().n,
      0,
      'mirror starts empty (recordConversationEvent does not write it)',
    );

    const rows = searchConversationEvents(db, key, 'beta alpha');

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM conversation_events_fts').get().n,
      2,
      'search backfilled the mirror',
    );
    assert.equal(rows.length, 2, 'both rows matched through the FTS path');
    assert.equal(rows[0].session_id, 's2', 'ORDER BY created_at DESC preserved');
    assert.equal(rows[1].session_id, 's1');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchConversationEvents honors the sessionId and role filters on the FTS path', () => {
  const { home, key, db } = freshDb('search-fts-filters');
  try {
    recordConversationEvent(db, key, 's1', 1, 0, {
      role: 'user',
      kind: 'message',
      summary: 'gamma alpha',
      raw: '{"text":"gamma"}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    recordConversationEvent(db, key, 's2', 1, 0, {
      role: 'assistant',
      kind: 'message',
      summary: 'gamma beta',
      raw: '{"text":"gamma"}',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    mirrorConversationEventsFts(db, key);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM conversation_events_fts').get().n,
      2,
      'pre-condition: mirror populated',
    );

    const bySession = searchConversationEvents(db, key, 'gamma', { sessionId: 's1' });
    assert.equal(bySession.length, 1);
    assert.equal(bySession[0].session_id, 's1');

    const byRole = searchConversationEvents(db, key, 'gamma', { role: 'assistant' });
    assert.equal(byRole.length, 1);
    assert.equal(byRole[0].session_id, 's2');
  } finally {
    closeDb();
    rmRf(home);
  }
});

// DEFECT 3 — resetProject must clean both FTS mirrors.
test('resetProject clears memories_fts and conversation_events_fts for the project', () => {
  const { home, key, db } = freshDb('reset-fts');
  try {
    const mem = saveMemory(db, key, {
      type: 'semantic',
      title: 'remember this',
      content: 'a durable fact',
      tags: ['reset'],
      _embed: false,
    });
    assert.ok(mem && mem.id);
    recordConversationEvent(db, key, 's1', 1, 0, {
      role: 'user',
      kind: 'message',
      summary: 'archived line',
      raw: '{"text":"archived"}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    mirrorConversationEventsFts(db, key);
    assert.equal(count(db, 'memories', key), 1);
    assert.equal(count(db, 'memories_fts', key), 1);
    assert.equal(count(db, 'conversation_events_fts', key), 1);

    const summary = resetProject(db, key, { canonicalRoot: 'C:/test/reset-fts' });

    assert.deepEqual(Object.keys(summary).sort(), [
      'conversation_events_deleted',
      'conversations_deleted',
      'memories_acl_deleted',
      'memories_deleted',
      'memory_edges_deleted',
      'memory_synthesizes_deleted',
      'persona_promotions_deleted',
      'project_key',
      'project_path_preserved',
      'skill_invocations_deleted',
      'working_memory_deleted',
    ]);
    assert.equal(summary.memories_deleted, 1);
    assert.equal(summary.conversation_events_deleted, 1);
    assert.equal(count(db, 'memories', key), 0);
    assert.equal(count(db, 'memories_fts', key), 0, 'memories_fts de-orphaned');
    assert.equal(
      count(db, 'conversation_events_fts', key),
      0,
      'conversation_events_fts mirror cleaned',
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});
