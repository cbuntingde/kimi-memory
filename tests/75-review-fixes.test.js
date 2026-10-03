// Review-pass regressions (full-plugin contract audit). Each test pins
// one fixed finding: the MUSTs (M1-M4) plus the behaviour-changing
// SHOULDs. Doc-only drifts are not asserted here (except the
// machine-checkable command-form ban, which lives in tests/06).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkTempHome, rmRf, StdioMcp, writeRaw } from './_helpers.js';

function writeExtractConfig(home) {
  writeRaw(
    `${home}/config.toml`,
    `
      default_model = "x/m"
      [providers.x]
      type="openai"
      api_key="k"
      base_url="https://example/v1"
      [models."x/m"]
      provider = "x"
      model = "m"
    `,
  );
}
import {
  openDb,
  closeDb,
  saveMemory,
  getMemory,
  linkMemory,
  mergeMemory,
  searchMemories,
  flushEmbeddings,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey, canonicalizeRoot } from '../src/project-key.js';
import { runConsolidate } from '../src/consolidate.js';
import { enqueueDreamJob, generateProposalsForJob, applyDreamJob } from '../src/dream.js';
import { setDreamingState } from '../src/dreaming.js';
import { withSavepoint } from '../src/persist/tx.js';
import {
  recordConversationEvent,
  searchConversationEvents,
  mirrorConversationEventsFts,
} from '../src/persist/project.js';
import { runAutoPrune } from '../src/auto-gc.js';
import { parseArgs } from '../src/cli/lib.js';
import { validateSharedWith, grantMemoryAcl, revokeMemoryAcl } from '../src/acl.js';
import { redactSecrets } from '../src/secrets.js';
import {
  recordSkillInvocation,
  upsertConversation,
  setWorkingMemory,
  listConversations,
  promoteMemoryToGlobal,
} from '../src/persist.js';
import { TOOL_DEFS_BY_NAME } from '../src/mcp/tool-defs.js';
import { runAutoExtract } from '../src/extract.js';
import { EMBEDDING_DIM, _setPipelineStubForTests, _resetForTests } from '../src/embedding.js';

function freshProject(tag) {
  const home = mkTempHome();
  const key = deriveProjectKey(`C:/test/review-75-${tag}`);
  return { home, key, dbPath: projectDbPath(home, key) };
}

async function withEnv(name, value, fn) {
  const prev = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// Deterministic embedding stub (mirrors tests/39 + tests/40b).
function encodeStubForRow(row) {
  const title = (row.title || '').toLowerCase();
  const tags = (Array.isArray(row.tags) ? row.tags : []).map((t) => String(t).toLowerCase());
  const first = title.split(/\s+/)[0] || '';
  let h1 = 0;
  for (let i = 0; i < first.length; i++) h1 = (h1 * 31 + first.charCodeAt(i)) >>> 0;
  const sharedTags = ['dream', 'alpha', 'beta'].filter((t) => tags.includes(t)).length;
  return new Float32Array([
    (h1 % 1000) / 1000,
    0.5,
    sharedTags / 3,
    Math.min(2, title.length / 30),
  ]);
}

async function saveWithEmbedding(db, projectKey, input) {
  const m = saveMemory(db, projectKey, { ...input, _embed: false });
  await new Promise((r) => setImmediate(r));
  const stub = encodeStubForRow(input);
  const blob = Buffer.from(stub.buffer);
  db.prepare(
    `UPDATE memories SET embedding=?, embedding_model=?, embedding_dim=?, embedded_at=?
     WHERE id=?`,
  ).run(blob, 'stub', stub.length, new Date().toISOString(), m.id);
  return m;
}

const decodeStub = (blob) =>
  blob ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4) : null;

// ---------- M1: flushEmbeddings distinguishes drain from timeout ----------

test('M1: flush with no in-flight work reports waited=0, timedOut=false', async () => {
  const r = await flushEmbeddings({ timeoutMs: 20 });
  assert.equal(r.waited, 0);
  assert.equal(r.timedOut, false);
});

