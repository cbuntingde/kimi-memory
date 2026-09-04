// Tests for the auto-extraction module. The LLM call is mocked at the
// `callLlm` injection seam in `runAutoExtract` so the suite is offline
// and deterministic. Real config.toml parsing + a temporary file are
// used to verify the loader works against the actual config format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { mkTempHome, rmRf, writeRaw } from './_helpers.js';
import {
  parseExtractionResponse,
  readConfig,
  resolveLlmTarget,
  runAutoExtract,
  dedupeCandidates,
  detectProjectMetadata,
  buildExtractionPrompt,
} from '../src/extract.js';
import { openDb, closeDb, saveMemory, listMemories, searchMemories } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { validateAutoExtractConfig } from '../src/validation.js';

test('parseExtractionResponse: bare JSON array of candidates', () => {
  const text = `[{"type":"semantic","title":"prefers tabs","content":"the user prefers tabs","tags":["style","indent"]}]`;
  const out = parseExtractionResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'semantic');
  assert.equal(out[0].title, 'prefers tabs');
  assert.deepEqual(out[0].tags, ['style', 'indent']);
});

test('parseExtractionResponse: strips markdown fences', () => {
  const text = '```json\n[{"type":"semantic","title":"t","content":"c","tags":[]}]\n```';
  const out = parseExtractionResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 't');
});

test('parseExtractionResponse: accepts {candidates: [...]} wrapper', () => {
  const text = `{"candidates":[{"type":"episodic","title":"e","content":"did thing","tags":["event"]}]}`;
  const out = parseExtractionResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'episodic');
});

test('parseExtractionResponse: rejects unsupported types and empty content', () => {
  const text = `[
    {"type":"working","title":"bad-type","content":"x","tags":[]},
    {"type":"semantic","title":"empty","content":"","tags":[]},
    {"type":"semantic","title":"ok","content":"valid","tags":[]}
  ]`;
  const out = parseExtractionResponse(text);
  assert.equal(out[0].title, 'ok');
});

test('parseExtractionResponse: accepts context_snapshot for narration / state / plans', () => {
  const text = `[
    {"type":"context_snapshot","title":"Looking at repo state + prior sea work","content":"Let me look at the current state of the repo to understand context, and check for prior sea work.","tags":["snapshot","investigation"]},
    {"type":"context_snapshot","title":"focus: ship code-discipline v2","content":"In-flight: implementing audit-lint-disable-justification; goal is ship code-discipline v2.","tags":["snapshot","focus"]}
  ]`;
  const out = parseExtractionResponse(text);
  assert.equal(out.length, 2);
  for (const m of out) {
    assert.equal(m.type, 'context_snapshot');
    assert.ok(m.tags.includes('snapshot'), 'tagged snapshot');
  }
});

test('parseExtractionResponse: rejects unknown types (still strict)', () => {
  const text = `[
    {"type":"banana","title":"x","content":"y","tags":[]},
    {"type":"context_snapshot","title":"ok","content":"valid","tags":["snapshot"]}
  ]`;
  const out = parseExtractionResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'context_snapshot');
});

test('parseExtractionResponse: scope="global" candidate is preserved with global flag', () => {
  const text = `[{"type":"semantic","scope":"global","title":"user prefers dark mode","content":"the user always works in dark mode","tags":["user-preference","theme"]}]`;
  const out = parseExtractionResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].scope, 'global');
  assert.equal(out[0].type, 'semantic');
});

test('parseExtractionResponse: scope omitted defaults to project', () => {
  const text = `[{"type":"semantic","title":"project convention","content":"uses tabs","tags":["style"]}]`;
  const out = parseExtractionResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].scope, 'project');
});

test('parseExtractionResponse: unknown scope value falls back to project (no batch rejection)', () => {
  // The model occasionally invents scope values like "shared" or
  // "cross". Treat any non-{project,global} value as project so a
  // single bad scope doesn't drop an otherwise-valid candidate.
  const text = `[
    {"type":"semantic","scope":"shared","title":"a","content":"valid","tags":[]},
    {"type":"semantic","scope":"global","title":"b","content":"valid","tags":[]}
  ]`;
  const out = parseExtractionResponse(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].scope, 'project', 'unknown scope falls back to project');
  assert.equal(out[1].scope, 'global');
});

