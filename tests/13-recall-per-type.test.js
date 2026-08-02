// Tests for the production-readiness fixes added in v0.3.x:
//  - per-type recall + relevance threshold in searchMemories
//  - includeScore option in searchMemories
//  - embedding last_embed_error column
//  - recordProjectPath move detection (last_canonical_root)
//  - advisor negation gating
//  - secret scrubbing in runAutoExtract
//  - memory_save_bulk collects all per-item errors
//  - memory_save_bulk accepts 'conclusion' type and synthesizes[]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkTempHome, rmRf, StdioMcp, writeRaw } from './_helpers.js';
import {
  openDb,
  closeDb,
  saveMemory,
  getMemory,
  searchMemories,
  recordProjectPath,
  listProjectPaths,
} from '../src/persist.js';
import { projectDbPath, deriveProjectKey, canonicalizeRoot } from '../src/project-key.js';
import { matchAdvisor, _negatedMatches } from '../src/advisor/detect.js';
import { looksLikeSecret, runAutoExtract } from '../src/extract.js';
import { _resetForTests } from '../src/embedding.js';

function freshProject() {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/per-type-A');
  return { home, key, dbPath: projectDbPath(home, key) };
}

test('searchMemories: perType returns a balanced selection across types', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Two memories of different types. The relevance threshold (0.2)
    // drops the third-ranked FTS hit, so we cap at two to keep the
    // test focused on the per-type bucketing behavior.
    saveMemory(db, key, { type: 'semantic', title: 'tabs', content: 'release: tabs for indent' });
    saveMemory(db, key, {
      type: 'working',
      title: 'focus',
      content: 'release: ship v0.3 by Friday',
    });
    const perTypeResults = await searchMemories(db, key, 'release', {
      limit: 6,
      perType: true,
      perTypeLimit: 2,
    });
    const perTypeTypes = new Set(perTypeResults.map((m) => m.type));
    assert.equal(perTypeResults.length, 2, 'both rows pass through per-type bucketing');
    assert.ok(perTypeTypes.has('semantic'), 'per-type recall surfaces semantic rows');
    assert.ok(perTypeTypes.has('working'), 'per-type recall surfaces working rows');
    // The same query without perType returns the same set; the
    // perType bucketing changes ordering but not membership when
    // only two types are present.
    const defaultResults = await searchMemories(db, key, 'release', { limit: 6 });
    assert.equal(defaultResults.length, perTypeResults.length);
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories: perTypeLimit caps the per-type selection', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    // Four semantic rows. The relevance threshold drops the
    // 3rd-rank and below, so two survive. perTypeLimit=1 caps the
    // per-type selection at one, even though two semantic rows
    // passed the threshold.
    saveMemory(db, key, { type: 'semantic', title: 's1', content: 'release: first semantic' });
    saveMemory(db, key, { type: 'semantic', title: 's2', content: 'release: second semantic' });
    saveMemory(db, key, { type: 'semantic', title: 's3', content: 'release: third semantic' });
    saveMemory(db, key, { type: 'semantic', title: 's4', content: 'release: fourth semantic' });
    const perTypeOne = await searchMemories(db, key, 'release', {
      limit: 6,
      perType: true,
      perTypeLimit: 1,
    });
    const perTypeTwo = await searchMemories(db, key, 'release', {
      limit: 6,
      perType: true,
      perTypeLimit: 2,
    });
    assert.equal(perTypeOne.length, 1, 'perTypeLimit=1 caps at one row');
    assert.equal(perTypeTwo.length, 2, 'perTypeLimit=2 caps at two rows');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories: minScore filter drops marginal matches', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'tabs', content: 'we use tabs for indent' });
    saveMemory(db, key, {
      type: 'semantic',
      title: 'unrelated',
      content: 'completely different topic',
    });
    // 'tabs' matches the first row strongly; the second has no FTS hit
    // and no vector hit (embeddings off in tests), so the score is 0.
    const strict = await searchMemories(db, key, 'tabs', { minScore: 0.1 });
    const lenient = await searchMemories(db, key, 'tabs', { minScore: 0 });
    assert.ok(strict.length >= 1, 'the strong match survives the threshold');
    assert.ok(lenient.length >= strict.length, 'lower threshold returns at least as many');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('searchMemories: includeScore attaches the per-channel scores', async () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    saveMemory(db, key, { type: 'semantic', title: 'tabs', content: 'we use tabs for indent' });
    const r = await searchMemories(db, key, 'tabs', { includeScore: true });
    assert.ok(r.length >= 1);
    assert.ok(typeof r[0].score === 'number', 'combined score is attached');
    assert.ok(typeof r[0].fts_score === 'number', 'fts score is attached');
    assert.ok(typeof r[0].vec_score === 'number', 'vec score is attached');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('embed error column is exposed via rowToMemory when last_embed_error is set', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    const m = saveMemory(db, key, { type: 'semantic', title: 't', content: 'c' });
    // Without an embedding, status is 'pending'.
    const got = getMemory(db, key, m.id);
    assert.equal(got.embedding_status, 'pending');
    assert.equal(got.last_embed_error, null);
    // Stamp an error directly.
    db.prepare('UPDATE memories SET last_embed_error=? WHERE id=?').run(
      'simulated model failure',
      m.id,
    );
    const after = getMemory(db, key, m.id);
    assert.equal(after.embedding_status, 'failed');
    assert.equal(after.last_embed_error, 'simulated model failure');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('recordProjectPath preserves last_canonical_root on move and bumps record_count', () => {
  const { home, key, dbPath } = freshProject();
  try {
    const db = openDb(dbPath);
    recordProjectPath(db, key, 'C:/old/location');
    const first = listProjectPaths(db).find((r) => r.project_key === key);
    assert.equal(first.canonical_root, 'C:/old/location');
    assert.equal(first.last_canonical_root, null);
    assert.equal(first.record_count, 1);
    // Re-record the same root: no move, counter bumps, last_canonical_root stays null.
    recordProjectPath(db, key, 'C:/old/location');
    const second = listProjectPaths(db).find((r) => r.project_key === key);
    assert.equal(second.canonical_root, 'C:/old/location');
    assert.equal(second.last_canonical_root, null);
    assert.equal(second.record_count, 2);
    // Re-record with a different root: last_canonical_root captures the move.
    recordProjectPath(db, key, 'C:/new/location');
    const third = listProjectPaths(db).find((r) => r.project_key === key);
    assert.equal(third.canonical_root, 'C:/new/location');
    assert.equal(third.last_canonical_root, 'C:/old/location');
    assert.equal(third.record_count, 3);
    closeDb(dbPath);
  } finally {
    rmRf(home);
  }
});

test('advisor detector: positive match on a real reflection request', () => {
  assert.equal(matchAdvisor('what would you change in this approach?'), 'what would you change');
  assert.equal(matchAdvisor('How can we improve this?'), 'how can we improve');
  assert.equal(matchAdvisor('Is there a better way?'), 'is there a better way');
  assert.equal(matchAdvisor('Let me ask: do differently next time?'), 'do differently');
});

test('advisor detector: no match when no keyword is present', () => {
  // These all return null because the keyword substring never
  // appears — they don't actually exercise the negation gate, but
  // they document that the detector does not over-fire on negation
  // shapes by accident.
  assert.equal(matchAdvisor("I wouldn't change anything here"), null);
  assert.equal(matchAdvisor("we don't do it differently"), null);
  assert.equal(matchAdvisor("there's no better way to do this"), null);
  assert.equal(
    matchAdvisor("I don't think this matters, but how can we improve it?"),
    null,
    'the negation gate is intentionally conservative: any negation ' +
      'in the same sentence as the keyword suppresses the match',
  );
});

test('advisor detector: negation gate fires when keyword + negation share a sentence', () => {
  // This is the real negation-gate test: a prompt where the keyword
  // actually matches AND a negation marker is in the same sentence.
  // The keyword "what would you change" is in the second clause, but
  // the first clause "I wouldn't change anything" carries a
  // negation. The two are in the same sentence (no terminator
  // between them), so the gate suppresses the match.
  const prompt = "I wouldn't change anything, what would you change about it?";
  assert.equal(matchAdvisor(prompt), null, 'negation gate suppresses same-sentence keyword');
  assert.ok(
    _negatedMatches(prompt).includes('what would you change'),
    'suppressed keyword is reported by _negatedMatches',
  );
});

test('advisor detector: negation gate does NOT fire when the negation is in a different sentence', () => {
  // Two sentences joined by a period. The first carries a
  // negation; the second is a positive reflection request. The
  // gate scopes the negation to the sentence around the keyword,
  // so the second sentence's positive "is there a better way"
  // still matches.
  const prompt = "I wouldn't change anything about the design. Is there a better way to do it?";
  assert.equal(
    matchAdvisor(prompt),
    'is there a better way',
    'the second sentence is matched despite a negation in the first',
  );
});

test('advisor detector: _negatedMatches lists the suppressed keywords', () => {
  // The "anything you'd change" substring is in the prompt and the
  // surrounding sentence ("we wouldn't change anything you'd change
  // here") contains a negation, so the keyword is suppressed and
  // appears in _negatedMatches.
  const neg = _negatedMatches("we wouldn't change anything you'd change here");
  assert.ok(
    neg.includes("anything you'd change"),
    "the 'anything you'd change' keyword is in the negated set",
  );
});

test('looksLikeSecret: detects common secret shapes', () => {
  assert.equal(looksLikeSecret('api_key: sk-abcdefghijklmnopqrstuvwxyz1234567890'), true);
  assert.equal(looksLikeSecret('Authorization: Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxx'), true);
  assert.equal(looksLikeSecret('-----BEGIN PRIVATE KEY-----'), true);
  assert.equal(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
  assert.equal(looksLikeSecret('aws_access_key = AKIAIOSFODNN7EXAMPLE'), true);
  assert.equal(looksLikeSecret('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), true);
  // Normal content does NOT match.
  assert.equal(looksLikeSecret('use tabs for indentation'), false);
  assert.equal(looksLikeSecret('release via git tag && git push --tags'), false);
  assert.equal(looksLikeSecret(''), false);
  assert.equal(looksLikeSecret(null), false);
});

test('runAutoExtract: secret-bearing candidates are dropped and counted', async () => {
  const home = mkTempHome();
  try {
    writeRaw(
      `${home}/config.toml`,
      `
      default_model = "x/m"
      [providers.x]
      type = "openai"
      api_key = "k"
      base_url = "https://example/v1"
      [models."x/m"]
      provider = "x"
      model = "m"
    `,
    );
    const key = deriveProjectKey('C:/test/extract-secret');
    const db = openDb(projectDbPath(home, key));
    try {
      const fakeReply = JSON.stringify([
        {
          type: 'semantic',
          title: 'user API key',
          content: 'the api key is sk-abcdefghijklmnopqrstuvwxyz1234567890',
          tags: [],
        },
        {
          type: 'semantic',
          title: 'release flow',
          content: 'tag + push to release',
          tags: [],
        },
      ]);
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db,
        transcript: 'USER: my key is sk-test\nASSISTANT: noted.',
        saveMemory,
        searchMemories,
        callLlm: async () => fakeReply,
      });
      assert.equal(r.extracted, 2);
      assert.equal(r.secrets_dropped, 1, 'one candidate is dropped as a secret');
      assert.equal(r.saved, 1, 'only the clean candidate is saved');
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: secrets_dropped defaults to 0 on the result object', async () => {
  const home = mkTempHome();
  try {
    const key = deriveProjectKey('C:/test/extract-shape');
    const db = openDb(projectDbPath(home, key));
    try {
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db,
        transcript: '   ',
        saveMemory,
        searchMemories,
        callLlm: async () => '[]',
      });
      assert.equal(r.skipped, 'no_transcript');
      assert.equal(r.secrets_dropped, 0);
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('MCP round-trip: memory_save_bulk collects every invalid item, not just the first', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const cwd = 'C:/test/bulk-errors';
    const r = await mcp.toolCall('memory_save_bulk', {
      cwd,
      items: [
        { type: 'banana', content: 'bad type' },
        { type: 'semantic', content: 'ok 1' },
        { type: 'semantic', content: '' },
        { type: 'semantic', title: 'x'.repeat(600), content: 'too long title' },
        { type: 'semantic', content: 'ok 2' },
      ],
    });
    assert.equal(r.isError, true, 'mixed batch returns isError');
    const txt = r.content[0].text;
    // The zod schema is the first line of defence and it returns every
    // problem in a single error — items[0].type, items[2].content,
    // and items[3].title all show up together. This is the
    // "collect all errors" behavior the docstring promises.
    assert.match(txt, /items\[0\]\.type/, 'first bad item is reported (zod)');
    assert.match(txt, /items\[2\]\.content/, 'third bad item is reported (zod)');
    assert.match(txt, /items\[3\]\.title/, 'fourth bad item is reported (zod)');
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP round-trip: memory_save_bulk accepts type=conclusion and synthesizes[]', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const cwd = 'C:/test/bulk-conclusion';
    // Seed two memories first so we have ids to synthesise.
    const a = JSON.parse(
      (
        await mcp.toolCall('memory_save', {
          cwd,
          type: 'semantic',
          title: 'a',
          content: 'a',
        })
      ).content[0].text,
    );
    const b = JSON.parse(
      (
        await mcp.toolCall('memory_save', {
          cwd,
          type: 'semantic',
          title: 'b',
          content: 'b',
        })
      ).content[0].text,
    );
    const r = await mcp.toolCall('memory_save_bulk', {
      cwd,
      items: [
        {
          type: 'conclusion',
          title: 'summary',
          content: 'a + b',
          synthesizes: [a.memory.id, b.memory.id],
        },
        { type: 'semantic', title: 'next', content: 'next memory' },
      ],
    });
    assert.equal(r.isError, undefined, 'conclusion + synthesizes accepted');
    const j = JSON.parse(r.content[0].text);
    assert.equal(j.count, 2);
    // The conclusion is queryable via memory_parents.
    const parents = JSON.parse(
      (await mcp.toolCall('memory_parents', { cwd, id: j.memories[0].id })).content[0].text,
    );
    assert.equal(parents.count, 2);
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP round-trip: recall surfaces type breakdown + per-memory [recall: i/N] lines', async () => {
  const home = mkTempHome();
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const cwd = 'C:/test/recall-visibility';
    // Seed one of each type with a shared keyword. Each body is a
    // multi-line fact whose first line is the snippet we expect to
    // see surface in the bounded [recall: i/N] output.
    for (const t of ['semantic', 'procedural', 'working']) {
      await mcp.toolCall('memory_save', {
        cwd,
        type: t,
        title: `${t} use tabs`,
        content: `${t} indent with tabs not spaces for release\n  second line ignored`,
        tags: [],
      });
    }
    // Drive the UserPromptSubmit hook directly.
    const { spawnSync } = await import('node:child_process');
    const wrapper = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '..',
      'hooks',
      'user-prompt-submit.js',
    );
    const r = spawnSync(process.execPath, [wrapper], {
      cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) + '/..',
      env: { ...process.env, KIMI_CODE_HOME: home, KM_HOOK_EVENT: 'UserPromptSubmit' },
      input: JSON.stringify({
        cwd,
        session_id: 's-visibility',
        prompt: 'tabs release',
      }),
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(r.status, 0);
    // The recall summary should include a type breakdown and at least
    // one [recall: i/N] line. The exact type ordering is by count
    // desc then alphabetical, so we just assert the per-type section
    // and the per-memory line.
    assert.match(
      r.stdout,
      /\[\s*semantic:\s*\d+(?:\s*,\s*[a-z]+:\s*\d+)*\s*\]/,
      'type breakdown is present',
    );
    assert.match(r.stdout, /\[recall: 1\/\d+\]/, 'first recalled memory is shown');
    // Each [recall: i/N] line should carry a content snippet (the first
    // non-empty line of the body) so the user can verify what was
    // recalled without trusting the title alone. We assert on one
    // specific substring — "indent with tabs not spaces" — which comes
    // from the first line of every seeded body.
    assert.match(
      r.stdout,
      /\[recall: \d+\/\d+\] "[^"]+" \([^)]+\) — .*indent with tabs not spaces/,
      'recall lines carry a content snippet from the body',
    );
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('CLI: list emits a parseable project memory record', async () => {
  const { execFileSync } = await import('node:child_process');
  const home = mkTempHome();
  try {
    const cwd = canonicalizeRoot('C:/test/cli-list');
    const key = deriveProjectKey(cwd);
    const db = openDb(projectDbPath(home, key));
    saveMemory(db, key, {
      type: 'semantic',
      title: 'tabs',
      content: 'we use tabs for indent',
    });
    closeDb();
    const out = execFileSync(
      process.execPath,
      [
        path.join(
          path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
          '..',
          'src',
          'cli.js',
        ),
        'list',
        '--cwd',
        cwd,
        '--json',
        '--home',
        home,
      ],
      { encoding: 'utf8' },
    );
    const j = JSON.parse(out);
    assert.equal(j.operation, 'list');
    assert.ok(j.count >= 1);
    const m = j.items.find((it) => it.title === 'tabs');
    assert.ok(m, 'saved memory is listed');
    assert.equal(m.scope, 'project');
  } finally {
    rmRf(home);
  }
});

test('CLI: status reports project + global keys', async () => {
  const { execFileSync } = await import('node:child_process');
  const home = mkTempHome();
  try {
    const cli = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '..',
      'src',
      'cli.js',
    );
    const out = execFileSync(
      process.execPath,
      [cli, 'status', '--cwd', 'C:/test/cli-status', '--json', '--home', home],
      { encoding: 'utf8' },
    );
    const j = JSON.parse(out);
    assert.equal(j.operation, 'status');
    assert.ok(j.project && j.project.project_key);
    assert.equal(j.project.project_key, deriveProjectKey(canonicalizeRoot('C:/test/cli-status')));
  } finally {
    rmRf(home);
  }
});

test('CLI: prune dry-run reports orphans without deleting them', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mkTempHome();
  const cli = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '..',
    'src',
    'cli.js',
  );
  // Make a real project dir, write a memory through MCP so the
  // canonical_root is stamped, then remove the dir on disk. The
  // CLI prune must see the orphan via the recorded canonical_root
  // and report it as would-remove without touching the file.
  const orphanCwd = mkdtempSync(path.join(tmpdir(), 'km-cli-orphan-'));
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await mcp.toolCall('memory_save', {
      cwd: orphanCwd,
      type: 'semantic',
      title: 'orphan',
      content: 'goes away',
    });
    mcp.stop();
    // Now the project DB has project_paths.canonical_root set; remove
    // the cwd and ask the CLI to prune.
    rmSync(orphanCwd, { recursive: true, force: true });
    const out = execFileSync(
      process.execPath,
      [cli, 'prune', '--cwd', process.cwd(), '--all-projects', '--json', '--home', home],
      { encoding: 'utf8' },
    );
    const j = JSON.parse(out);
    assert.equal(j.operation, 'prune');
    assert.equal(j.apply, false);
    const orphan = j.candidates.find((c) => c.project_key === deriveProjectKey(orphanCwd));
    assert.ok(orphan, 'orphan project is reported');
    assert.equal(orphan.action, 'would-remove');
    assert.equal(orphan.exists_on_disk, false);
    // The DB file must still be on disk — dry run is non-destructive.
    assert.ok(
      existsSync(projectDbPath(home, deriveProjectKey(orphanCwd))),
      'dry run did not delete the file',
    );
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

test('MCP round-trip: read tools do NOT stamp project_paths (write-only gating)', async () => {
  const home = mkTempHome();
  const cwd = 'C:/test/recall-no-stamp';
  const mcp = new StdioMcp({ home });
  mcp.start();
  try {
    await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    // A read on a brand-new project must NOT create a project_paths
    // row — gating recordProjectPath to write paths means reads
    // never pay the write cost.
    await mcp.toolCall('memory_recall', { cwd, query: 'anything' });
    const key = deriveProjectKey(canonicalizeRoot(cwd));
    const db = openDb(projectDbPath(home, key));
    const rows = db.prepare('SELECT * FROM project_paths WHERE project_key=?').all(key);
    assert.equal(rows.length, 0, 'read tools do not stamp project_paths');
    // A write DOES stamp.
    await mcp.toolCall('memory_save', {
      cwd,
      type: 'semantic',
      title: 'first',
      content: 'first memory',
    });
    const afterRows = db.prepare('SELECT * FROM project_paths WHERE project_key=?').all(key);
    assert.equal(afterRows.length, 1, 'write tools stamp exactly once');
    assert.equal(afterRows[0].canonical_root, canonicalizeRoot(cwd));
    closeDb();
  } finally {
    mcp.stop();
    rmRf(home);
  }
});

void canonicalizeRoot;
void _resetForTests;