test('M1: flush reports timedOut when the drain exceeds the cap, then drains', async () => {
  const { home, key, dbPath } = freshProject('flush');
  const prevEmbed = process.env.KIMI_MEMORY_EMBEDDINGS;
  process.env.KIMI_MEMORY_EMBEDDINGS = 'on';
  // A pipe that lands after 300ms: slow enough to beat a 20ms flush,
  // fast enough for the follow-up drain to observe a clean finish.
  _setPipelineStubForTests(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(async () => ({ data: new Float32Array(EMBEDDING_DIM) })), 300),
      ),
  );
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'flush probe',
      content: 'content for the embedding scheduler',
    });
    const timedOut = await flushEmbeddings({ timeoutMs: 20 });
    assert.equal(timedOut.waited, 1);
    assert.equal(timedOut.timedOut, true);
    const drained = await flushEmbeddings({ timeoutMs: 5000 });
    assert.equal(drained.timedOut, false);
    closeDb();
  } finally {
    _resetForTests();
    if (prevEmbed === undefined) delete process.env.KIMI_MEMORY_EMBEDDINGS;
    else process.env.KIMI_MEMORY_EMBEDDINGS = prevEmbed;
    rmRf(home);
  }
});

// ---------- M2: AUTO_MERGE=off stops pair-level direct merges ----------

test('M2: pair merges honour KIMI_MEMORY_AUTO_MERGE=off and merge when on', async () => {
  const { home, key, dbPath } = freshProject('automerge');
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      type: 'semantic',
      title: 'Exact Same Title',
      content: 'first body with enough words to be a memory',
      tags: ['a'],
      _embed: false,
    });
    await saveWithEmbedding(db, key, {
      type: 'semantic',
      title: 'exact same title',
      content: 'second body with enough words to be a memory',
      tags: ['b'],
    });
    const prev = process.env.KIMI_MEMORY_AUTO_MERGE;
    process.env.KIMI_MEMORY_AUTO_MERGE = 'off';
    try {
      const off = await runConsolidate({
        db,
        projectKey: key,
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
        decodeEmbeddingImpl: decodeStub,
      });
      assert.ok(off.dedup_pairs >= 1, 'detection still runs with the flag off');
      assert.equal(off.merged, 0, 'no pair merge with AUTO_MERGE=off');
      assert.ok(off.mergeSkipped >= 1, 'skipped merges are counted');
      const bothActive = db
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE project_key=? AND status='active'")
        .get(key).n;
      assert.equal(bothActive, 2, 'both rows stay active');
    } finally {
      if (prev === undefined) delete process.env.KIMI_MEMORY_AUTO_MERGE;
      else process.env.KIMI_MEMORY_AUTO_MERGE = prev;
    }
    const on = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decodeStub,
    });
    assert.ok(on.merged >= 1, 'control: the same pair merges with the flag on');
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- M3: DREAM=off gates generate + apply ----------