test('parseExtractionResponse: caps at MAX_CANDIDATES_PER_CALL (6)', () => {
  const arr = [];
  for (let i = 0; i < 10; i++)
    arr.push({ type: 'semantic', title: 't' + i, content: 'c' + i, tags: [] });
  const out = parseExtractionResponse(JSON.stringify(arr));
  assert.equal(out.length, 6);
});

test('parseExtractionResponse: returns [] for invalid JSON or non-string', () => {
  assert.deepEqual(parseExtractionResponse(''), []);
  assert.deepEqual(parseExtractionResponse(null), []);
  assert.deepEqual(parseExtractionResponse('not json'), []);
  assert.deepEqual(parseExtractionResponse('{"a":1}'), []);
});

test('readConfig: parses a minimal kimi-code config.toml', async () => {
  const home = mkTempHome();
  try {
    writeRaw(
      `${home}/config.toml`,
      `
      default_model = "minimax/MiniMax-M3"

      [providers.minimax]
      type = "anthropic"
      api_key = "sk-test"
      base_url = "https://api.example/v1"

      [models."minimax/MiniMax-M3"]
      provider = "minimax"
      model = "MiniMax-M3"

      [kimi-memory]
      disable_auto_extract = false
    `,
    );
    // Reset the module's cache so the new file is read.
    const cfg = await readConfig(home);
    assert.equal(cfg.default_model, 'minimax/MiniMax-M3');
    assert.equal(cfg.providers.minimax.type, 'anthropic');
    assert.equal(cfg.providers.minimax.api_key, 'sk-test');
    assert.equal(cfg['kimi-memory'].disable_auto_extract, false);
  } finally {
    rmRf(home);
  }
});

test('readConfig: returns {} when the file is missing', async () => {
  const home = mkTempHome();
  try {
    const cfg = await readConfig(home);
    assert.deepEqual(cfg, {});
  } finally {
    rmRf(home);
  }
});

test('resolveLlmTarget: returns error when default_model is missing', async () => {
  const home = mkTempHome();
  try {
    writeRaw(`${home}/config.toml`, `[providers.x]\ntype="openai"\napi_key="k"\nbase_url="u"\n`);
    const t = await resolveLlmTarget(home);
    assert.ok(t.error, 'error string returned');
    assert.match(t.error, /no_default_model/);
  } finally {
    rmRf(home);
  }
});

test('resolveLlmTarget: returns error when the model block is missing', async () => {
  const home = mkTempHome();
  try {
    writeRaw(
      `${home}/config.toml`,
      `
      default_model = "minimax/missing"
      [providers.minimax]
      type="openai"
      api_key="k"
      base_url="u"
    `,
    );
    const t = await resolveLlmTarget(home);
    assert.ok(t.error);
    assert.match(t.error, /model_not_found/);
  } finally {
    rmRf(home);
  }
});

test('resolveLlmTarget: returns full target on success', async () => {
  const home = mkTempHome();
  try {
    writeRaw(
      `${home}/config.toml`,
      `
      default_model = "minimax/M3"
      [providers.minimax]
      type="openai"
      api_key="sk-1"
      base_url="https://x.example/v1"
      [models."minimax/M3"]
      provider = "minimax"
      model = "m3"
    `,
    );
    const t = await resolveLlmTarget(home);
    assert.equal(t.provider, 'minimax');
    assert.equal(t.model, 'm3');
    assert.equal(t.type, 'openai');
    assert.equal(t.apiKey, 'sk-1');
    assert.equal(t.baseUrl, 'https://x.example/v1');
  } finally {
    rmRf(home);
  }
});

test('dedupeCandidates: keeps candidates with no hits; drops ones with a strong hit', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/extract-A');
  const db = openDb(projectDbPath(home, key));
  try {
    saveMemory(db, key, {
      type: 'semantic',
      title: 'prefers tabs',
      content: 'indentation is tabs',
      tags: ['style'],
    });
    const candidates = [
      {
        type: 'semantic',
        title: 'prefers tabs for indent',
        content: 'indentation is tabs, single quotes',
        tags: ['style'],
      },
      {
        type: 'semantic',
        title: 'loves pineapple',
        content: 'the user has a pineapple plant on the balcony',
        tags: ['food'],
      },
    ];
    const out = await dedupeCandidates({
      db,
      projectKey: key,
      candidates,
      // Pass the real searchMemories; it returns rows with `similarity`
      // for vector hits, or just the FTS hit otherwise.
      searchMemories,
    });
    assert.equal(out.duplicates.length, 1, 'the tabs candidate is a duplicate');
    assert.equal(out.kept.length, 1, 'pineapple is new');
    assert.equal(out.kept[0].title, 'loves pineapple');
  } finally {
    closeDb();
    rmRf(home);
  }
});

