// Regression tests for two defects:
//
//   1  resetProject left memories_acl, persona_promotions and
//      skill_invocations rows keyed to the wiped project behind, so a
//      "reset" project still carried ACL grants, tier audit rows and
//      skill stats. The dry-run counts could not match either.
//   2  setMemoryTier / promoteMemory / demoteMemory wrote the tier
//      UPDATE and the persona_promotions audit INSERT as two autocommit
//      statements, and promote/demote did a non-transactional
//      read-modify-write, so a failure between the two lost either the
//      audit row or a concurrent update. recordPromotion also returned a
//      synthetic transition even when INSERT OR IGNORE dropped the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  resetProject,
  setMemoryTier,
  promoteMemory,
  demoteMemory,
  recordSkillInvocation,
  recordProjectPath,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function seedMemory(db, key, title) {
  return saveMemory(db, key, {
    type: 'semantic',
    title,
    content: title,
    tags: [],
    metadata: {},
    provenance: {},
    confidence: 0.8,
    status: 'active',
    priority: 0,
    expires_at: null,
    supersede: false,
    _embed: false,
  });
}

function insertAcl(db, memoryId, kind, id) {
  db.prepare(
    `INSERT INTO memories_acl (memory_id, principal_kind, principal_id, granted_at)
     VALUES (?, ?, ?, ?)`,
  ).run(memoryId, kind, id, new Date().toISOString());
}

function count(db, sql, ...params) {
  return db.prepare(sql).get(...params).n;
}

