// Regressions for three fail-open / ReDoS-adjacent defects:
//   1. a corrupt embedding BLOB aborted the consolidation pass instead
//      of skipping the row (decodeVector throws; the best-effort call
//      sites needed the nullable `tryDecodeVector`),
//   2. `readJsonl` over-advanced its byte cursor by 1 per CRLF line,
//      drifting `nextByteOffset` past the end of the file,
//   3. the scheme-URL pattern in `sanitizeText` re-scanned a dot-dense
//      string from every position — O(n²) on attacker-influenced text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { mkTempHome, rmRf } from './_helpers.js';
import { openDb, closeDb, saveMemory, linkMemory } from '../src/persist.js';
import { projectDbPath, deriveProjectKey } from '../src/project-key.js';
import { runConsolidate } from '../src/consolidate.js';
import { decodeVector, tryDecodeVector, encodeVector, EMBEDDING_DIM } from '../src/embedding.js';
import { readJsonl, sanitizeText, safeErrorMessage } from '../src/util.js';

function freshProject(tag) {
  const home = mkTempHome();
  const key = deriveProjectKey('C:/test/' + tag);
  return { home, key, dbPath: projectDbPath(home, key) };
}

// Write `embedding` (a BLOB) onto an existing memory row. saveMemory
// would embed via the helper model, which the test env disables.
function setEmbedding(db, id, blob, dim) {
  db.prepare(
    'UPDATE memories SET embedding=?, embedding_dim=?, embedding_model=?, embedded_at=? WHERE id=?',
  ).run(blob, dim, 'stub', new Date().toISOString(), id);
}

// ---- 1. corrupt BLOB must not abort the pass ------------------------

test('decode: tryDecodeVector returns null where decodeVector throws', () => {
  const shortBlob = Buffer.from(new Float32Array([0.25, 0.5]).buffer); // 8 bytes
  assert.throws(() => decodeVector(shortBlob), /CORRUPT|too small/i);
  assert.equal(tryDecodeVector(shortBlob), null);
  assert.equal(tryDecodeVector(null), null);

  const nanBlob = Buffer.from(new Float32Array(EMBEDDING_DIM).fill(Number.NaN).buffer);
  assert.throws(() => decodeVector(nanBlob), /CORRUPT|non-finite/i);
  assert.equal(tryDecodeVector(nanBlob), null);

  const good = encodeVector(new Float32Array(EMBEDDING_DIM).fill(0.125));
  const back = tryDecodeVector(good);
  assert.ok(back instanceof Float32Array, 'a valid BLOB still decodes');
  assert.equal(back.length, EMBEDDING_DIM);
});

test('consolidate: a corrupt embedding BLOB is skipped, not fatal', async () => {
  const { home, key, dbPath } = freshProject('decode-failopen');
  const good = encodeVector(new Float32Array(EMBEDDING_DIM).fill(0.25));
  const shortBlob = Buffer.from(new Float32Array([0.5]).buffer); // 4 bytes
  try {
    const db = openDb(dbPath);
    for (const title of ['alpha one', 'alpha two', 'alpha three']) {
      const m = saveMemory(db, key, {
        type: 'semantic',
        title,
        content: title + ' carries its own distinct body text',
        tags: ['alpha'],
        _embed: false,
      });
      setEmbedding(db, m.id, good, EMBEDDING_DIM);
    }
    const corrupt = saveMemory(db, key, {
      type: 'semantic',
      title: 'corrupt row',
      content: 'this row has a truncated embedding blob',
      tags: ['alpha'],
      _embed: false,
    });
    setEmbedding(db, corrupt.id, shortBlob, EMBEDDING_DIM);

    const res = await runConsolidate({
      db,
      projectKey: key,
      saveMemory,
      memoryLink: linkMemory,
    });

    assert.equal(res.error, undefined, 'pass completed without an error result');
    assert.equal(res.scanned, 4, 'all four active rows were scanned');
    assert.ok(res.clusters >= 1, 'the three decodable rows still cluster');
    assert.ok(res.saved >= 1, 'a conclusion was still written');
    closeDb();
  } finally {
    rmRf(home);
  }
});

// ---- 2. readJsonl byte offsets --------------------------------------

async function collect(file) {
  const out = [];
  for await (const rec of readJsonl(file)) out.push(rec);
  return out;
}

test('readJsonl: CRLF byte offsets match the real file positions', async () => {
  const dir = mkTempHome();
  try {
    const file = path.join(dir, 'wire.jsonl');
    const lines = ['{"i":1}', '{"i":22}', '{"i":333}', '{"i":4}', '{"i":5}'];
    writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
    const size = statSync(file).size;

    const starts = [];
    let cursor = 0;
    for (const line of lines) {
      starts.push(cursor);
      cursor += Buffer.byteLength(line, 'utf8') + 2; // line + '\r\n'
    }
    assert.equal(cursor, size, 'the expected starts cover the whole file');

    const got = await collect(file);
    assert.equal(got.length, lines.length);
    got.forEach((rec, i) => {
      assert.equal(rec.line, lines[i], `line ${i + 1} content`);
      assert.equal(rec.byteOffset, starts[i], `byteOffset of line ${i + 1}`);
    });
    assert.equal(got[got.length - 1].nextByteOffset, size, 'cursor ends exactly at EOF');
  } finally {
    rmRf(dir);
  }
});