test('runAutoExtract: env opt-out short-circuits before any network call', async () => {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/extract-env');
  const db = openDb(projectDbPath(home, key));
  const prev = process.env.KIMI_MEMORY_AUTO_EXTRACT;
  process.env.KIMI_MEMORY_AUTO_EXTRACT = 'off';
  try {
    let called = false;
    const r = await runAutoExtract({
      homeDir: home,
      cwd: 'C:/test',
      projectKey: key,
      db,
      transcript: 'USER: hello\nASSISTANT: hi',
      saveMemory,
      searchMemories,
      callLlm: async () => {
        called = true;
        return '[]';
      },
    });
    assert.equal(r.skipped, 'env_opt_out');
    assert.equal(called, false, 'callLlm was never invoked');
  } finally {
    if (prev == null) delete process.env.KIMI_MEMORY_AUTO_EXTRACT;
    else process.env.KIMI_MEMORY_AUTO_EXTRACT = prev;
    closeDb();
    rmRf(home);
  }
});

test('runAutoExtract: config opt-out short-circuits', async () => {
  const home = mkTempHome();
  try {
    writeRaw(
      `${home}/config.toml`,
      `
      default_model = "x/m"
      [providers.x]
      type="openai"
      api_key="k"
      base_url="u"
      [models."x/m"]
      provider = "x"
      model = "m"
      [kimi-memory]
      disable_auto_extract = true
    `,
    );
    const key = deriveProjectKey('C:/test/extract-cfg');
    const db = openDb(projectDbPath(home, key));
    try {
      let called = false;
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db,
        transcript: 'USER: x\nASSISTANT: y',
        saveMemory,
        searchMemories,
        callLlm: async () => {
          called = true;
          return '[]';
        },
      });
      assert.equal(r.skipped, 'config_opt_out');
      assert.equal(called, false);
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: happy path — mock LLM returns candidates, dedup keeps the new ones', async () => {
  const home = mkTempHome();
  try {
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
    const key = deriveProjectKey('C:/test/extract-happy');
    const db = openDb(projectDbPath(home, key));
    try {
      const fakeReply = JSON.stringify([
        {
          type: 'semantic',
          title: 'uses tabs',
          content: 'prefers tabs for indentation',
          tags: ['style'],
        },
        {
          type: 'procedural',
          title: 'release flow',
          content: 'tag + push to release',
          tags: ['ci'],
        },
      ]);
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db,
        transcript: 'USER: I use tabs\nASSISTANT: noted.',
        saveMemory,
        searchMemories,
        callLlm: async () => fakeReply,
      });
      assert.equal(r.skipped, null);
      assert.equal(r.extracted, 2);
      assert.equal(r.saved, 2);
      assert.equal(r.duplicates, 0);
      // The memories are queryable and carry auto_extract provenance.
      const all = listMemories(db, key, {});
      assert.equal(all.length, 2);
      const prov = all.map((m) => m.provenance && m.provenance.source);
      assert.ok(prov.every((p) => p === 'auto_extract'));
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: context_snapshot rows rank below durable facts (confidence + priority)', async () => {
  const home = mkTempHome();
  try {
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
    const key = deriveProjectKey('C:/test/extract-snapshot');
    const db = openDb(projectDbPath(home, key));
    try {
      const fakeReply = JSON.stringify([
        {
          type: 'semantic',
          title: 'commit policy',
          content: 'squash + keep remote branch',
          tags: ['git'],
        },
        {
          type: 'context_snapshot',
          title: 'Looking at repo state + prior sea work',
          content:
            'Let me look at the current state of the repo to understand context, and check for prior sea work.',
          tags: ['snapshot', 'investigation'],
        },
      ]);
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db,
        transcript:
          'USER: do we squash?\nASSISTANT: yes, squash + keep remote branch.\nUSER: Let me look at the current state of the repo to understand context, and check for prior sea work.',
        saveMemory,
        searchMemories,
        callLlm: async () => fakeReply,
      });
      assert.equal(r.saved, 2);
      const all = listMemories(db, key, {});
      assert.equal(all.length, 2);
      const snap = all.find((m) => m.type === 'context_snapshot');
      const sem = all.find((m) => m.type === 'semantic');
      assert.ok(snap, 'snapshot row present');
      assert.ok(sem, 'semantic row present');
      // Snapshots rank strictly below durable facts on both axes
      assert.ok(
        snap.confidence < sem.confidence,
        `snapshot.confidence (${snap.confidence}) must be below semantic.confidence (${sem.confidence})`,
      );
      assert.ok(
        snap.priority < sem.priority,
        `snapshot.priority (${snap.priority}) must be below semantic.priority (${sem.priority})`,
      );
      assert.ok(snap.tags.includes('snapshot'), 'snapshot row carries the snapshot tag');
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: dedup drops a candidate that closely matches an existing memory', async () => {
  const home = mkTempHome();
  try {
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
    const key = deriveProjectKey('C:/test/extract-dup');
    const db = openDb(projectDbPath(home, key));
    try {
      // Seed the existing memory the model will be tempted to repeat.
      saveMemory(db, key, {
        type: 'semantic',
        title: 'uses tabs for indent',
        content: 'indentation is tabs',
        tags: ['style'],
      });
      // Hand-roll a similarity number on the existing row so dedupe has a clear signal.
      const fakeReply = JSON.stringify([
        {
          type: 'semantic',
          title: 'prefers tabs',
          content: 'indentation is tabs',
          tags: ['style'],
        },
        {
          type: 'semantic',
          title: 'wears red shoes',
          content: 'the agent should remember red shoes',
          tags: ['misc'],
        },
      ]);
      // Patch the existing memory's embedding-less similarity by re-using the real
      // searchMemories (which returns hits without `similarity` in tests because
      // the model is off). Our dedupe treats any top hit as a duplicate.
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db,
        transcript: 'USER: tabs please\nASSISTANT: noted.',
        saveMemory,
        searchMemories,
        callLlm: async () => fakeReply,
      });
      assert.equal(r.extracted, 2);
      // First candidate duplicates the existing tabs memory → dropped.
      assert.equal(r.duplicates, 1);
      assert.equal(r.saved, 1);
      const all = listMemories(db, key, {});
      assert.equal(all.length, 2, 'existing + one new candidate');
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: missing provider config → skipped with a reason', async () => {
  const home = mkTempHome();
  try {
    // No config.toml at all.
    const key = deriveProjectKey('C:/test/extract-noconfig');
    const db = openDb(projectDbPath(home, key));
    try {
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db,
        transcript: 'something',
        saveMemory,
        searchMemories,
        callLlm: async () => '[]',
      });
      assert.ok(r.skipped);
      assert.match(r.skipped, /no_default_model|no_config/);
      assert.equal(r.saved, 0);
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: empty transcript → no-op', async () => {
  const home = mkTempHome();
  try {
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
    const key = deriveProjectKey('C:/test/extract-empty');
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
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('validateAutoExtractConfig: rejects non-boolean disable_auto_extract', () => {
  const ok1 = validateAutoExtractConfig({});
  assert.equal(ok1.ok, true);
  const ok2 = validateAutoExtractConfig({ 'kimi-memory': { disable_auto_extract: true } });
  assert.equal(ok2.ok, true);
  assert.equal(ok2.value.disable_auto_extract, true);
  const bad = validateAutoExtractConfig({ 'kimi-memory': { disable_auto_extract: 'yes' } });
  assert.equal(bad.ok, false);
});

test('detectProjectMetadata: reads package.json and tsconfig.json', async () => {
  const home = mkTempHome();
  const projectDir = path.join(home, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await writeRaw(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      scripts: { build: 'tsc', test: 'jest' },
      dependencies: { react: '^18.0.0', zod: '~3.0.0' },
      devDependencies: { typescript: '^5.0.0' },
      packageManager: 'pnpm@9.0.0',
    }),
  );
  await writeRaw(
    path.join(projectDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
    }),
  );
  try {
    const meta = await detectProjectMetadata(projectDir);
    assert.ok(meta);
    assert.equal(meta.buildCommand, 'tsc');
    assert.equal(meta.testCommand, 'jest');
    assert.ok(meta.stack.includes('pnpm@9.0.0'));
    assert.ok(meta.stack.some((s) => s.startsWith('tsconfig(')));
    assert.ok(meta.deps.includes('react'));
    assert.ok(meta.pinnedDeps.includes('zod'));
    assert.ok(meta.updatePolicy);
  } finally {
    rmRf(home);
  }
});

test('detectProjectMetadata: returns null when no manifests found', async () => {
  const home = mkTempHome();
  try {
    const meta = await detectProjectMetadata(path.join(home, 'empty'));
    assert.equal(meta, null);
  } finally {
    rmRf(home);
  }
});

test('detectProjectMetadata: bare-Node project (node --test) is detected without devDeps', async () => {
  // The motivating case: a Node-only repo with no packageManager field,
  // no typescript dep, and `scripts.test: "node --test --test-reporter=spec
  // tests/*.test.js"`. Pre-fix this landed as `Stack: unknown` —
  // useless for the agent. Post-fix the regex scan surfaces
  // `node (test runner)`.
  const home = mkTempHome();
  const projectDir = path.join(home, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await writeRaw(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'bare-node',
      scripts: {
        test: 'node --test --test-reporter=spec tests/*.test.js',
        start: 'node index.js',
      },
    }),
  );
  try {
    const meta = await detectProjectMetadata(projectDir);
    assert.ok(meta);
    assert.ok(
      meta.stack.includes('node (test runner)'),
      `expected 'node (test runner)' in stack, got: ${meta.stack.join(', ')}`,
    );
    assert.equal(meta.testCommand, 'node --test --test-reporter=spec tests/*.test.js');
  } finally {
    rmRf(home);
  }
});

