// Regression tests for four defects in the persist / CLI boundary:
//
//   1. saveMemory's INSERT hardcoded created_at / updated_at /
//      last_rehearsed_at to `now` and never bound access_count,
//      last_accessed_at or stability_days, so every field
//      src/cli-cmd/import.js restores from an export was silently
//      discarded: a restored row looked freshly created, stability_days
//      reset to the column default 30, and access_count reset to 0 —
//      which disables the auto-tier rules in src/auto-gc.js
//      (access_count >= 3 for L0→L1, >= 10 for L1→L2).
//   2. The UPDATE branch wrote every nullable column through
//      COALESCE(?, col), which can never store NULL, so the documented
//      "pass an explicit null to clear it" signal was ignored for
//      supersedes / persona_id / team_id / agent_id / user_id /
//      session_id / task_id.
//   3. is_session_focus was derived from a raw
//      /"session_focus":true/ substring match on the metadata JSON
//      rather than from the parsed boolean property.
//   4. resetProjectDryRunCounts did not count the tables resetProject
//      clears beyond the original six, so the dry run under-reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pluginRoot, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  getMemory,
  resetProject,
  resetProjectDryRunCounts,
  setWorkingMemory,
  upsertConversation,
  recordConversationEvent,
  mirrorConversationEventsFts,
} from '../src/persist.js';
import { deriveProjectKey, projectDbPath, canonicalizeRoot } from '../src/project-key.js';

// Values deliberately far from "now" so a save that stamps the current
// time (or falls back to the column default) cannot accidentally match.
const RESTORED = {
  created_at: '2025-01-02T03:04:05.000Z',
  updated_at: '2025-06-07T08:09:10.000Z',
  last_accessed_at: '2025-06-07T08:09:10.000Z',
  last_rehearsed_at: '2025-05-01T00:00:00.000Z',
  access_count: 12,
  stability_days: 90,
};

function mkProject(label) {
  const home = mkdtempSync(path.join(tmpdir(), 'pm-import-state-'));
  const cwd = canonicalizeRoot('C:/projects/' + label + '-' + Date.now());
  return { home, cwd, key: deriveProjectKey(cwd) };
}

