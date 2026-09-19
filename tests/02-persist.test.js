// Tests for the SQLite persistence layer. Covers CRUD, FTS recall,
// expiry, supersession, working memory, conversations, accurate
// active/retained counts, multi-handle DB caching, and global
// isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, memoryCounts } from '../src/persist.js';
import {
  projectDbPath,
  globalDbPath,
  deriveProjectKey,
  GLOBAL_PROJECT_KEY,
  ensureGlobalDir,
} from '../src/project-key.js';
import {
  saveMemory,
  saveMemoryBulk,
  getMemory,
  listMemories,
  deleteMemory,
  searchMemories,
  setWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
  listWorkingMemory,
  upsertConversation,
  recordConversationEvent,
  listConversations,
  getConversation,
  getConversationEvents,
  searchConversationEvents,
  projectStatus,
  loadIngestState,
  saveIngestState,
} from '../src/persist.js';
import { ensureProjectDir } from '../src/project-key.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/project-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('openDb creates the schema and is idempotent', () => {
  const { home, dbPath } = freshProject();
  try {
    const db1 = openDb(dbPath);
    db1.exec('SELECT 1');
    const db2 = openDb(dbPath); // same path returns cached handle
    assert.equal(db1, db2);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('openDb uses a path-keyed cache: same path => same handle, different paths => different handles', () => {
  const { home, dbPath } = freshProject();
  try {
    const dbA1 = openDb(dbPath);
    const dbA2 = openDb(dbPath);
    assert.equal(dbA1, dbA2, 'same path returns the cached handle');
    // A different project DB must produce a different handle, and
    // both must coexist in the cache (mirrors what hooks and the
    // MCP server do when both project and global dbs are open).
    const otherKey = deriveProjectKey('C:/project-B');
    const otherPath = projectDbPath(home, otherKey);
    const dbB = openDb(otherPath);
    assert.notEqual(dbA1, dbB, 'different paths give different handles');
    assert.equal(openDb(otherPath), dbB, 'different path is also cached');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('closeDb releases every cached handle so a fresh open yields a new handle', () => {
  const { home, dbPath } = freshProject();
  try {
    const a = openDb(dbPath);
    const otherKey = deriveProjectKey('C:/project-Z');
    const b = openDb(projectDbPath(home, otherKey));
    assert.notEqual(a, b);
    closeDb();
    const a2 = openDb(dbPath);
    const b2 = openDb(projectDbPath(home, otherKey));
    assert.notEqual(a2, a, 'project handle was released');
    assert.notEqual(b2, b, 'other-project handle was released');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('saveMemory + getMemory round-trip across all memory types', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    for (const type of ['working', 'episodic', 'semantic', 'procedural']) {
      const m = saveMemory(db, key, {
        type,
        title: 'hello ' + type,
        content: 'body ' + type,
        tags: [type],
      });
      const got = getMemory(db, key, m.id);
      assert.ok(got, 'memory should be retrievable for ' + type);
      assert.equal(got.type, type);
      assert.equal(got.title, 'hello ' + type);
      assert.deepEqual(got.tags, [type]);
    }
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('listMemories filters by type and status', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 's1', content: 'one' });
    saveMemory(db, key, { type: 'semantic', title: 's2', content: 'two' });
    saveMemory(db, key, { type: 'episodic', title: 'e1', content: 'three' });
    const sem = listMemories(db, key, { type: 'semantic' });
    assert.equal(sem.length, 2);
    const all = listMemories(db, key, {});
    assert.equal(all.length, 3);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('supersede marks the prior memory and replaces it', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const a = saveMemory(db, key, { type: 'semantic', title: 'convention', content: 'tabs' });
    const b = saveMemory(db, key, {
      type: 'semantic',
      title: 'convention',
      content: 'spaces',
      supersede: true,
    });
    const got = getMemory(db, key, b.id);
    assert.equal(got.content, 'spaces');
    const prior = getMemory(db, key, a.id);
    assert.equal(prior, null, 'soft-superseded memory should be hidden by default');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('deleteMemory soft-deletes by default; hard=true removes the row', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'working', content: 'note' });
    assert.equal(deleteMemory(db, key, m.id), true);
    assert.equal(getMemory(db, key, m.id), null);

    const m2 = saveMemory(db, key, { type: 'working', content: 'note2' });
    assert.equal(deleteMemory(db, key, m2.id, { hard: true }), true);
    const row = db.prepare('SELECT id FROM memories WHERE id=?').get(m2.id);
    assert.equal(row, undefined);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories uses FTS for keyword recall', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'API style',
      content: 'We use tabs and single quotes',
    });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'DB style',
      content: 'Postgres for production',
    });
    const r1 = await searchMemories(db, key, 'tabs');
    assert.ok(r1.length >= 1);
    assert.ok(r1[0].content.includes('tabs'));
    const r2 = await searchMemories(db, key, 'postgres');
    assert.ok(r2.length >= 1);
    const r3 = await searchMemories(db, key, 'nothing-here-token');
    assert.equal(r3.length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('expiry: expired memories are hidden by default but listed when includeExpired=true', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'episodic',
      content: 'past',
      expires_at: '2000-01-01T00:00:00.000Z',
    });
    const got = getMemory(db, key, m.id);
    assert.equal(got.expired, true);
    const listed = listMemories(db, key, { includeExpired: true });
    assert.equal(listed.length, 1);
    const clean = listMemories(db, key, {});
    assert.equal(clean.length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('working memory: set/get/clear/list', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    setWorkingMemory(db, key, 'current_focus', 'ship the demo');
    setWorkingMemory(db, key, 'open_questions', 'how to onboard?');
    const a = getWorkingMemory(db, key, 'current_focus');
    assert.equal(a.value, 'ship the demo');
    const list = listWorkingMemory(db, key);
    assert.equal(list.length, 2);
    assert.equal(clearWorkingMemory(db, key, 'current_focus'), true);
    assert.equal(getWorkingMemory(db, key, 'current_focus'), null);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('working-memory slots are isolated by project', () => {
  const home = mkTempHome();
  try {
    const dbPath = path.join(home, 'shared.sqlite');
    const db = openDb(dbPath);
    const a = deriveProjectKey('C:/project-a');
    const b = deriveProjectKey('C:/project-b');
    setWorkingMemory(db, a, 'current_focus', 'alpha');
    setWorkingMemory(db, b, 'current_focus', 'beta');
    assert.equal(getWorkingMemory(db, a, 'current_focus').value, 'alpha');
    assert.equal(getWorkingMemory(db, b, 'current_focus').value, 'beta');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('conversations: record events, list, get, search', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    upsertConversation(db, key, 'sess-1', 'C:/proj');
    recordConversationEvent(db, key, 'sess-1', 1, 0, {
      raw: '{"role":"user","text":"hello"}',
      parsed: { role: 'user', text: 'hello' },
      role: 'user',
      kind: 'message',
      summary: 'hello',
      created_at: '2026-07-01T00:00:00Z',
    });
    recordConversationEvent(db, key, 'sess-1', 2, 30, {
      raw: '{"role":"assistant","text":"hi there"}',
      parsed: { role: 'assistant', text: 'hi there' },
      role: 'assistant',
      kind: 'message',
      summary: 'hi there',
      created_at: '2026-07-01T00:00:01Z',
    });
    const conv = getConversation(db, key, 'sess-1');
    assert.ok(conv);
    const list = listConversations(db, key, {});
    assert.equal(list.length, 1);
    const evs = getConversationEvents(db, key, 'sess-1', {});
    assert.equal(evs.length, 2);
    const hits = searchConversationEvents(db, key, 'hello', {});
    assert.ok(hits.length >= 1);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('ingest state: persisted JSON survives open/close', async () => {
  const { home, key } = freshProject();
  try {
    await ensureProjectDir(home, key);
    const s0 = await loadIngestState(home, key);
    assert.deepEqual(s0.sessions, {});
    s0.sessions['sess-A'] = {
      work_dir_key: 'wdA',
      byte_offset: 123,
      line_count: 4,
      last_event_at: null,
      last_import_at: '2026-07-01T00:00:00Z',
    };
    await saveIngestState(home, key, s0);
    const s1 = await loadIngestState(home, key);
    assert.equal(s1.sessions['sess-A'].byte_offset, 123);
  } finally {
    rmRf(home);
  }
});

test('strict isolation: project A and project B have separate rows', () => {
  const home = mkTempHome();
  try {
    const a = deriveProjectKey('C:/proj-A');
    const b = deriveProjectKey('C:/proj-B');
    const dbA = openDb(projectDbPath(home, a));
    const dbB = openDb(projectDbPath(home, b));
    saveMemory(dbA, a, { type: 'semantic', content: 'A only' });
    saveMemory(dbB, b, { type: 'semantic', content: 'B only' });
    const aList = listMemories(dbA, a, {});
    const bList = listMemories(dbB, b, {});
    assert.equal(aList.length, 1);
    assert.equal(bList.length, 1);
    assert.notEqual(aList[0].id, bList[0].id);
    const cross = getMemory(dbA, a, bList[0].id);
    assert.equal(cross, null);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('projectStatus reports total/active/retained/by_status and latest_update_at', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', content: 'a' });
    saveMemory(db, key, { type: 'semantic', content: 'b' });
    const ep = saveMemory(db, key, { type: 'episodic', content: 'c' });
    setWorkingMemory(db, key, 'current_focus', 'x');
    upsertConversation(db, key, 's', 'C:/p');
    // Seed a prior convention that the next save will supersede.
    const prior = saveMemory(db, key, { type: 'semantic', title: 'convention', content: 'tabs' });
    void prior;
    // Mark the prior convention row soft-superseded (counts toward retained).
    saveMemory(db, key, {
      type: 'semantic',
      title: 'convention',
      content: 'spaces',
      supersede: true,
    });
    // Soft-delete the episodic row.
    deleteMemory(db, key, ep.id);

    const s = projectStatus(db, key);
    // total counts every row: 2 untitled semantics + 1 episodic + 2 conventions = 5.
    assert.equal(s.memories.total, 5, 'total counts every row');
    // Active = 2 untitled semantics + 1 new convention = 3.
    assert.equal(s.memories.active, 3, 'three non-superseded, non-deleted remain');
    // Retained = 1 superseded convention + 1 deleted episodic = 2.
    assert.equal(s.memories.retained, 2, 'retained includes superseded/deleted');
    assert.equal(s.memories.superseded, 1);
    assert.equal(s.memories.deleted, 1);
    assert.equal(s.memories.by_type.semantic, 3, 'three active semantics');
    assert.equal(s.memories.by_status.active, 3);
    assert.equal(s.memories.by_status.superseded, 1);
    assert.equal(s.memories.by_status.deleted, 1);
    assert.ok(
      typeof s.memories.latest_update_at === 'string' && s.memories.latest_update_at.length > 0,
      'latest_update_at is set',
    );
    assert.equal(s.working_memory_slots, 1);
    assert.equal(s.conversations, 1);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('memoryCounts separates active from expired and superseded from deleted', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const exp = saveMemory(db, key, {
      type: 'episodic',
      content: 'old',
      expires_at: '2000-01-01T00:00:00.000Z',
    });
    const sup = saveMemory(db, key, { type: 'semantic', title: 't', content: 'old' });
    const neu = saveMemory(db, key, {
      type: 'semantic',
      title: 't',
      content: 'new',
      supersede: true,
    });
    deleteMemory(db, key, exp.id);
    const c = memoryCounts(db, key);
    assert.equal(c.active, 1, 'one active, non-expired row');
    assert.equal(c.superseded, 1, 'one superseded');
    assert.equal(c.deleted, 1, 'one soft-deleted');
    assert.equal(c.retained, 2, 'retained = superseded + deleted');
    assert.equal(c.total, 3, 'total still counts every row');
    assert.equal(c.expired, 0, 'soft-deleted expired row no longer counts as expired');
    // The new supersede-pair row carries a non-null supersedes pointer back at the prior.
    const newRow = db.prepare('SELECT supersedes FROM memories WHERE id=?').get(neu.id);
    assert.equal(newRow.supersedes, sup.id, 'new row points back at the prior it replaces');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('project and global databases are isolated; global uses literal "_global" key', () => {
  const home = mkTempHome();
  try {
    const projectKey = deriveProjectKey('C:/proj-X');
    const pPath = projectDbPath(home, projectKey);
    const gPath = globalDbPath(home);
    assert.equal(gPath, path.join(home, 'kimi-memory', '_global', 'memory.sqlite'));
    const pDb = openDb(pPath);
    const gDb = openDb(gPath);
    saveMemory(pDb, projectKey, { type: 'semantic', content: 'project only' });
    saveMemory(gDb, GLOBAL_PROJECT_KEY, { type: 'semantic', content: 'global only' });
    // Strict isolation: the project DB never sees the global row and vice-versa.
    assert.equal(listMemories(pDb, projectKey, {}).length, 1);
    assert.equal(listMemories(gDb, GLOBAL_PROJECT_KEY, {}).length, 1);
    assert.equal(memoryCounts(pDb, projectKey).active, 1);
    assert.equal(memoryCounts(gDb, GLOBAL_PROJECT_KEY).active, 1);
    // No cross-leak: a project_key=hash never picks up the global row.
    assert.equal(listMemories(pDb, GLOBAL_PROJECT_KEY, {}).length, 0);
    assert.equal(listMemories(gDb, projectKey, {}).length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('ensureGlobalDir creates the _global directory on demand', async () => {
  const home = mkTempHome();
  try {
    const dir = await ensureGlobalDir(home);
    assert.ok(dir.endsWith('_global'));
  } finally {
    rmRf(home);
  }
});

test('saveMemoryBulk: atomic save across many rows, supersede works inside the batch', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const mems = saveMemoryBulk(db, key, [
      { type: 'semantic', title: 'tabs', content: 'use tabs' },
      { type: 'semantic', title: 'quotes', content: 'single quotes' },
      { type: 'procedural', title: 'release', content: 'git tag && git push --tags' },
      // Later row supersedes the first: same (type, title), supersede=true.
      { type: 'semantic', title: 'tabs', content: 'use spaces', supersede: true },
    ]);
    assert.equal(mems.length, 4);
    // All four rows exist on disk (the prior is retained as superseded).
    const totalRows = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_key=?')
      .get(key).n;
    assert.equal(totalRows, 4, 'all four rows are persisted (one superseded, three active)');
    // The prior "tabs" row is superseded; the new one is active.
    const activeTabs = listMemories(db, key, { type: 'semantic' }).filter(
      (m) => m.title === 'tabs',
    );
    assert.equal(activeTabs.length, 1);
    assert.equal(activeTabs[0].content, 'use spaces');
    assert.equal(
      activeTabs[0].supersedes,
      mems[0].id,
      'new row carries a backlink to the prior it replaced',
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('saveMemoryBulk: empty input is a no-op (returns [])', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const out = saveMemoryBulk(db, key, []);
    assert.deepEqual(out, []);
    assert.equal(listMemories(db, key, {}).length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('openDb sets busy_timeout so concurrent hook + MCP writers do not immediately fail', () => {
  const { home, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // The hook runner and the MCP server are separate processes that
    // both write to the same DB. Without busy_timeout, the second
    // writer hits SQLITE_BUSY immediately. PRAGMA busy_timeout returns
    // a single row with a `timeout` column (not `busy_timeout`).
    const t = db.prepare('PRAGMA busy_timeout').get();
    assert.ok(t && typeof t.timeout === 'number', 'PRAGMA busy_timeout returns a row');
    assert.ok(t.timeout >= 1000, `busy_timeout should be at least 1000ms, got ${t.timeout}`);
  } finally {
    closeDb();
    rmRf(home);
  }
});