test('M3: generate + apply return env_opt_out with KIMI_MEMORY_DREAM=off', async () => {
  const { home, key, dbPath } = freshProject('dreamoff');
  try {
    const db = openDb(dbPath);
    const enq = enqueueDreamJob(db, key);
    assert.equal(enq.status, 'enqueued');
    await withEnv('KIMI_MEMORY_DREAM', 'off', async () => {
      const gen = await generateProposalsForJob(db, key, enq.job_id, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
        decodeEmbeddingImpl: decodeStub,
      });
      assert.equal(gen.ok, false);
      assert.equal(gen.reason, 'env_opt_out');
      const app = applyDreamJob(db, key, enq.job_id, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      assert.equal(app.ok, false);
      assert.equal(app.reason, 'env_opt_out');
    });
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- M4: the secret gate scans every persisted string field ----------

test('M4: shared_with, identity columns, scalar tags and processing_status are scanned', () => {
  const { home, key, dbPath } = freshProject('gate');
  try {
    const db = openDb(dbPath);
    const secret = 'api_key = abcdefghijklmnop';
    const base = { type: 'semantic', title: 'clean title', content: 'clean content' };
    for (const [label, extra] of [
      ['shared_with', { shared_with: ['user:alice', `note ${secret}`] }],
      ['team_id', { team_id: secret }],
      ['scalar tags', { tags: secret }],
      ['scalar metadata', { metadata: secret }],
      ['scalar provenance', { provenance: secret }],
      ['processing_status', { processing_status: secret }],
    ]) {
      assert.throws(
        () => saveMemory(db, key, { ...base, ...extra, _embed: false }),
        (e) => e.code === 'KIMI_MEMORY_SECRET_DETECTED',
        `${label} must be refused`,
      );
    }
    // Control: clean values in the same fields persist.
    const m = saveMemory(db, key, {
      ...base,
      shared_with: ['user:alice'],
      team_id: 'team-a',
      tags: ['note'],
      processing_status: 'active',
      _embed: false,
    });
    assert.ok(m.id);
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- F3: the save upsert is scope-checked ----------

test('F3: saving an explicit id owned by another scope throws', () => {
  const { home, key, dbPath } = freshProject('scope');
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, {
      id: 'fixed-id-1234',
      type: 'semantic',
      title: 'owned by key',
      content: 'original content',
      _embed: false,
    });
    assert.throws(
      () =>
        saveMemory(db, 'other-scope', {
          id: 'fixed-id-1234',
          type: 'semantic',
          title: 'hijack attempt',
          content: 'rewritten content',
          _embed: false,
        }),
      /different scope/,
    );
    const row = getMemory(db, key, 'fixed-id-1234');
    assert.equal(row.content, 'original content');
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- F8: savepoint names are validated ----------

test('F8: withSavepoint rejects a non-identifier name', () => {
  const { home, dbPath } = freshProject('savepoint');
  try {
    const db = openDb(dbPath);
    assert.throws(
      () => withSavepoint(db, 'x; DROP TABLE memories', () => {}),
      /invalid savepoint name/,
    );
    assert.equal(
      withSavepoint(db, 'legit_name_1', () => 42),
      42,
      'control: a valid name runs the body',
    );
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- F6: the conversation FTS mirror dedupes; LIKE covers fresh rows ----------

test('F6: repeat mirroring does not duplicate rows; fresh rows stay searchable', () => {
  const { home, key, dbPath } = freshProject('mirror');
  try {
    const db = openDb(dbPath);
    const at = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      recordConversationEvent(db, key, 'sess-1', i, i * 100, {
        raw: `quorum alpha row ${i}`,
        role: 'user',
        kind: 'message',
        created_at: at,
      });
    }
    mirrorConversationEventsFts(db, key);
    mirrorConversationEventsFts(db, key);
    const mirrored = db
      .prepare('SELECT COUNT(*) AS n FROM conversation_events_fts WHERE project_key=?')
      .get(key).n;
    assert.equal(mirrored, 3, 'a repeat mirror must not duplicate rows');
    recordConversationEvent(db, key, 'sess-1', 3, 300, {
      raw: 'quorum xylophone fresh row',
      role: 'user',
      kind: 'message',
      created_at: at,
    });
    const hits = searchConversationEvents(db, key, 'quorum xylophone', {});
    assert.ok(
      hits.some((r) => r.line_no === 3),
      'the post-mirror row is found via the LIKE fallback merge',
    );
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- F2-dream: the legacy gate covers the promo-orphan prune ----------

test('F2: persona_promotions orphans survive pruning with LEGACY_SUBSYSTEMS=off', () => {
  const { home, key, dbPath } = freshProject('promo');
  try {
    const db = openDb(dbPath);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO persona_promotions (id, memory_id, from_tier, to_tier, reason, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('promo-1', 'missing-memory', 'L0', 'L1', 'test', old);
    withEnvSync('KIMI_MEMORY_LEGACY_SUBSYSTEMS', 'off', () => {
      runAutoPrune(db, key);
    });
    const kept = db
      .prepare('SELECT COUNT(*) AS n FROM persona_promotions WHERE id=?')
      .get('promo-1').n;
    assert.equal(kept, 1, 'gated off: the orphan row is untouched');
    runAutoPrune(db, key);
    const gone = db
      .prepare('SELECT COUNT(*) AS n FROM persona_promotions WHERE id=?')
      .get('promo-1').n;
    assert.equal(gone, 0, 'control: the orphan row prunes with the gate on');
    closeDb();
  } finally {
    rmRf(home);
  }
});

function withEnvSync(name, value, fn) {
  const prev = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// ---------- cli-3: boolean flags never swallow a positional ----------

test('cli-3: get --json <id> keeps the positional id', () => {
  const args = parseArgs(['node', 'cli.js', 'get', '--json', 'abc123']);
  assert.equal(args.flags.json, true);
  assert.deepEqual(args.positional, ['abc123']);
});

// ---------- recall-5: MIN_HITS above BASE_LIMIT is clamped ----------

test('recall-5: a floor above the ceiling cannot defeat the hard ceiling', async () => {
  process.env.KIMI_MEMORY_RECALL_MIN_HITS = '10';
  process.env.KIMI_MEMORY_RECALL_BASE_LIMIT = '8';
  try {
    const { RECALL_MIN_HITS, RECALL_BASE_LIMIT } =
      await import('../src/hooks/handlers/lib/constants.js?env=minhits10');
    assert.equal(RECALL_BASE_LIMIT, 8);
    assert.equal(RECALL_MIN_HITS, 8, 'the floor is clamped to the ceiling');
  } finally {
    delete process.env.KIMI_MEMORY_RECALL_MIN_HITS;
    delete process.env.KIMI_MEMORY_RECALL_BASE_LIMIT;
  }
});

// ---------- F3-dream: UNC is refused on POSIX ----------

test('F3-dream: canonicalizeRoot honours the documented UNC contract per platform', () => {
  const unc = '\\\\server\\share\\path';
  if (process.platform === 'win32') {
    assert.ok(typeof canonicalizeRoot(unc) === 'string', 'UNC accepted on Windows');
  } else {
    assert.equal(canonicalizeRoot(unc), null, 'UNC rejected on POSIX');
  }
});

// ---------- S3: bulk save accepts the full save type vocabulary ----------

test('S3: memory_save_bulk items accept context_snapshot', () => {
  const items = TOOL_DEFS_BY_NAME.memory_save_bulk.input.items;
  assert.doesNotThrow(() => items.parse([{ type: 'context_snapshot', content: 'x' }]));
});

// ---------- doc-11: the dreaming MCP tool floors both interval spellings ----------

test('doc-11: dreaming_set refuses a sub-5-minute interval_spec', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const r = await mcp.toolCall('dreaming', {
      cwd: 'C:/test/dreaming-floor',
      args: '{"sub":"on","interval_spec":"30s"}',
    });
    const payload = JSON.parse(r.content[0].text);
    assert.match(payload.error || '', /5 minutes/);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

// ---------- S4: bulk shared_with funnels through dedup + trim + cap ----------

test('S4: bulk shared_with entries are deduped and trimmed like save', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/bulk-shared';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const r = await mcp.toolCall('memory_save_bulk', {
      cwd,
      items: [
        {
          type: 'semantic',
          title: 'bulk grant row',
          content: 'content',
          shared_with: ['user:alice ', 'user:alice'],
        },
      ],
    });
    const payload = JSON.parse(r.content[0].text);
    assert.ok(!r.isError, 'bulk save succeeds');
    const key = deriveProjectKey(cwd);
    const db = openDb(projectDbPath(home, key));
    try {
      const row = getMemory(db, key, payload.memories[0].id);
      assert.deepEqual(row.shared_with, ['user:alice']);
    } finally {
      closeDb();
    }
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('S4-unit: validateSharedWith drops empties and caps at 32', () => {
  const many = Array.from({ length: 40 }, (_, i) => `user:u${i}`);
  const { value, dropped } = validateSharedWith(['', '  ', ...many]);
  assert.equal(value.length, 32);
  assert.ok(dropped.length >= 2 + 8, 'empties and over-cap entries are reported');
});

// ---------- F3-extract: dedup titles are redacted before the LLM call ----------

test('F3-extract: existingTitles reach the prompt redacted', async () => {
  const { home, key, dbPath } = freshProject('titles');
  writeExtractConfig(home);
  try {
    const db = openDb(dbPath);
    let capturedUser = null;
    await runAutoExtract({
      homeDir: home,
      cwd: 'C:/test/extract-titles',
      projectKey: key,
      db,
      transcript: 'we discussed the release plan',
      existingTitles: ['Deploy with GH_PAT=abcdef1234567890abcdef attached'],
      saveMemory,
      searchMemories,
      callLlm: async ({ user }) => {
        capturedUser = user;
        return '[]';
      },
    });
    assert.ok(capturedUser, 'the LLM was called');
    assert.ok(
      !capturedUser.includes('abcdef1234567890abcdef'),
      'secret bytes from a title must not reach the prompt',
    );
    assert.match(capturedUser, /\[REDACTED_ASSIGNED_SECRET\]/);
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- F4-extract: an empty LLM reply consumes its retry ----------

test('F4-extract: an empty first reply is retried, not scored llm_no_reply', async () => {
  const { home, key, dbPath } = freshProject('retry');
  writeExtractConfig(home);
  try {
    const db = openDb(dbPath);
    let calls = 0;
    const r = await runAutoExtract({
      homeDir: home,
      cwd: 'C:/test/extract-retry',
      projectKey: key,
      db,
      transcript: 'we discussed the release plan',
      saveMemory,
      searchMemories,
      callLlm: async () => {
        calls += 1;
        return calls === 1 ? '' : '[]';
      },
    });
    assert.equal(calls, 2, 'the empty reply consumed the retry');
    assert.notEqual(r.skipped, 'llm_no_reply');
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- D3: extract is not an accepted dreaming include ----------

test('D3: setDreamingState drops extract from the include list', async () => {
  const home = mkTempHome();
  try {
    const next = await setDreamingState({
      projectKey: 'abc',
      include: ['consolidate', 'extract'],
      kimiHomeDir: home,
    });
    assert.deepEqual(next.include, ['consolidate']);
  } finally {
    rmRf(home);
  }
});

// ---------- F4-dream: per-proposal failures count as stale, not failed ----------

test('F4-dream: apply counts thrown proposals as stale and nothing as failed', async () => {
  const { home, key, dbPath } = freshProject('stalecount');
  try {
    const db = openDb(dbPath);
    for (const title of ['stale one', 'stale two', 'stale three']) {
      await saveWithEmbedding(db, key, {
        type: 'semantic',
        title,
        content: 'tag-share',
        tags: ['dream', 'alpha', 'beta'],
      });
    }
    const enq = enqueueDreamJob(db, key);
    const gen = await generateProposalsForJob(db, key, enq.job_id, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      decodeEmbeddingImpl: decodeStub,
    });
    assert.equal(gen.ok, true);
    assert.ok(gen.proposal_ids.length > 0, 'the fixture must produce proposals');
    // Only the conclusion path can throw out of applyProposal (link and
    // merge catch internally and return 'reject'), so only saveMemory
    // throws here.
    const throwing = () => {
      throw new Error('boom');
    };
    const res = applyDreamJob(db, key, enq.job_id, {
      saveMemory: throwing,
      memoryLink: linkMemory,
      mergeMemory,
      autoApplyConfidence: null,
    });
    assert.equal(res.ok, true);
    assert.ok(res.stale > 0, 'thrown conclusion proposals are counted stale');
    // The return contract: each count names a proposal row class.
    const count = (status) =>
      db
        .prepare('SELECT COUNT(*) AS n FROM dream_proposals WHERE job_id=? AND status=?')
        .get(enq.job_id, status).n;
    assert.equal(res.stale, count('stale'), 'stale count matches stale rows');
    assert.equal(res.failed, count('rejected'), 'failed counts rejections only');
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- secrets lookahead: provider tokens survive the assignment pass ----------

test('secrets: a PAT-named provider key keeps its provider token', () => {
  const out = redactSecrets('GitHub PAT: ghp_abcdefghijklmnopqrstuvwxyz012345');
  assert.match(out, /\[REDACTED_PROVIDER_KEY\]/);
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'));
});

// ---------- F4: promotions re-screen the full row and honour the hatch ----------

test('F4: promote skips secret-bearing tags; SECRET_SCAN=off bypasses', () => {
  const { home, key, dbPath } = freshProject('promoscan');
  try {
    const db = openDb(dbPath);
    const secret = 'api_key = abcdefghijklmnop';
    const m = withEnvSync('KIMI_MEMORY_SECRET_SCAN', 'off', () =>
      saveMemory(db, key, {
        type: 'semantic',
        title: 'tainted row',
        content: 'clean content',
        tags: ['ci', secret],
        _embed: false,
      }),
    );
    const skipped = promoteMemoryToGlobal(db, key, [m.id], { kimiHomeDir: home });
    assert.deepEqual(
      skipped.skipped.map((s) => s.reason),
      ['secret_detected'],
    );
    const moved = withEnvSync('KIMI_MEMORY_SECRET_SCAN', 'off', () =>
      promoteMemoryToGlobal(db, key, [m.id], { kimiHomeDir: home }),
    );
    assert.equal(moved.moved.length, 1, 'the documented hatch bypasses the screen');
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- F5 + F10: skill, conversation and slot writers are gated ----------

test('F5/F10: toolName, cwd and slot names are secret-screened', () => {
  const { home, key, dbPath } = freshProject('writergate');
  try {
    const db = openDb(dbPath);
    const secret = 'api_key = abcdefghijklmnop';
    assert.throws(
      () => recordSkillInvocation(db, key, 'skill-x', { success: 1, toolName: secret }),
      /secret_detected/,
    );
    assert.throws(
      () => upsertConversation(db, key, 'sess-1', `C:/work/${secret}`),
      /secret_detected/,
    );
    assert.throws(() => setWorkingMemory(db, key, secret, 'value'), /secret_detected/);
    // Controls: clean values in the same positions persist.
    recordSkillInvocation(db, key, 'skill-x', { success: 1, toolName: 'memory_save' });
    upsertConversation(db, key, 'sess-1', 'C:/work/clean');
    setWorkingMemory(db, key, 'current_focus', 'value');
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- F7: float/NaN limits degrade to the fallback ----------

test('F7: a NaN conversation limit returns rows instead of throwing', () => {
  const { home, key, dbPath } = freshProject('nanlimit');
  try {
    const db = openDb(dbPath);
    upsertConversation(db, key, 'sess-1', 'C:/work/clean');
    const rows = listConversations(db, key, { limit: Number.NaN });
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- acl trim: revoke matches a grant despite padding ----------

test('acl-trim: revoke trims the principal id like grant does', () => {
  const { home, key, dbPath } = freshProject('acltrim');
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, {
      type: 'semantic',
      title: 'grant row',
      content: 'content',
      _embed: false,
    });
    grantMemoryAcl(db, key, m.id, 'user', 'alice');
    assert.equal(revokeMemoryAcl(db, key, m.id, 'user', '  alice  '), true);
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---------- S5: the reset error names the key, not the path ----------

test('S5: reset on a missing DB reports the key without a filesystem path', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const r = await mcp.toolCall('memory_reset_project', { cwd: 'C:/test/reset-missing' });
    assert.equal(r.isError, true);
    const text = r.content[0].text;
    assert.match(text, /no project DB for this project yet/);
    assert.match(text, new RegExp(deriveProjectKey('C:/test/reset-missing')));
    assert.ok(!/(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp)\/)/.test(text), 'no absolute path leaks');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

// ---------- recall enum: the filter accepts conclusion + skill ----------

test('recall-enum: memory_recall type filter accepts conclusion and skill', () => {
  const t = TOOL_DEFS_BY_NAME.memory_recall.input.type;
  assert.doesNotThrow(() => t.parse('conclusion'));
  assert.doesNotThrow(() => t.parse('skill'));
});

// ---------- D28: the advisor sample uses namespaced command forms ----------

test('D28: advisor output-format sample has no bare /advisor or /reflect', () => {
  const text = readFileSync(
    path.join(import.meta.dirname, '..', 'skills', 'advisor', 'references', 'output-format.md'),
    'utf8',
  );
  const stripped = text.replace(/\/kimi-memory:advisor/g, '');
  // Filesystem paths (managed/advisor/…) are fine; bare slash-command
  // references are not.
  assert.ok(!/(?<!managed)\/advisor\b/.test(stripped), 'no bare /advisor reference');
  assert.ok(!/\/reflect\b/.test(stripped), 'no /reflect reference');
});
