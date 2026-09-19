// Regression coverage for three audit findings that shared a root
// cause: a vocabulary or a path that was declared in more than one place
// and had quietly drifted.
//
//   1. `locateSessionArchive` joined a caller-supplied `session_id` /
//      `work_dir_key` straight into a path with no validation, so
//      `session_id: "../../.."` read a `wire.jsonl` outside the data
//      root. Reachable from the `conversation_ingest` MCP tool.
//   2. The edge-kind vocabulary existed in three places: the MCP
//      validator listed five kinds, the graph layer and the SQL CHECK
//      constraint accepted eight. The validator rejected kinds the
//      database stored.
//   3. Visibility was declared four times (acl.js, share.js, twice in
//      tool-defs.js). The DB CHECK constraint and the Zod enums had to
//      agree by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { locateSessionArchive } from '../src/wire.js';
import { validateEdgeKind } from '../src/validation.js';
import { EDGE_KINDS, edgeKindSqlList } from '../src/edge-kinds.js';
import { VISIBILITY_LEVELS, TIER_LEVELS } from '../src/vocabulary.js';
import { VISIBILITY_LEVELS as ACL_VISIBILITY } from '../src/acl.js';
import { VISIBILITY_VALUES, validTiers } from '../src/persist/share.js';
import { TOOL_DEFS_BY_NAME } from '../src/mcp/tool-defs.js';
import { openDb } from '../src/persist/connection.js';
import { mkTempHome, rmRf } from './_helpers.js';

// ---------------------------------------------------------------------
// 1. Session-archive path containment
// ---------------------------------------------------------------------

function seedSneakyArchive(root) {
  // A `wire.jsonl` one level above the sessions root — the shape a
  // traversal would reach for.
  const outside = path.join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'wire.jsonl'), '{"type":"user_message"}\n');
  return outside;
}

test('locateSessionArchive refuses to escape the sessions root', async () => {
  const root = mkTempHome('km-traverse-');
  try {
    const kimiHome = path.join(root, 'kimi-home');
    mkdirSync(path.join(kimiHome, 'sessions'), { recursive: true });
    seedSneakyArchive(root);

    const attacks = [
      ['../../outside', null], // via session_id
      ['../../../outside', null],
      [null, '../../outside'], // via work_dir_key
      ['..\\..\\outside', null], // backslash variant
      ['session', '..\\..\\outside'],
      ['..', null],
      ['.', null],
      ['a/b', null],
    ];
    for (const [sessionId, workDirKey] of attacks) {
      const found = await locateSessionArchive(kimiHome, workDirKey, sessionId);
      assert.equal(
        found,
        null,
        `traversal not blocked: id=${sessionId} key=${workDirKey} -> ${found}`,
      );
    }
  } finally {
    rmRf(root);
  }
});