function runCli(args, home) {
  return spawnSync(process.execPath, [path.join(pluginRoot(), 'src/cli.js'), ...args], {
    cwd: pluginRoot(),
    env: { ...process.env, KIMI_CODE_HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function rawRow(db, id) {
  return db.prepare('SELECT * FROM memories WHERE id=?').get(id);
}

// DEFECT 1 — the export→import round-trip must restore the row state.
test('CLI export → import restores created_at / updated_at / stability_days / access_count', () => {
  const src = mkProject('import-state-src');
  const dst = mkProject('import-state-dst');
  // Both homes use the source's cwd so the derived project_key matches.
  const cwd = src.cwd;
  const key = src.key;

  const srcDb = openDb(projectDbPath(src.home, key));
  let memId;
  try {
    const mem = saveMemory(srcDb, key, {
      type: 'semantic',
      title: 'durable state carrier',
      content: 'the export must carry this row verbatim',
      _embed: false,
    });
    memId = mem.id;
    srcDb
      .prepare(
        `UPDATE memories SET created_at=?, updated_at=?, last_accessed_at=?,
                            last_rehearsed_at=?, access_count=?, stability_days=?
         WHERE id=?`,
      )
      .run(
        RESTORED.created_at,
        RESTORED.updated_at,
        RESTORED.last_accessed_at,
        RESTORED.last_rehearsed_at,
        RESTORED.access_count,
        RESTORED.stability_days,
        memId,
      );
  } finally {
    closeDb(projectDbPath(src.home, key));
  }

  const dump = path.join(src.home, 'dump.json');
  const exp = runCli(['export', dump, '--cwd', cwd, '--scope', 'project'], src.home);
  assert.equal(exp.status, 0, 'export must exit 0; stderr=' + exp.stderr);
  const doc = JSON.parse(readFileSync(dump, 'utf8'));
  const exported = doc.scopes.project.memories.find((m) => m.id === memId);
  assert.ok(exported, 'the exported file must carry the seeded row');
  for (const [field, value] of Object.entries(RESTORED)) {
    assert.equal(exported[field], value, `export must carry ${field}`);
  }

  const imp = runCli(['import', dump, '--cwd', cwd, '--scope', 'project', '--merge'], dst.home);
  assert.equal(imp.status, 0, 'import must exit 0; stderr=' + imp.stderr);

  const dstDb = openDb(projectDbPath(dst.home, key));
  try {
    const row = rawRow(dstDb, memId);
    assert.ok(row, 'the imported row must exist');
    assert.equal(row.created_at, RESTORED.created_at, 'created_at must survive the round-trip');
    assert.equal(row.updated_at, RESTORED.updated_at, 'updated_at must survive the round-trip');
    assert.equal(
      row.last_accessed_at,
      RESTORED.last_accessed_at,
      'last_accessed_at must survive the round-trip',
    );
    assert.equal(
      row.last_rehearsed_at,
      RESTORED.last_rehearsed_at,
      'last_rehearsed_at must survive the round-trip',
    );
    assert.equal(
      row.access_count,
      RESTORED.access_count,
      'access_count must survive the round-trip',
    );
    assert.equal(
      row.stability_days,
      RESTORED.stability_days,
      'stability_days must survive the round-trip',
    );
    const readBack = getMemory(dstDb, key, memId);
    assert.equal(readBack.access_count, RESTORED.access_count);
    assert.equal(readBack.stability_days, RESTORED.stability_days);
  } finally {
    closeDb(projectDbPath(dst.home, key));
  }

  rmRf(src.home);
  rmRf(dst.home);
});

// DEFECT 1 — the same fields through the direct saveMemory surface, plus
// the defaults for every caller that does not pass them.
test('saveMemory honours supplied timestamps and counters, defaults otherwise', () => {
  const { home, key } = mkProject('save-explicit');
  const db = openDb(projectDbPath(home, key));
  try {
    const explicit = saveMemory(db, key, {
      type: 'semantic',
      title: 'explicit state',
      content: 'carries its own timestamps',
      created_at: RESTORED.created_at,
      updated_at: RESTORED.updated_at,
      last_accessed_at: RESTORED.last_accessed_at,
      last_rehearsed_at: RESTORED.last_rehearsed_at,
      access_count: RESTORED.access_count,
      stability_days: RESTORED.stability_days,
      _embed: false,
    });
    assert.equal(explicit.created_at, RESTORED.created_at);
    assert.equal(explicit.updated_at, RESTORED.updated_at);
    assert.equal(explicit.last_accessed_at, RESTORED.last_accessed_at);
    assert.equal(explicit.last_rehearsed_at, RESTORED.last_rehearsed_at);
    assert.equal(explicit.access_count, RESTORED.access_count);
    assert.equal(explicit.stability_days, RESTORED.stability_days);

    // No caller but the importer passes these: the omitted keys must
    // still produce the pre-fix values (now / 0 / the 30-day default).
    const before = Date.now();
    const defaults = saveMemory(db, key, {
      type: 'semantic',
      title: 'default state',
      content: 'passes none of the state fields',
      _embed: false,
    });
    assert.equal(defaults.access_count, 0, 'omitted access_count keeps the 0 default');
    assert.equal(defaults.stability_days, 30, 'omitted stability_days keeps the 30 default');
    assert.equal(defaults.last_accessed_at, null, 'omitted last_accessed_at stays null');
    for (const field of ['created_at', 'updated_at', 'last_rehearsed_at']) {
      const stamped = Date.parse(defaults[field]);
      assert.ok(Number.isFinite(stamped), `${field} must be an ISO timestamp`);
      assert.ok(
        Math.abs(stamped - before) < 60_000,
        `omitted ${field} must be stamped with the current time`,
      );
    }
  } finally {
    closeDb(projectDbPath(home, key));
    rmRf(home);
  }
});

// DEFECT 2 — an explicit null must clear the nullable columns, and an
// omitted key must leave them untouched.
test('saveMemory clears an explicitly null nullable field and preserves an omitted one', () => {
  const { home, key } = mkProject('clear-nullable');
  const db = openDb(projectDbPath(home, key));
  try {
    const seeded = saveMemory(db, key, {
      type: 'semantic',
      title: 'identity carrier',
      content: 'holds every nullable column',
      supersedes: 'prior-memory-id',
      team_id: 'team-1',
      agent_id: 'agent-1',
      user_id: 'user-1',
      session_id: 'sess-1',
      task_id: 'task-1',
      persona_id: 'persona-1',
      _embed: false,
    });
    const nullable = [
      'supersedes',
      'team_id',
      'agent_id',
      'user_id',
      'session_id',
      'task_id',
      'persona_id',
    ];
    const seededRow = rawRow(db, seeded.id);
    assert.equal(seededRow.team_id, 'team-1');
    assert.equal(seededRow.persona_id, 'persona-1');

    // Every key present with an explicit null: the "clear it" signal.
    saveMemory(db, key, {
      id: seeded.id,
      type: 'semantic',
      content: 'holds every nullable column',
      supersedes: null,
      team_id: null,
      agent_id: null,
      user_id: null,
      session_id: null,
      task_id: null,
      persona_id: null,
      _embed: false,
    });
    const cleared = rawRow(db, seeded.id);
    for (const col of nullable) {
      assert.equal(cleared[col], null, `an explicit null must clear ${col}`);
    }

    // Re-tag two columns, then re-save with both keys omitted: only the
    // supplied fields may change.
    saveMemory(db, key, {
      id: seeded.id,
      content: 'holds every nullable column',
      team_id: 'team-2',
      agent_id: 'agent-2',
      _embed: false,
    });
    saveMemory(db, key, {
      id: seeded.id,
      type: 'semantic',
      content: 'content changed without touching identity',
      _embed: false,
    });
    const kept = rawRow(db, seeded.id);
    assert.equal(kept.team_id, 'team-2', 'an omitted team_id keeps its stored value');
    assert.equal(kept.agent_id, 'agent-2', 'an omitted agent_id keeps its stored value');
    for (const col of ['user_id', 'session_id', 'task_id', 'persona_id', 'supersedes']) {
      assert.equal(kept[col], null, `an omitted ${col} stays cleared`);
    }
  } finally {
    closeDb(projectDbPath(home, key));
    rmRf(home);
  }
});

// DEFECT 2 — the supersede pass resolves an id even when the caller
// never passed `supersedes`, so the presence flag must not be keyed on
// `input.supersedes` alone.
test('a supersede=true re-save still records the resolved supersedes id', () => {
  const { home, key } = mkProject('resolve-supersedes');
  const db = openDb(projectDbPath(home, key));
  try {
    saveMemory(db, key, {
      id: 'mem-supersede-a',
      type: 'procedural',
      title: 'shared title',
      content: 'first incarnation',
      _embed: false,
    });
    saveMemory(db, key, {
      id: 'mem-supersede-b',
      type: 'procedural',
      title: 'shared title',
      content: 'second incarnation',
      _embed: false,
    });
    // Same id as the first row → the UPDATE branch, and supersede=true
    // resolves the second row as the one being replaced.
    saveMemory(db, key, {
      id: 'mem-supersede-a',
      type: 'procedural',
      title: 'shared title',
      content: 'first incarnation',
      supersede: true,
      _embed: false,
    });
    assert.equal(
      rawRow(db, 'mem-supersede-a').supersedes,
      'mem-supersede-b',
      'the resolved supersede id must be written on the UPDATE branch',
    );
    assert.equal(rawRow(db, 'mem-supersede-b').status, 'superseded');
  } finally {
    closeDb(projectDbPath(home, key));
    rmRf(home);
  }
});

// DEFECT 3 — the flag is the parsed boolean property, not a substring
// match anywhere in the serialised metadata.
test('is_session_focus is read from the parsed metadata property', () => {
  const { home, key } = mkProject('session-focus-flag');
  const db = openDb(projectDbPath(home, key));
  try {
    const canonical = saveMemory(db, key, {
      type: 'working',
      title: 'focus row',
      content: 'canonical focus shape',
      metadata: { session_focus: true, session_id: 'sess-1' },
      _embed: false,
    });
    assert.equal(
      rawRow(db, canonical.id).is_session_focus,
      1,
      'the canonical shape still stamps 1',
    );

    const explicitFalse = saveMemory(db, key, {
      type: 'working',
      title: 'plain row',
      content: 'session_focus false',
      metadata: { session_focus: false },
      _embed: false,
    });
    assert.equal(rawRow(db, explicitFalse.id).is_session_focus, 0);

    // A nested occurrence of the same key is not the flag. The old
    // /"session_focus":true/ substring test matched this serialisation
    // and stamped the dedicated column, so an ordinary row whose
    // metadata merely embeds a focus-shaped sub-object rode
    // idx_memories_session_focus into the session-thread query.
    const nested = saveMemory(db, key, {
      type: 'working',
      title: 'nested row',
      content: 'embeds a focus-shaped sub-object',
      metadata: { embedded_snapshot: { session_focus: true } },
      _embed: false,
    });
    assert.equal(rawRow(db, nested.id).is_session_focus, 0, 'only the top-level flag counts');
  } finally {
    closeDb(projectDbPath(home, key));
    rmRf(home);
  }
});

// DEFECT 4 — the dry run must report exactly what resetProject deletes.
test('resetProjectDryRunCounts matches the rows resetProject deletes', () => {
  const { home, key } = mkProject('dry-run-parity');
  const otherKey = deriveProjectKey(canonicalizeRoot('C:/projects/dry-run-parity-sibling'));
  const db = openDb(projectDbPath(home, key));
  try {
    const first = saveMemory(db, key, {
      type: 'semantic',
      title: 'first',
      content: 'wipe me',
      _embed: false,
    });
    const second = saveMemory(db, key, {
      type: 'semantic',
      title: 'second',
      content: 'wipe me too',
      _embed: false,
    });
    setWorkingMemory(db, key, 'current_focus', 'reset me');
    upsertConversation(db, key, 'sess-1', 'C:/projects/dry-run-parity');
    recordConversationEvent(db, key, 'sess-1', 1, 0, {
      role: 'user',
      kind: 'message',
      summary: 'archived line',
      raw: '{"text":"archived"}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    mirrorConversationEventsFts(db, key);
    // ACL grant on a project memory, plus an orphan grant whose memory
    // belongs to no project row here: only the first is "this project's".
    db.prepare(
      'INSERT INTO memories_acl (memory_id, principal_kind, principal_id, granted_at) VALUES (?, ?, ?, ?)',
    ).run(first.id, 'user', 'alice', '2026-01-01T00:00:00.000Z');
    db.prepare(
      'INSERT INTO memories_acl (memory_id, principal_kind, principal_id, granted_at) VALUES (?, ?, ?, ?)',
    ).run('orphan-memory-id', 'user', 'bob', '2026-01-01T00:00:00.000Z');
    db.prepare(
      'INSERT INTO skill_invocations (id, skill_id, project_key, invoked_at) VALUES (?, ?, ?, ?)',
    ).run('si-1', 'skill-1', key, '2026-01-01T00:00:00.000Z');
    db.prepare(
      'INSERT INTO persona_promotions (id, memory_id, from_tier, to_tier, at) VALUES (?, ?, ?, ?, ?)',
    ).run('pp-1', second.id, 'L0', 'L1', '2026-01-01T00:00:00.000Z');
    // Sibling-project rows must never be counted or deleted.
    db.prepare(
      'INSERT INTO skill_invocations (id, skill_id, project_key, invoked_at) VALUES (?, ?, ?, ?)',
    ).run('si-other', 'skill-1', otherKey, '2026-01-01T00:00:00.000Z');

    const dry = resetProjectDryRunCounts(db, key);
    assert.equal(dry.memories_acl, 1, 'only this project memory’s ACL grant is counted');
    assert.equal(dry.persona_promotions, 1);
    assert.equal(dry.skill_invocations, 1);
    assert.equal(dry.memories_fts, 2);
    assert.equal(dry.conversation_events_fts, 1);

    const summary = resetProject(db, key, { canonicalRoot: 'C:/projects/dry-run-parity' });
    // Every row set the destructive path reports must have an equal
    // dry-run count under the same name (summary fields carry a
    // `_deleted` suffix).
    for (const [name, deleted] of Object.entries(summary)) {
      if (name === 'project_key' || name === 'project_path_preserved') continue;
      const dryKey = name.replace(/_deleted$/, '');
      assert.ok(dryKey in dry, `the dry run must count ${dryKey}`);
      assert.equal(dry[dryKey], deleted, `dry-run ${dryKey} must match resetProject`);
    }
    assert.ok(summary.memories_acl_deleted > 0, 'resetProject must report the ACL delete');
    // conversation_events_fts has no summary field; the mirror must still
    // be empty afterwards.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM conversation_events_fts WHERE project_key=?').get(key)
        .n,
      0,
      'the conversation_events_fts mirror is cleared by the reset',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM skill_invocations WHERE project_key=?').get(otherKey).n,
      1,
      'a sibling project’s skill invocations survive',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM memories_acl WHERE memory_id=?').get('orphan-memory-id')
        .n,
      1,
      'an orphan ACL row is not attributable to this project',
    );
  } finally {
    closeDb(projectDbPath(home, key));
    rmRf(home);
  }
});
