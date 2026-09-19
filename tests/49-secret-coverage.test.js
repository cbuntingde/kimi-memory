// Regression coverage for the secret gate and the transcript scrubber.
//
// Written after an audit found the detector missed the most common
// real-world credential shapes (JSON-quoted keys, AWS secret access
// keys, generic *_TOKEN assignments, connection strings, `sk-proj-`)
// and that the conversation archive stored secrets verbatim.
//
// The `scrubbed` assertion is the important one: an earlier revision of
// `redactSecrets` matched the credential but rebuilt the output as
// `<value>[REDACTED_ASSIGNED_SECRET]`, i.e. it appended the token while
// leaving the secret bytes in place. Asserting only "the token appears"
// or "the result no longer re-detects" both passed that broken version.
// Every sample therefore carries the literal bytes that must not
// survive, and we assert on those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSecret, redactSecrets, redactPayload } from '../src/secrets.js';
import { openDb } from '../src/persist/connection.js';
import { recordConversationEvent, searchConversationEvents } from '../src/persist/project.js';
import { assertNoSecret } from '../src/persist/memories.js';
import { mkTempHome, rmRf } from './_helpers.js';
import path from 'node:path';

// [sample text, literal bytes that must be scrubbed]
const CREDENTIALS = [
  ['key is sk-abcdefghijklmnopqrstuvwxyz0123456789', 'sk-abcdefghijklmnopqrstuvwxyz0123456789'],
  ['sk-proj-abc123def456ghi789jklmno', 'sk-proj-abc123def456ghi789jklmno'],
  [
    'Anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234',
  ],
  ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['MY_SERVICE_TOKEN=abcdef1234567890', 'abcdef1234567890'],
  ['DATABASE_URL=postgres://admin:hunter2@db.internal/prod', 'hunter2'],
  ['{"api_key": "sk-proj-abc123def456ghi789jkl"}', 'sk-proj-abc123def456ghi789jkl'],
  ['api_key = abcdefghijklmnop', 'abcdefghijklmnop'],
  ['password: correct-horse-battery', 'correct-horse-battery'],
  ['Google: AIzaSyD-1234567890abcdefghijklmnopqrstu', 'AIzaSyD-1234567890abcdefghijklmnopqrstu'],
  [
    'GitHub PAT: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ],
  ['GitLab: glpat-abcdefghijklmnopqrst', 'glpat-abcdefghijklmnopqrst'],
  [
    'npm token npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  ],
  ['slack xoxb-abcdefghij', 'xoxb-abcdefghij'],
  ['stripe sk_live_abcdefghijklmnopqrst', 'sk_live_abcdefghijklmnopqrst'],
  ['Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIz', 'YWxhZGRpbjpvcGVuc2VzYW1lMTIz'],
  [
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    'abcdefghijklmnopqrstuvwxyz0123456789',
  ],
  [
    'JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'eyJhbGciOiJIUzI1NiJ9',
  ],
];

// Text that merely mentions a credential-adjacent word. Guard against
// over-broad patterns redacting ordinary notes.
const BENIGN = [
  'no secrets here, just a normal conversation about cats',
  'DATABASE_URL=postgres://localhost:5432/mydb',
  'we should discuss the secret santa plan for friday',
  'git commit -m "fix token refresh bug"',
  'const x = 5; // simple arithmetic',
  'the password field is 8 characters minimum',
  'see https://github.com/cbuntingde/kimi-memory for details',
  'run npm test before committing',
];

test('every credential shape is detected', () => {
  for (const [sample] of CREDENTIALS) {
    assert.equal(looksLikeSecret(sample), true, `should detect: ${sample}`);
  }
});

test('redaction removes the credential bytes, not just records that it matched', () => {
  for (const [sample, bytes] of CREDENTIALS) {
    const out = redactSecrets(sample);
    assert.equal(out.includes(bytes), false, `leaked ${bytes} from: ${sample} -> ${out}`);
  }
});

test('redacted output is never re-detected', () => {
  for (const [sample] of CREDENTIALS) {
    const out = redactSecrets(sample);
    assert.equal(looksLikeSecret(out), false, `re-detected after redaction: ${out}`);
  }
});

test('redaction is idempotent', () => {
  for (const [sample] of CREDENTIALS) {
    const once = redactSecrets(sample);
    assert.equal(redactSecrets(once), once, `not idempotent for: ${sample}`);
  }
});

test('benign text is not treated as a secret', () => {
  for (const sample of BENIGN) {
    assert.equal(looksLikeSecret(sample), false, `false positive: ${sample}`);
    assert.equal(redactSecrets(sample), sample, `mangled benign text: ${sample}`);
  }
});

test('redactSecrets preserves surrounding prose structure', () => {
  const transcript = [
    'USER: can you remember my preference?',
    'ASSISTANT: sure, what is it?',
    'USER: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY for staging.',
    'ASSISTANT: noted.',
  ].join('\n');
  const out = redactSecrets(transcript);
  assert.match(out, /USER: can you remember my preference/);
  assert.match(out, /ASSISTANT: noted\./);
  assert.equal(out.includes('wJalrXUtnFEMI'), false, 'credential bytes survived');
});

test('redactSecrets handles empty and non-string input', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(42), '');
});