test('locateSessionArchive still resolves a legitimate archive', async () => {
  const root = mkTempHome('km-traverse-ok-');
  try {
    const kimiHome = path.join(root, 'kimi-home');
    const workDirKey = 'wd_proj_abc';
    const sessionId = '11112222-3333-4444-5555-666677778888';
    const dir = path.join(kimiHome, 'sessions', workDirKey, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'wire.jsonl'), '{}\n');

    assert.equal(
      await locateSessionArchive(kimiHome, workDirKey, sessionId),
      path.join(dir, 'wire.jsonl'),
    );
    // The `agents/main/wire.jsonl` layout must resolve too.
    const nested = path.join(
      kimiHome,
      'sessions',
      'wd_nested',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    mkdirSync(path.join(nested, 'agents', 'main'), { recursive: true });
    writeFileSync(path.join(nested, 'agents', 'main', 'wire.jsonl'), '{}\n');
    assert.equal(
      await locateSessionArchive(kimiHome, 'wd_nested', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      path.join(nested, 'agents', 'main', 'wire.jsonl'),
    );
  } finally {
    rmRf(root);
  }
});

// ---------------------------------------------------------------------
// 2. Edge kinds
// ---------------------------------------------------------------------

test('the edge-kind validator accepts every canonical kind', () => {
  for (const kind of EDGE_KINDS) {
    assert.equal(validateEdgeKind(kind).ok, true, `validator rejected ${kind}`);
  }
});

test('validateEdgeKind still rejects an unknown kind and reports the full list', () => {
  const r = validateEdgeKind('not-a-kind');
  assert.equal(r.ok, false);
  // The error must name the codegraph kinds too, otherwise an operator
  // cannot discover that `defines` is legal.
  for (const kind of EDGE_KINDS) assert.match(r.error, new RegExp(kind));
});

test('the SQL CHECK constraint accepts exactly the canonical kind set', () => {
  const home = mkTempHome('km-edgekinds-');
  try {
    const db = openDb(path.join(home, 'memory.sqlite'));
    const sql = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get('memory_edges').sql;
    const insert = db.prepare(
      'INSERT INTO memory_edges (id, project_key, from_id, to_id, kind, weight, created_at) VALUES (?,?,?,?,?,?,?)',
    );
    for (const kind of EDGE_KINDS) {
      assert.doesNotThrow(
        () => insert.run(`e-${kind}`, 'p', 'a', 'b', kind, 1, '2026-01-01T00:00:00Z'),
        `schema rejected the canonical kind ${kind}`,
      );
    }
    assert.throws(() =>
      insert.run('e-bad', 'p', 'a', 'b', 'not-a-kind', 1, '2026-01-01T00:00:00Z'),
    );

    // The generated fragment and the migrated schema must list the same
    // strings — this is what stops the two from drifting again.
    const fromSql = (sql.match(/kind\s+IN\s*\(([^)]*)\)/) || [])[1] || '';
    const inSchema = fromSql
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    assert.deepEqual(inSchema.sort(), [...EDGE_KINDS].sort());
    assert.equal(fromSql, edgeKindSqlList());
  } finally {
    rmRf(home);
  }
});

// ---------------------------------------------------------------------
// 3. Visibility / tier vocabulary
// ---------------------------------------------------------------------

test('visibility is declared once and agreed on everywhere', () => {
  assert.deepEqual([...VISIBILITY_VALUES].sort(), [...VISIBILITY_LEVELS].sort());
  assert.deepEqual([...ACL_VISIBILITY].sort(), [...VISIBILITY_LEVELS].sort());

  // Every tool that takes a `visibility` input must offer exactly the
  // canonical set. This is what catches a hand-edited Zod enum.
  const toolNames = [
    'memory_save',
    'memory_recall',
    'memory_list',
    'memory_update',
    'memory_save_bulk',
    'acl_share_memory',
  ];
  let checked = 0;
  for (const name of toolNames) {
    const def = TOOL_DEFS_BY_NAME[name];
    assert.ok(def, `tool definition missing: ${name}`);
    const shape = def.input || {};
    const collect = (schema, depth = 0) => {
      if (!schema || depth > 4) return;
      const opts = schema._def && schema._def.values;
      if (Array.isArray(opts)) {
        for (const o of opts) {
          if (VISIBILITY_LEVELS.includes(o)) {
            checked += 1;
            for (const v of opts) {
              assert.ok(
                VISIBILITY_LEVELS.includes(v),
                `${name} offers non-canonical visibility: ${v}`,
              );
            }
          }
        }
      }
      const inner = schema._def && schema._def.innerType;
      if (inner) collect(inner, depth + 1);
      const opts2 = schema._def && schema._def.options;
      if (Array.isArray(opts2)) for (const o of opts2) collect(o, depth + 1);
      const el = schema._def && schema._def.type;
      if (el) collect(el, depth + 1);
    };
    for (const key of Object.keys(shape)) collect(shape[key]);
  }
  assert.ok(checked > 0, 'no visibility enum was inspected — the walker is broken');
});

test('tier vocabulary is the canonical ladder', () => {
  assert.deepEqual(validTiers().sort(), [...TIER_LEVELS].sort());
});
