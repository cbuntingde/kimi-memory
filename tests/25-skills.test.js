// Tests for v10 Skills-as-Memory + trigger matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  matchSkillTriggers,
  recordSkillInvocation,
  updateSkillInvocationStats,
  listSkillMemories,
  getMemory,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/skills');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('saveMemory accepts type="skill" after the v10 migration', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const mem = saveMemory(db, key, {
      type: 'skill',
      title: 'Lint watch',
      content: 'Run eslint on touched files',
      metadata: {
        trigger: { commands: ['pnpm lint'], keywords: ['lint'] },
      },
    });
    assert.equal(mem.type, 'skill');
    assert.equal(mem.metadata.trigger.commands[0], 'pnpm lint');
    // Round-trip via getMemory.
    const fetched = getMemory(db, key, mem.id);
    assert.equal(fetched.type, 'skill');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('matchSkillTriggers: command trigger fires on matching command', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'skill',
      title: 'Lint runner',
      content: 'Runs lint',
      metadata: { trigger: { commands: ['pnpm lint', 'npm run lint'] } },
    });
    const matches = matchSkillTriggers(db, key, { command: 'pnpm lint --fix' }, { limit: 2 });
    assert.ok(matches.length >= 1, 'expected at least one match');
    assert.equal(matches[0].title, 'Lint runner');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('matchSkillTriggers: path trigger fires on matching file path', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'skill',
      title: 'Python formatter',
      content: 'Run black on .py files',
      metadata: { trigger: { paths: ['src/foo.py', 'src/bar.py'] } },
    });
    const matches = matchSkillTriggers(db, key, { file_path: 'C:/work/src/foo.py' }, { limit: 2 });
    assert.equal(matches.length, 1, 'expected exactly one match for path');
    assert.equal(matches[0].title, 'Python formatter');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('matchSkillTriggers: keyword trigger fires on substring in args', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'skill',
      title: 'Migrate helper',
      content: 'Run migration',
      metadata: { trigger: { keywords: ['migrate', 'schema'] } },
    });
    const matches = matchSkillTriggers(
      db,
      key,
      { command: 'do-it', arbitrary: 'please migrate the schema' },
      { limit: 2 },
    );
    assert.equal(matches.length, 1);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('matchSkillTriggers: returns [] when nothing matches', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'skill',
      title: 'Lint runner',
      content: 'Runs lint',
      metadata: { trigger: { commands: ['pnpm lint'] } },
    });
    const matches = matchSkillTriggers(db, key, { command: 'echo hi' }, { limit: 2 });
    assert.deepEqual(matches, []);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('matchSkillTriggers: limits to top N by score', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'skill',
      title: 'A',
      content: 'a',
      metadata: { trigger: { commands: ['pnpm lint'] } },
    });
    saveMemory(db, key, {
      type: 'skill',
      title: 'B',
      content: 'b',
      metadata: { trigger: { commands: ['pnpm lint'] } },
    });
    saveMemory(db, key, {
      type: 'skill',
      title: 'C',
      content: 'c',
      metadata: { trigger: { commands: ['pnpm lint'] } },
    });
    const matches = matchSkillTriggers(db, key, { command: 'pnpm lint' }, { limit: 2 });
    assert.equal(matches.length, 2, 'limit:2 caps the result set');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('recordSkillInvocation + updateSkillInvocationStats tracks success_rate', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const skill = saveMemory(db, key, {
      type: 'skill',
      title: 'Skill',
      content: 'body',
      metadata: { trigger: { commands: ['x'] } },
    });
    recordSkillInvocation(db, key, skill.id, { success: 1, toolName: 'x' });
    recordSkillInvocation(db, key, skill.id, { success: 0, toolName: 'x' });
    recordSkillInvocation(db, key, skill.id, { success: 1, toolName: 'x' });
    const stats = updateSkillInvocationStats(db, key, skill.id);
    assert.equal(stats.invoke_count, 3);
    assert.ok(stats.success_rate >= 0.66 && stats.success_rate <= 0.67);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('listSkillMemories excludes superseded / non-skill rows', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'skill', title: 'Active', content: 'a' });
    saveMemory(db, key, {
      type: 'skill',
      title: 'Pending',
      content: 'b',
      processing_status: 'pending',
    });
    saveMemory(db, key, { type: 'semantic', title: 'Not a skill', content: 'c' });
    const list = listSkillMemories(db, key);
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Active');
  } finally {
    closeDb();
    rmRf(home);
  }
});