test('detectProjectMetadata: tsc in scripts.build fires the typescript (compiler) tag without a typescript dep', async () => {
  // The devDependencies check (typescript dep present) is a separate
  // signal; the regex scan fires even when the dep is missing or only
  // a peer of a build script.
  const home = mkTempHome();
  const projectDir = path.join(home, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await writeRaw(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'tsc-only',
      scripts: { build: 'tsc -p tsconfig.json', test: 'node --test' },
      // No `typescript` in devDependencies.
    }),
  );
  try {
    const meta = await detectProjectMetadata(projectDir);
    assert.ok(meta);
    assert.ok(meta.stack.includes('typescript (compiler)'));
    assert.ok(meta.stack.includes('node (test runner)'));
  } finally {
    rmRf(home);
  }
});

test('detectProjectMetadata: script-invoked tooling (npx jest) fires the regex tag', async () => {
  // The detector should not require the tool to appear as a top-level
  // invocation. `npx jest` and `pnpm vitest run` are common shapes that
  // still need to land in the stack memory.
  const home = mkTempHome();
  const projectDir = path.join(home, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await writeRaw(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'npx-tooling',
      scripts: { test: 'npx jest --runInBand', lint: 'pnpm dlx eslint .' },
    }),
  );
  try {
    const meta = await detectProjectMetadata(projectDir);
    assert.ok(meta);
    assert.ok(meta.stack.includes('jest'), `expected jest in stack, got: ${meta.stack.join(', ')}`);
    assert.ok(
      meta.stack.includes('eslint'),
      `expected eslint in stack, got: ${meta.stack.join(', ')}`,
    );
  } finally {
    rmRf(home);
  }
});