test('readJsonl: LF byte offsets are unchanged and end at EOF', async () => {
  const dir = mkTempHome();
  try {
    const file = path.join(dir, 'wire.jsonl');
    const lines = ['{"i":1}', '{"i":22}', '{"i":333}'];
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    const size = statSync(file).size;

    const starts = [];
    let cursor = 0;
    for (const line of lines) {
      starts.push(cursor);
      cursor += Buffer.byteLength(line, 'utf8') + 1;
    }

    const got = await collect(file);
    got.forEach((rec, i) => assert.equal(rec.byteOffset, starts[i]));
    assert.equal(got[got.length - 1].nextByteOffset, size);
  } finally {
    rmRf(dir);
  }
});

test('readJsonl: a partial trailing line (no newline) ends at EOF', async () => {
  const dir = mkTempHome();
  try {
    const file = path.join(dir, 'wire.jsonl');
    const body = '{"i":1}\n{"i":2}';
    writeFileSync(file, body, 'utf8');
    const size = statSync(file).size;

    const got = await collect(file);
    assert.equal(got.length, 2);
    assert.equal(got[1].byteOffset, Buffer.byteLength('{"i":1}\n', 'utf8'));
    assert.equal(got[1].nextByteOffset, size, 'no phantom terminator byte');

    // Same file with a lone trailing '\r' (no '\n').
    const crFile = path.join(dir, 'wire-cr.jsonl');
    writeFileSync(crFile, body + '\r', 'utf8');
    const crSize = statSync(crFile).size;
    const crGot = await collect(crFile);
    assert.equal(crGot.length, 2);
    assert.equal(crGot[1].line, '{"i":2}', 'the trailing \\r is stripped');
    assert.equal(crGot[1].nextByteOffset, crSize, 'no phantom terminator byte');
  } finally {
    rmRf(dir);
  }
});

test('readJsonl: a leading BOM does not move the first line offset', async () => {
  const dir = mkTempHome();
  try {
    const file = path.join(dir, 'wire.jsonl');
    writeFileSync(file, '\uFEFF{"i":1}\n{"i":2}\n', 'utf8');
    const size = statSync(file).size;
    const got = await collect(file);
    assert.equal(got.length, 2);
    assert.deepEqual(got[0].parsed, { i: 1 }, 'BOM is stripped before parsing');
    // The BOM occupies 3 bytes; the second line starts after it.
    assert.equal(got[1].byteOffset, 3 + Buffer.byteLength('{"i":1}\n', 'utf8'));
    assert.equal(got[1].nextByteOffset, size);
  } finally {
    rmRf(dir);
  }
});

// ---- 3. scheme-URL scan stays linear --------------------------------

test('sanitizeText: scheme URLs are still redacted', () => {
  assert.equal(sanitizeText('fetch failed: https://example.com/x'), 'fetch failed: <url>');
  assert.equal(sanitizeText('git+ssh://host/a'), '<url>');
  assert.equal(sanitizeText('postgres://user:pw@h/db'), '<url>');
  assert.equal(sanitizeText('no url here'), 'no url here');
});

test('sanitizeText: dot-dense input stays roughly linear (ReDoS guard)', () => {
  const big = 'a.'.repeat((64 * 1024) / 2); // 64 KB of dot-separated letters
  const t0 = performance.now();
  const out = sanitizeText(big);
  const elapsed = performance.now() - t0;
  // The unbounded scheme class took ~1900 ms here (quadratic); the
  // bounded class takes ~10 ms. 500 ms is a wide margin that still
  // fails loudly on the old pattern.
  assert.ok(elapsed < 500, `64 KB took ${elapsed.toFixed(1)}ms, expected well under 500ms`);
  assert.equal(out, big, 'nothing to redact in this input');
});

// ---- 4. path fragments: coverage + no false positives ----------------

test('safeErrorMessage: strips UNC and root-level Windows paths', () => {
  const unc = safeErrorMessage(new Error('cannot read \\\\fileserver\\share\\secret.txt'));
  assert.equal(unc.includes('fileserver'), false, 'UNC host/share is stripped');
  assert.match(unc, /<path>/);
  const root = safeErrorMessage(new Error('cannot read C:\\secret.txt'));
  assert.equal(root.includes('secret.txt'), false, 'single-segment drive path is stripped');
  assert.match(root, /<path>/);
});

test('safeErrorMessage: ordinary prose survives byte-identically', () => {
  const prose =
    'Commit and/or discard; see TCP/IP and read/write notes in docs/api/reference.md for details.';
  assert.equal(safeErrorMessage(prose), prose);
});