test('redactPayload scrubs strings but keeps the payload valid JSON', () => {
  const raw = JSON.stringify({
    type: 'user_message',
    content: 'my key is AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok',
    nested: { list: ['api_key = abcdefghijklmnop'] },
  });
  const out = redactPayload(raw);
  const parsed = JSON.parse(out); // must not throw
  assert.equal(out.includes('wJalrXUtnFEMI'), false);
  assert.equal(out.includes('abcdefghijklmnop'), false);
  assert.equal(parsed.type, 'user_message');
  assert.equal(parsed.nested.list.length, 1);
});

test('redactPayload leaves a clean payload byte-identical', () => {
  const raw = JSON.stringify({ type: 'user_message', content: 'hello there' });
  assert.equal(redactPayload(raw), raw);
});

test('the conversation archive does not persist a pasted credential', () => {
  const home = mkTempHome('km-secret-archive-');
  try {
    const dbPath = path.join(home, 'memory.sqlite');
    const db = openDb(dbPath);
    const secret = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    recordConversationEvent(db, 'proj', 'sess-1', 1, 0, {
      raw: JSON.stringify({ type: 'user_message', content: `here is my key ${secret}` }),
      summary: `here is my key ${secret}`,
      role: 'user',
      kind: 'user',
    });
    const row = db.prepare('SELECT payload, summary FROM conversation_events').get();
    assert.equal(row.summary.includes('wJalrXUtnFEMI'), false, 'summary kept the credential');
    assert.equal(row.payload.includes('wJalrXUtnFEMI'), false, 'payload kept the credential');
    // The payload must still parse: session-focus.js re-parses it.
    JSON.parse(row.payload);
    // And the credential must not be findable through search.
    const hits = searchConversationEvents(db, 'proj', 'wJalrXUtnFEMI');
    assert.equal(hits.length, 0, 'credential was searchable');
  } finally {
    rmRf(home);
  }
});

test('assertNoSecret blocks a secret-bearing memory and honours the opt-out', () => {
  const prev = process.env.KIMI_MEMORY_SECRET_SCAN;
  try {
    delete process.env.KIMI_MEMORY_SECRET_SCAN;
    assert.throws(
      () =>
        assertNoSecret({
          title: 'deploy key',
          content: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        }),
      (e) => e.code === 'KIMI_MEMORY_SECRET_DETECTED',
      'a GitHub PAT in content must be refused',
    );
    // The same gate must run over tags, metadata and provenance — a
    // secret stashed in any of them lands in the row just the same.
    assert.throws(
      () => assertNoSecret({ title: 't', content: 'c', tags: ['api_key = abcdefghijklmnop'] }),
      (e) => e.code === 'KIMI_MEMORY_SECRET_DETECTED',
    );
    assert.throws(
      () =>
        assertNoSecret({
          title: 't',
          content: 'c',
          metadata: { nested: { deep: 'MY_TOKEN=abcdef1234567890' } },
        }),
      (e) => e.code === 'KIMI_MEMORY_SECRET_DETECTED',
    );
    // Clean input passes.
    assertNoSecret({ title: 'uses tabs', content: 'the repo indents with tabs' });

    // Documented escape hatch.
    process.env.KIMI_MEMORY_SECRET_SCAN = 'off';
    assertNoSecret({ title: 'fixture', content: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
  } finally {
    if (prev === undefined) delete process.env.KIMI_MEMORY_SECRET_SCAN;
    else process.env.KIMI_MEMORY_SECRET_SCAN = prev;
  }
});