test('detectProjectMetadata: each tag emitted at most once even when multiple scripts mention the same tool', async () => {
  // `lint`, `lint:fix`, and `pretest` may all reference the same tool.
  // Dedupe so the surfaced memory row doesn't carry `eslint eslint eslint`.
  const home = mkTempHome();
  const projectDir = path.join(home, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await writeRaw(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'dup-tool',
      scripts: {
        lint: 'eslint .',
        'lint:fix': 'eslint . --fix',
        pretest: 'eslint .',
      },
    }),
  );
  try {
    const meta = await detectProjectMetadata(projectDir);
    assert.ok(meta);
    const eslintHits = meta.stack.filter((s) => s === 'eslint').length;
    assert.equal(eslintHits, 1, `eslint should appear once, got ${eslintHits}`);
  } finally {
    rmRf(home);
  }
});

test('detectProjectMetadata: typescript dep + tsc script produce two distinct tags (typescript + typescript (compiler))', async () => {
  // Both signals are useful: `typescript` says the package is declared
  // as a dep; `typescript (compiler)` says it is actively invoked from
  // a script. They are not the same fact.
  const home = mkTempHome();
  const projectDir = path.join(home, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await writeRaw(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'ts-with-dep',
      scripts: { build: 'tsc -b', test: 'node --test' },
      devDependencies: { typescript: '^5.0.0' },
    }),
  );
  try {
    const meta = await detectProjectMetadata(projectDir);
    assert.ok(meta);
    assert.ok(meta.stack.includes('typescript'), 'dep-based typescript tag');
    assert.ok(
      meta.stack.includes('typescript (compiler)'),
      'regex-based typescript (compiler) tag',
    );
  } finally {
    rmRf(home);
  }
});

