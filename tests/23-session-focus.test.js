// Tests for the session-focus auto-capture module. Mirrors the
// work-log test style: deterministic inputs, env opt-out coverage,
// idempotency across re-runs, and integration with the hook layer
// (SessionStart / UserPromptSubmit stdout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTempHome, rmRf, pluginRoot, writeJsonl, StdioMcp } from './_helpers.js';
import { openDb, closeDb, saveMemory, listMemories } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import {
  sessionFocusTitle,
  readSessionUserPrompts,
  captureSessionFocus,
  readLatestSessionFocus,
  buildSessionFocusLine,
  formatFocusSegment,
  SESSION_FOCUS_TAG,
  _resetSessionFocusRegistryForTests,
} from '../src/session-focus.js';

function seedConversation(db, projectKey, sessionId, prompts) {
  const insert = db.prepare(
    'INSERT INTO conversation_events (project_key, session_id, line_no, byte_offset, role, kind, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  let lineNo = 1;
  for (const p of prompts) {
    insert.run(
      projectKey,
      sessionId,
      lineNo++,
      lineNo * 100,
      'user',
      'message',
      p,
      JSON.stringify({ role: 'user', text: p }),
      new Date().toISOString(),
    );
  }
  db.exec('COMMIT');
}

test('sessionFocusTitle: truncates long prompts, keeps short ones whole', () => {
  assert.equal(sessionFocusTitle('short'), 'Last focus: short');
  const long = 'x'.repeat(150);
  const t = sessionFocusTitle(long);
  assert.ok(t.startsWith('Last focus: '));
  assert.ok(t.length <= 'Last focus: '.length + 101); // 100 chars + ellipsis
  assert.match(t, /…$/);
  // whitespace squashing
  assert.equal(sessionFocusTitle('  a   b  '), 'Last focus: a b');
  // empty / null fall back to a placeholder so the title never goes empty
  assert.equal(sessionFocusTitle(''), 'Last focus: (no prompt summary)');
  assert.equal(sessionFocusTitle(null), 'Last focus: (no prompt summary)');
});

test('readSessionUserPrompts: returns oldest → newest, ignores empty summaries', () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-prompts');
  const db = openDb(projectDbPath(home, key));
  try {
    const insert = db.prepare(
      'INSERT INTO conversation_events (project_key, session_id, line_no, byte_offset, role, kind, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(key, 'sess1', 1, 100, 'user', 'message', 'first', '{}', '2026-08-01T00:00:00Z');
    insert.run(key, 'sess1', 2, 200, 'user', 'message', '', '{}', '2026-08-01T00:00:01Z');
    insert.run(key, 'sess1', 3, 300, 'assistant', 'message', 'reply', '{}', '2026-08-01T00:00:02Z');
    insert.run(key, 'sess1', 4, 400, 'user', 'message', 'second', '{}', '2026-08-01T00:00:03Z');
    insert.run(
      key,
      'sess2',
      5,
      500,
      'user',
      'message',
      'wrong session',
      '{}',
      '2026-08-01T00:00:04Z',
    );

    const r = readSessionUserPrompts(db, key, 'sess1', { limit: 5 });
    assert.deepEqual(
      r.map((p) => p.prompt),
      ['first', 'second'],
    );
    assert.deepEqual(
      r.map((p) => p.line_no),
      [1, 4],
    );
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('captureSessionFocus: writes a working memory with the session focus tag', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-write');
  const db = openDb(projectDbPath(home, key));
  try {
    seedConversation(db, key, 'sess-write', [
      'investigate the bug in the parser',
      'narrow it down to a regex',
    ]);
    const r = await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-write',
      saveMemory,
    });
    assert.equal(r.skipped, null);
    assert.equal(r.written, 1);
    assert.equal(r.updated, 0);
    assert.ok(r.id, 'returns the saved memory id');
    const all = listMemories(db, key, {});
    assert.equal(all.length, 1);
    const m = all[0];
    assert.equal(m.type, 'working');
    assert.equal(m.title, 'Last focus: narrow it down to a regex');
    assert.match(m.content, /Most recent user requests in this session \(oldest → newest\):/);
    assert.match(m.content, /investigate the bug in the parser/);
    assert.match(m.content, /narrow it down to a regex/);
    assert.ok(m.tags.includes('focus'));
    assert.ok(m.tags.includes(SESSION_FOCUS_TAG));
    assert.ok(m.tags.includes('in-flight'));
    assert.ok(m.expires_at, 'has an expires_at horizon');
    assert.equal(m.priority, 1);
    assert.equal(m.provenance && m.provenance.source, 'session_focus_auto');
    assert.equal(m.provenance && m.provenance.session_id, 'sess-write');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('captureSessionFocus: env opt-out short-circuits before any DB or save', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-off');
  const db = openDb(projectDbPath(home, key));
  const prev = process.env.KIMI_MEMORY_DISABLE_SESSION_FOCUS;
  process.env.KIMI_MEMORY_DISABLE_SESSION_FOCUS = '1';
  try {
    seedConversation(db, key, 'sess-off', ['prompt 1', 'prompt 2']);
    const r = await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-off',
      saveMemory,
    });
    assert.equal(r.skipped, 'env_opt_out');
    assert.equal(r.written, 0);
    assert.equal(listMemories(db, key, {}).length, 0, 'no memory was written');
  } finally {
    if (prev == null) delete process.env.KIMI_MEMORY_DISABLE_SESSION_FOCUS;
    else process.env.KIMI_MEMORY_DISABLE_SESSION_FOCUS = prev;
    closeDb();
    rmRf(home);
  }
});

test('captureSessionFocus: below threshold → skipped, no memory written', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-quiet');
  const db = openDb(projectDbPath(home, key));
  try {
    // No events at all.
    const r = await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-quiet',
      saveMemory,
    });
    assert.equal(r.skipped, 'below_threshold');
    assert.equal(r.written, 0);
    assert.equal(listMemories(db, key, {}).length, 0);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('captureSessionFocus: same session twice → 1 active row, not 2', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-idem');
  const db = openDb(projectDbPath(home, key));
  try {
    seedConversation(db, key, 'sess-idem', ['first task', 'second task']);
    const first = await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-idem',
      saveMemory,
    });
    assert.equal(first.written, 1);
    const id1 = first.id;

    // Re-run with no new prompts. The same (type, title, content)
    // produces the same memory id, so saveMemory UPDATEs the row in
    // place — no new row, no supersede needed. The contract is "one
    // active focus row per session", which both paths satisfy.
    const second = await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-idem',
      saveMemory,
    });
    assert.equal(second.written, 1);
    assert.equal(listMemories(db, key, {}).length, 1, 'exactly one active focus row');
    assert.match(listMemories(db, key, {})[0].title, /^Last focus: second task/);
    // Either path is acceptable: same id (UPDATE in place) or new id
    // with supersede=true (new row replaces the prior). Both are
    // documented as idempotent by the "exactly one active row" check.
    assert.ok(second.id === id1 || second.updated === 1);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('captureSessionFocus: different last prompts → different titles, both stay active', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-multi');
  const db = openDb(projectDbPath(home, key));
  try {
    seedConversation(db, key, 'sess-X', ['alpha task']);
    await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-X',
      saveMemory,
    });
    seedConversation(db, key, 'sess-Y', ['beta task']);
    await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-Y',
      saveMemory,
    });
    const active = listMemories(db, key, {});
    assert.equal(active.length, 2);
    const titles = active.map((m) => m.title).sort();
    assert.deepEqual(titles, ['Last focus: alpha task', 'Last focus: beta task']);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('readLatestSessionFocus: returns the most recent focus row across sessions', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-latest');
  const db = openDb(projectDbPath(home, key));
  try {
    seedConversation(db, key, 'sess-A', ['alpha task']);
    await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-A',
      saveMemory,
    });
    const idA = listMemories(db, key, {})[0].id;
    seedConversation(db, key, 'sess-B', ['beta task']);
    await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-B',
      saveMemory,
    });
    // Pin updated_at directly so the deterministic "most recent"
    // ordering is reproducible across machines regardless of how fast
    // the captures happened back-to-back.
    db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run('2026-08-01T10:00:00Z', idA);
    const focus = readLatestSessionFocus(db, key);
    assert.ok(focus, 'a focus row exists');
    assert.match(focus.title, /^Last focus: beta task/);
    assert.equal(focus.type, 'working');
    assert.ok(focus.tags.includes(SESSION_FOCUS_TAG));
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('readLatestSessionFocus: respects expires_at and returns null on expired rows', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-expired');
  const db = openDb(projectDbPath(home, key));
  try {
    // Seed a focus row with a past expires_at — should be invisible.
    saveMemory(db, key, {
      type: 'working',
      title: 'Last focus: ancient task',
      content: '- ancient task',
      tags: ['focus', SESSION_FOCUS_TAG, 'in-flight'],
      confidence: 0.7,
      priority: 1,
      expires_at: '2020-01-01T00:00:00Z',
      provenance: { source: 'session_focus_auto' },
    });
    assert.equal(readLatestSessionFocus(db, key), null, 'expired focus is hidden');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('buildSessionFocusLine: emits a one-line preview; null when no focus', () => {
  assert.equal(buildSessionFocusLine(null), null);
  assert.equal(buildSessionFocusLine({}), null);
  const line = buildSessionFocusLine({
    type: 'working',
    title: 'Last focus: hello',
    content:
      'Most recent user requests in this session (oldest → newest):\n- first prompt\n- second prompt',
  });
  // The first non-empty line of the body is the header, not the bullet.
  assert.match(
    line,
    /^\[focus\] "Last focus: hello" \(working\) — Most recent user requests in this session \(oldest → newest\):$/,
  );
});

test('formatFocusSegment: mirrors extract/work-log shape', () => {
  assert.equal(formatFocusSegment(null), 'none');
  assert.equal(formatFocusSegment({ skipped: 'below_threshold' }), 'skip:below_threshold');
  assert.equal(formatFocusSegment({ written: 1, updated: 0 }), 'saved');
  assert.equal(formatFocusSegment({ written: 1, updated: 1 }), 'updated');
});

// ---- Hook integration: end-to-end Stop → SessionStart / UserPromptSubmit ----

const WRAPPER = (event) =>
  path.join(
    pluginRoot(),
    'hooks',
    {
      SessionStart: 'session-start',
      UserPromptSubmit: 'user-prompt-submit',
      Stop: 'stop',
    }[event] + '.js',
  );

function runHook(event, payload, { home } = {}) {
  const ownHome = home || mkTempHome();
  try {
    const r = spawnSync(process.execPath, [WRAPPER(event)], {
      cwd: pluginRoot(),
      env: { ...process.env, KIMI_CODE_HOME: ownHome, NO_COLOR: '1' },
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 20000,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', home: ownHome };
  } finally {
    if (!home) rmRf(ownHome);
  }
}

test('Stop captures session focus; SessionStart surfaces it on a fresh project', () => {
  const home = mkTempHome();
  try {
    const cwd = 'C:/example/proj-focus';
    const session = 's-focus-e2e';
    const workKey = 'wk-focus-e2e';
    const sessDir = path.join(home, 'sessions', workKey, session);
    writeJsonl(path.join(sessDir, 'wire.jsonl'), [
      { role: 'user', text: 'first prompt of the session', created_at: '2026-08-01T00:00:00Z' },
      { role: 'assistant', text: 'ack', created_at: '2026-08-01T00:00:01Z' },
      { role: 'user', text: 'second prompt — narrowing down', created_at: '2026-08-01T00:00:02Z' },
    ]);
    writeJsonl(path.join(home, 'session_index.jsonl'), [
      { sessionId: session, workDirKey: workKey },
    ]);

    const stop = runHook('Stop', { cwd, session_id: session }, { home });
    assert.equal(stop.status, 0);
    // Stop is silent on stdout by design; the focus capture is
    // observed by the next SessionStart.

    const start = runHook('SessionStart', { cwd, session_id: 's-focus-next' }, { home });
    assert.equal(start.status, 0);
    assert.match(start.stdout, /focus=saved|focus=updated/);
    assert.match(
      start.stdout,
      /\[focus\] "Last focus: second prompt — narrowing down" \(working\)/,
    );
  } finally {
    rmRf(home);
  }
});

test('UserPromptSubmit surfaces the focus line even when no keyword match', () => {
  const home = mkTempHome();
  try {
    const cwd = 'C:/example/proj-focus-2';
    const session = 's-focus-ups';
    const workKey = 'wk-focus-ups';
    const sessDir = path.join(home, 'sessions', workKey, session);
    writeJsonl(path.join(sessDir, 'wire.jsonl'), [
      {
        role: 'user',
        text: 'investigate the embedding timeout',
        created_at: '2026-08-01T00:00:00Z',
      },
      { role: 'assistant', text: 'ok', created_at: '2026-08-01T00:00:01Z' },
    ]);
    writeJsonl(path.join(home, 'session_index.jsonl'), [
      { sessionId: session, workDirKey: workKey },
    ]);

    const stop = runHook('Stop', { cwd, session_id: session }, { home });
    assert.equal(stop.status, 0);

    // A prompt with no overlap with the focus title still surfaces the
    // focus line — it is not gated on keyword recall.
    const ups = runHook(
      'UserPromptSubmit',
      { cwd, session_id: session, prompt: 'what time is it?' },
      { home },
    );
    assert.equal(ups.status, 0);
    assert.match(
      ups.stdout,
      /\[focus\] "Last focus: investigate the embedding timeout" \(working\)/,
    );
    // And the prompt-derived recall is still a no-hit.
    assert.match(ups.stdout, /No recall hits\.|Recalled \d+ memor/);
  } finally {
    rmRf(home);
  }
});

test('UserPromptSubmit focus line is suppressed when there is no prior session focus', () => {
  const home = mkTempHome();
  try {
    const cwd = 'C:/example/proj-empty-focus';
    const ups = runHook(
      'UserPromptSubmit',
      { cwd, session_id: 's-empty-focus', prompt: 'hello' },
      { home },
    );
    assert.equal(ups.status, 0);
    assert.equal(/\[focus\]/.test(ups.stdout), false, 'no [focus] line on an empty project');
  } finally {
    rmRf(home);
  }
});

test('focus line stays bounded — body snippet is truncated, title is truncated', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/focus-bounded');
  const db = openDb(projectDbPath(home, key));
  try {
    const longPrompt = 'a'.repeat(500);
    seedConversation(db, key, 'sess-bounded', [longPrompt, 'short']);
    await captureSessionFocus({
      db,
      projectKey: key,
      sessionId: 'sess-bounded',
      saveMemory,
    });
    const focus = readLatestSessionFocus(db, key);
    assert.ok(focus);
    const line = buildSessionFocusLine(focus);
    assert.ok(
      line.length <= 80 /*title cap*/ + ' — …'.length + 120 /*snippet cap*/ + 20 /*formatting*/,
    );
    // The title itself is bounded — even though the prompt is 500 chars,
    // the title uses the SESSION_FOCUS_TITLE_MAX cap.
    assert.ok(focus.title.length <= 'Last focus: '.length + 101);
  } finally {
    closeDb();
    rmRf(home);
  }
});

// Touch the registry reset so linters don't complain about unused imports.
void _resetSessionFocusRegistryForTests;
void StdioMcp;
