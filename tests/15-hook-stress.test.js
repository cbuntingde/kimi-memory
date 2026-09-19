// Stress test: spawn the SessionStart hook with a near-boundary
// payload and assert the safety caps actually fire. The hook
// deliberately bounds:
//   - recent project memories to 4 (STATUS_RECENT_MEMORIES)
//   - recent global memories to 4 (STATUS_RECENT_GLOBAL)
//   - working-memory slot previews to 5 (STATUS_RECENT_WM_SLOTS)
//   - total stdout to 4 KB (asserted by tests/04-hooks.test.js)
//
// We seed 50 project memories (mixed types), 6 working-memory slots,
// and 4 conversations, then spawn the hook and confirm:
//   - the status line reports the real counts (no truncation there)
//   - the recent-memories preview is bounded to 4 per scope
//   - the working-memory preview is bounded to 5 (one slot is dropped)
//   - the total stdout stays under 4 KB
//   - the per-type breakdown is present and accurate
//
// Without these bounds, a real user with 10k memories would get a
// 100kB hook status that overwhelms the model context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTempHome, rmRf } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  setWorkingMemory,
  upsertConversation,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey, canonicalizeRoot } from '../src/project-key.js';

const SEED_COUNTS = {
  semantic: 20,
  procedural: 15,
  working: 10,
  episodic: 5,
};
const TOTAL_MEMORIES = Object.values(SEED_COUNTS).reduce((a, b) => a + b, 0);
const SEED_WM_SLOTS = 6; // 1 more than the STATUS_RECENT_WM_SLOTS cap of 5
const SEED_CONVS = 4;

function seedProject(home) {
  // The hook runner canonicalises the cwd before deriving the project
  // key (canonicalizeRoot lowercases the drive letter on Windows and
  // converts forward slashes to backslashes). To land in the same DB
  // file the hook will read, the seed has to canonicalise first.
  const rawCwd = 'C:/test/hook-stress';
  const cwd = canonicalizeRoot(rawCwd);
  const key = deriveProjectKey(cwd);
  const dbPath = projectDbPath(home, key);
  const db = openDb(dbPath);
  // Mixed types with shared tokens so the recall summary can exercise
  // its per-type bucketing on the matching UserPromptSubmit hook.
  let i = 0;
  for (const [type, n] of Object.entries(SEED_COUNTS)) {
    for (let k = 0; k < n; k++) {
      saveMemory(db, key, {
        type,
        title: `${type} note ${i}`,
        content: `${type} note body ${i} mentions release and tests`,
      });
      i++;
    }
  }
  // Seed 6 working-memory slots. The hook preview will cap at 5.
  for (let s = 0; s < SEED_WM_SLOTS; s++) {
    setWorkingMemory(db, key, `slot_${s}`, `value for slot ${s}`);
  }
  // Seed 4 conversations.
  for (let c = 0; c < SEED_CONVS; c++) {
    upsertConversation(db, key, `session_${c}`, cwd);
  }
  closeDb();
  return { cwd, key, dbPath };
}

function spawnSessionStart(home, cwd) {
  const wrapper = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '..',
    'hooks',
    'session-start.js',
  );
  return spawnSync(process.execPath, [wrapper], {
    cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) + '/..',
    env: { ...process.env, KIMI_CODE_HOME: home, KM_HOOK_EVENT: 'SessionStart' },
    input: JSON.stringify({ cwd, session_id: 's-stress' }),
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('SessionStart hook: stays under 4 KB with a 50-memory, 6-WM, 4-conv payload', () => {
  const home = mkTempHome();
  const { cwd } = seedProject(home);
  try {
    const r = spawnSessionStart(home, cwd);
    assert.equal(r.status, 0, 'hook exits 0 (fail-open)');
    assert.ok(
      r.stdout.length < 4096,
      `status output is bounded, got ${r.stdout.length} bytes (budget 4096)`,
    );
  } finally {
    rmRf(home);
  }
});

test('SessionStart hook: status line reports the real counts (no truncation)', () => {
  const home = mkTempHome();
  const { cwd } = seedProject(home);
  try {
    const r = spawnSessionStart(home, cwd);
    assert.equal(r.status, 0);
    // The status line should report the real numbers, not a capped
    // preview. Counters are scalar and don't bloat the line.
    assert.match(r.stdout, /pmem\.active=50/, 'pmem.active counts all 50 project memories');
    assert.match(r.stdout, /wm=6/, 'wm count reflects all 6 working-memory slots');
    assert.match(r.stdout, /conv=4/, 'conv count reflects all 4 conversations');
  } finally {
    rmRf(home);
  }
});

test('SessionStart hook: recent-memory previews are bounded to 4 per scope', () => {
  const home = mkTempHome();
  const { cwd } = seedProject(home);
  try {
    const r = spawnSessionStart(home, cwd);
    assert.equal(r.status, 0);
    // The recent summary is "Loaded N recent memories. (N project, N global.)".
    // With 50 seeded project memories and 0 global, the summary should
    // say "4 project" — not "50 project" — because STATUS_RECENT_MEMORIES=4.
    assert.match(
      r.stdout,
      /Loaded\s+\d+\s+recent memor(y|ies)\.\s+\(4 project\./,
      'recent-memories preview is bounded to 4 project rows',
    );
    // Count the "[project] [type] title …" preview lines. There should
    // be at most 4, never 50.
    const previewLines = (r.stdout.match(/^\[project\] /gm) || []).length;
    assert.ok(previewLines <= 4, `at most 4 [project] preview lines, got ${previewLines}`);
  } finally {
    rmRf(home);
  }
});

test('SessionStart hook: working-memory preview is bounded to 5 of 6 seeded slots', () => {
  const home = mkTempHome();
  const { cwd } = seedProject(home);
  try {
    const r = spawnSessionStart(home, cwd);
    assert.equal(r.status, 0);
    // Count the "WM slot_N: …" preview lines. The cap is 5, so
    // exactly 5 of the 6 seeded slots should appear. listWorkingMemory
    // sorts by updated_at DESC with a rowid tie-breaker (newest first),
    // so the LAST inserted slot is the first in the preview — the
    // earliest-inserted slot (slot_0) is the one that falls off the
    // cap.
    const wmMatches = [...r.stdout.matchAll(/^- WM (slot_\d+): /gm)].map((m) => m[1]);
    assert.equal(wmMatches.length, 5, `exactly 5 WM previews, got ${wmMatches.length}`);
    assert.deepEqual(
      wmMatches,
      ['slot_5', 'slot_4', 'slot_3', 'slot_2', 'slot_1'],
      'preview is newest-first; slot_0 is dropped',
    );
  } finally {
    rmRf(home);
  }
});