test('buildExtractionPrompt: includes projectMeta JSON', () => {
  const prompt = buildExtractionPrompt('hello', [], {
    stack: ['node'],
    buildCommand: 'npm run build',
  });
  assert.ok(prompt.user.includes('Project metadata (from manifest files)'));
  assert.ok(prompt.user.includes('"buildCommand": "npm run build"'));
});

test('runAutoExtract: saves deterministic build/stack memories from manifests', async () => {
  const home = mkTempHome();
  const projectDir = path.join(home, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await writeRaw(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'demo',
      scripts: { build: 'tsc', test: 'jest' },
      dependencies: { react: '^18.0.0' },
    }),
  );
  // Create a config.toml in the home directory.
  await writeRaw(
    path.join(home, 'config.toml'),
    `
    default_model = "test/model"
    [providers.test]
    type = "openai"
    api_key = "test-key"
    base_url = "https://test"
    [models."test/model"]
    provider = "test"
    model = "test-model"
  `,
  );
  try {
    const key = deriveProjectKey(projectDir);
    const db = openDb(projectDbPath(home, key));
    try {
      const r = await runAutoExtract({
        homeDir: home,
        cwd: projectDir,
        projectKey: key,
        db,
        transcript: 'USER: hi\nASSISTANT: hello',
        saveMemory,
        searchMemories,
        callLlm: async () => '[]',
      });
      assert.equal(r.skipped, null, `skipped should be null but got ${r.skipped}`);
      assert.equal(r.extracted, 0);
      assert.equal(r.saved, 2, `saved should be 2 but got ${r.saved}, error: ${r.error}`);
      assert.equal(r.duplicates, 0);
      const all = listMemories(db, key, {});
      const titles = all.map((m) => m.title).sort();
      assert.deepEqual(titles, ['Dependency update policy', 'Project build/stack details']);
      const buildMem = all.find((m) => m.title === 'Project build/stack details');
      assert.ok(buildMem.content.includes('Stack:'));
      assert.ok(buildMem.content.includes('Build: tsc'));
      const policyMem = all.find((m) => m.title === 'Dependency update policy');
      assert.ok(policyMem.content.includes('Check for latest unless pinned'));
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: global candidate routes to the _global DB, project candidate stays in the project DB', async () => {
  // Wire a config so runAutoExtract passes the provider-config gate.
  const home = mkTempHome();
  try {
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
    const key = deriveProjectKey('C:/test/extract-global');
    const projectDb = openDb(projectDbPath(home, key));
    const globalDbPathLocal = path.join(home, 'kimi-memory', '_global', 'memory.sqlite');
    await fs.mkdir(path.dirname(globalDbPathLocal), { recursive: true });
    const globalDb = openDb(globalDbPathLocal);
    try {
      const fakeReply = JSON.stringify([
        {
          type: 'semantic',
          scope: 'global',
          title: 'user prefers dark mode',
          content: 'the user always works in dark mode across all projects',
          tags: ['user-preference', 'theme'],
        },
        {
          type: 'procedural',
          scope: 'project',
          title: 'run jest before commit',
          content: 'project-local test workflow',
          tags: ['test'],
        },
      ]);
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db: projectDb,
        globalDb,
        globalProjectKey: '_global',
        transcript: 'USER: I prefer dark mode\nUSER: run jest first\nASSISTANT: noted.',
        saveMemory,
        searchMemories,
        callLlm: async () => fakeReply,
      });
      assert.equal(r.skipped, null);
      assert.equal(r.extracted, 2);
      assert.equal(r.saved, 2);
      assert.equal(r.global_saved, 1, 'one global candidate was routed to the _global DB');
      // Project DB has only the project-scoped candidate.
      const projectRows = listMemories(projectDb, key, {});
      assert.equal(projectRows.length, 1);
      assert.equal(projectRows[0].title, 'run jest before commit');
      // Global DB has only the cross-project candidate.
      const globalRows = listMemories(globalDb, '_global', {});
      assert.equal(globalRows.length, 1);
      assert.equal(globalRows[0].title, 'user prefers dark mode');
      assert.equal(globalRows[0].provenance.scope, 'global');
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: dedup of a global candidate checks the global DB, not the project DB', async () => {
  // A "user prefers dark mode" row already exists in the global DB.
  // The model emits the same fact again; the dispatcher must dedup
  // it against the global corpus and skip the save.
  const home = mkTempHome();
  try {
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
    const key = deriveProjectKey('C:/test/extract-global-dedup');
    const projectDb = openDb(projectDbPath(home, key));
    const globalDbPathLocal = path.join(home, 'kimi-memory', '_global', 'memory.sqlite');
    await fs.mkdir(path.dirname(globalDbPathLocal), { recursive: true });
    const globalDb = openDb(globalDbPathLocal);
    try {
      // Seed the global DB with the fact.
      saveMemory(globalDb, '_global', {
        type: 'semantic',
        title: 'user prefers dark mode',
        content: 'cross-project user preference',
        tags: ['user-preference'],
        provenance: { source: 'memory_save', scope: 'global' },
      });
      const fakeReply = JSON.stringify([
        {
          type: 'semantic',
          scope: 'global',
          title: 'user prefers dark mode',
          content: 'the user prefers dark mode',
          tags: ['user-preference'],
        },
      ]);
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db: projectDb,
        globalDb,
        globalProjectKey: '_global',
        transcript: 'USER: I prefer dark mode',
        saveMemory,
        searchMemories,
        callLlm: async () => fakeReply,
      });
      assert.equal(r.extracted, 1);
      assert.equal(r.duplicates, 1, 'dedup hit on the global DB');
      assert.equal(r.saved, 0);
      assert.equal(r.global_saved, 0);
      // The project DB is untouched.
      assert.equal(listMemories(projectDb, key, {}).length, 0);
      // The global DB still has only the original row.
      assert.equal(listMemories(globalDb, '_global', {}).length, 1);
    } finally {
      closeDb();
    }
  } finally {
    rmRf(home);
  }
});