test('resetProject clears memories_acl, persona_promotions and skill_invocations for the project', () => {
  const home = mkTempHome('km-67-');
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-67-rp-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const m1 = seedMemory(db, key, 'first');
    const m2 = seedMemory(db, key, 'second');
    insertAcl(db, m1.id, 'user', 'alice');
    insertAcl(db, m1.id, 'role', 'editor');
    setMemoryTier(db, key, m2.id, 'L1', { reason: 'seed-1' });
    setMemoryTier(db, key, m2.id, 'L2', { reason: 'seed-2' });
    recordSkillInvocation(db, key, m1.id, { success: true, toolName: 'x' });
    recordSkillInvocation(db, key, m2.id, { success: false, toolName: 'y' });
    recordProjectPath(db, key, cwd);

    const summary = resetProject(db, key);

    assert.equal(summary.memories_acl_deleted, 2, 'both ACL grants removed');
    assert.equal(summary.persona_promotions_deleted, 2, 'both audit rows removed');
    assert.equal(summary.skill_invocations_deleted, 2, 'both invocations removed');
    // Existing keys keep their meaning.
    assert.equal(summary.memories_deleted, 2);
    assert.equal(summary.project_path_preserved, true);

    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM memories_acl'), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM persona_promotions'), 0);
    assert.equal(
      count(db, 'SELECT COUNT(*) AS n FROM skill_invocations WHERE project_key=?', key),
      0,
      'skill invocations for the project are gone',
    );
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('resetProject leaves a sibling project_key ACL / promotions / skill rows intact', () => {
  const home = mkTempHome('km-67-');
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-67-iso-'));
  const key = deriveProjectKey(cwd);
  const sibling = 'sibling-project-key';
  try {
    const db = openDb(projectDbPath(home, key));
    const mine = seedMemory(db, key, 'mine');
    const theirs = seedMemory(db, sibling, 'theirs');
    insertAcl(db, mine.id, 'user', 'me');
    insertAcl(db, theirs.id, 'user', 'them');
    setMemoryTier(db, sibling, theirs.id, 'L1', { reason: 'sibling' });
    recordSkillInvocation(db, sibling, theirs.id, { success: true, toolName: 'z' });

    const summary = resetProject(db, key);

    assert.equal(summary.memories_acl_deleted, 1, 'only this project ACL row removed');
    assert.equal(summary.persona_promotions_deleted, 0, 'sibling audit row is not this project');
    assert.equal(summary.skill_invocations_deleted, 0, 'sibling invocation is not this project');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM memories_acl'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM persona_promotions'), 1);
    assert.equal(
      count(db, 'SELECT COUNT(*) AS n FROM skill_invocations WHERE project_key=?', sibling),
      1,
    );
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('resetProject rolls back every delete when one of them fails', () => {
  const home = mkTempHome('km-67-');
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-67-rb-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const m = seedMemory(db, key, 'victim');
    insertAcl(db, m.id, 'user', 'alice');
    setMemoryTier(db, key, m.id, 'L1', { reason: 'seed' });
    recordSkillInvocation(db, key, m.id, { success: true });
    // Abort the skill_invocations DELETE, which runs after the ACL and
    // promotion deletes: without a transaction those two would already
    // have been committed.
    db.exec(
      `CREATE TRIGGER t67_block_skill_delete BEFORE DELETE ON skill_invocations
       BEGIN SELECT RAISE(ABORT, 'skill delete blocked'); END`,
    );

    assert.throws(() => resetProject(db, key), /skill delete blocked/);

    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM memories WHERE project_key=?', key), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM memories_acl'), 1, 'ACL delete rolled back');
    assert.equal(
      count(db, 'SELECT COUNT(*) AS n FROM persona_promotions'),
      1,
      'promotion delete rolled back',
    );
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM skill_invocations'), 1);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('setMemoryTier rolls back the tier UPDATE when the audit INSERT fails', () => {
  const home = mkTempHome('km-67-');
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-67-tier-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const m = seedMemory(db, key, 'tiered');
    db.exec(
      `CREATE TRIGGER t67_block_promo BEFORE INSERT ON persona_promotions
       BEGIN SELECT RAISE(ABORT, 'promo blocked'); END`,
    );

    assert.throws(() => setMemoryTier(db, key, m.id, 'L2'), /promo blocked/);

    assert.equal(
      db.prepare('SELECT tier FROM memories WHERE id=?').get(m.id).tier,
      'L0',
      'tier UPDATE was rolled back with its failed audit row',
    );
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM persona_promotions'), 0);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('promoteMemory rolls back the tier UPDATE when the audit INSERT fails', () => {
  const home = mkTempHome('km-67-');
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-67-promo-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const m = seedMemory(db, key, 'promoted');
    db.exec(
      `CREATE TRIGGER t67_block_promo2 BEFORE INSERT ON persona_promotions
       BEGIN SELECT RAISE(ABORT, 'promo blocked'); END`,
    );

    assert.throws(() => promoteMemory(db, key, m.id), /promo blocked/);

    assert.equal(
      db.prepare('SELECT tier FROM memories WHERE id=?').get(m.id).tier,
      'L0',
      'read-modify-write was rolled back as one unit',
    );
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('setMemoryTier reports an ignored audit INSERT as transition=null', () => {
  const home = mkTempHome('km-67-');
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-67-ignore-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const m = seedMemory(db, key, 'ignored');
    // INSERT OR IGNORE silently drops the row when the trigger raises
    // IGNORE; the old code still returned a synthetic transition object.
    db.exec(
      `CREATE TRIGGER t67_ignore_promo BEFORE INSERT ON persona_promotions
       BEGIN SELECT RAISE(IGNORE); END`,
    );

    const r = setMemoryTier(db, key, m.id, 'L1');

    assert.equal(r.transition, null, 'no audit row was written, so no transition');
    assert.equal(r.memory.tier, 'L1');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM persona_promotions'), 0);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('setMemoryTier returns the audit row actually persisted', () => {
  const home = mkTempHome('km-67-');
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-67-row-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const m = seedMemory(db, key, 'audited');

    const r = setMemoryTier(db, key, m.id, 'L3', { reason: 'because' });

    assert.ok(r.transition, 'a real transition is reported');
    const stored = db
      .prepare(
        `SELECT id, memory_id, from_tier, to_tier, reason, at
         FROM persona_promotions WHERE id = ?`,
      )
      .get(r.transition.id);
    assert.deepEqual(r.transition, stored, 'returned transition equals the stored row');
    assert.equal(r.transition.from_tier, 'L0');
    assert.equal(r.transition.to_tier, 'L3');
    assert.equal(r.transition.reason, 'because');
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});

test('promoteMemory / demoteMemory step one tier and report the caps as transition=null', () => {
  const home = mkTempHome('km-67-');
  const cwd = mkdtempSync(path.join(tmpdir(), 'km-67-step-'));
  const key = deriveProjectKey(cwd);
  try {
    const db = openDb(projectDbPath(home, key));
    const m = seedMemory(db, key, 'stepper');

    const up1 = promoteMemory(db, key, m.id, { reason: 'up1' });
    assert.equal(up1.memory.tier, 'L1');
    assert.ok(up1.transition);
    const up2 = promoteMemory(db, key, m.id);
    assert.equal(up2.memory.tier, 'L2');
    const up3 = promoteMemory(db, key, m.id);
    assert.equal(up3.memory.tier, 'L3');
    assert.ok(up3.transition);

    const capped = promoteMemory(db, key, m.id);
    assert.equal(capped.memory.tier, 'L3');
    assert.equal(capped.transition, null, 'promoting past L3 is a no-op');

    const down = demoteMemory(db, key, m.id);
    assert.equal(down.memory.tier, 'L2');
    assert.ok(down.transition);

    const missing = promoteMemory(db, key, 'nonexistent-id-9999');
    assert.equal(missing.memory, null);
    assert.equal(missing.transition, null);
    closeDb(projectDbPath(home, key));
  } finally {
    rmRf(home);
    rmRf(cwd);
  }
});