test('runAutoExtract: KIMI_MEMORY_AUTO_EXTRACT_GLOBAL=off reroutes global candidates to project scope', async () => {
  // The opt-out lets operators freeze the cross-project store while
  // keeping the project store running. The model still classifies;
  // the dispatcher just demotes every global candidate.
  const home = mkTempHome();
  const prev = process.env.KIMI_MEMORY_AUTO_EXTRACT_GLOBAL;
  process.env.KIMI_MEMORY_AUTO_EXTRACT_GLOBAL = 'off';
  try {
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
    const key = deriveProjectKey('C:/test/extract-global-off');
    const projectDb = openDb(projectDbPath(home, key));
    const globalDbPathLocal = path.join(home, 'kimi-memory', '_global', 'memory.sqlite');
    await fs.mkdir(path.dirname(globalDbPathLocal), { recursive: true });
    const globalDb = openDb(globalDbPathLocal);
    try {
      const fakeReply = JSON.stringify([
        {
          type: 'semantic',
          scope: 'global',
          title: 'user prefers dark mode',
          content: 'cross-project user preference',
          tags: ['user-preference'],
        },
        {
          type: 'semantic',
          scope: 'project',
          title: 'project convention',
          content: 'uses tabs',
          tags: ['style'],
        },
      ]);
      const r = await runAutoExtract({
        homeDir: home,
        cwd: 'C:/test',
        projectKey: key,
        db: projectDb,
        globalDb,
        globalProjectKey: '_global',
        transcript: 'USER: I prefer dark mode\nUSER: tabs please',
        saveMemory,
        searchMemories,
        callLlm: async () => fakeReply,
      });
      assert.equal(r.saved, 2);
      assert.equal(r.global_saved, 0, 'no global rows when the opt-out is set');
      assert.equal(listMemories(projectDb, key, {}).length, 2);
      assert.equal(listMemories(globalDb, '_global', {}).length, 0);
    } finally {
      closeDb();
    }
  } finally {
    if (prev == null) delete process.env.KIMI_MEMORY_AUTO_EXTRACT_GLOBAL;
    else process.env.KIMI_MEMORY_AUTO_EXTRACT_GLOBAL = prev;
    rmRf(home);
  }
});
