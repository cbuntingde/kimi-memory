// Tests for redactSecrets — the transcript scrubber applied before
// auto-extract sends the conversation to the configured LLM provider.
// (Audit finding H3 / B3-1.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, looksLikeSecret } from '../src/extract.js';

test('redactSecrets replaces provider key shapes with stable tokens', () => {
  const samples = [
    { in: 'key is sk-abcdefghijklmnopqrstuvwxyz0123456789', token: '[REDACTED_PROVIDER_KEY]' },
    {
      in: 'Anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789AB',
      token: '[REDACTED_PROVIDER_KEY]',
    },
    { in: 'AKIAIOSFODNN7EXAMPLE for the staging env.', token: '[REDACTED_PROVIDER_KEY]' },
    { in: 'GitHub PAT: ghp_abcdefghijklmnopqrstuvwxyz0123456789', token: '[REDACTED_PROVIDER_KEY]' },
    {
      in: 'JWT: eyJabcdefghijk.eyJabcdefghijk.eyJabcdefghijk_',
      token: '[REDACTED_PROVIDER_KEY]',
    },
  ];
  for (const s of samples) {
    const out = redactSecrets(s.in);
    assert.match(out, new RegExp(s.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), s.in);
    assert.ok(!out.includes(s.in.match(/sk-[A-Za-z0-9]+|AKIA\w+|ghp_\w+|eyJ[^.]+/)?.[0] || ''), 'original key bytes were scrubbed');
  }
});

test('redactSecrets replaces PEM blocks with [REDACTED_PEM_BLOCK]', () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxxxxxxxx
-----END RSA PRIVATE KEY-----`;
  const out = redactSecrets(pem);
  assert.match(out, /\[REDACTED_PEM_BLOCK\]/);
  assert.ok(!out.includes('MIIEowIBAAK'), 'PEM body was scrubbed');
});

test('redactSecrets replaces generic key=value assignments', () => {
  const out = redactSecrets('Configuration: api_key = abcdefghijklmnop');
  assert.match(out, /\[REDACTED_ASSIGNED_SECRET\]/);
  assert.ok(!out.includes('abcdefghijklmnop'), 'value bytes were scrubbed');
});

test('redactSecrets replaces Authorization Bearer headers', () => {
  const out = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890');
  assert.match(out, /Authorization: Bearer \[REDACTED\]/);
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz1234567890'), 'bearer token bytes were scrubbed');
});

test('redactSecrets leaves clean text unchanged', () => {
  const clean = 'no secrets here, just a normal conversation about cats';
  assert.equal(redactSecrets(clean), clean);
});

test('redactSecrets output is safe against the save-side looksLikeSecret check', () => {
  // Defence in depth — if the LLM accidentally echoes a redacted
  // token back into a candidate memory, the save-side secret scan
  // must still treat it as safe.
  const dirty = 'Use api_key = abcdefghijklmnop for tests.';
  assert.equal(looksLikeSecret(dirty), true, 'precondition: dirty text matches');
  const clean = redactSecrets(dirty);
  assert.equal(looksLikeSecret(clean), false, 'redacted text must NOT match');
});

test('redactSecrets handles empty and non-string input', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(42), '');
});

test('redactSecrets preserves the structure of a multi-line transcript', () => {
  const transcript = [
    'USER: hi, can you remember my preference?',
    'ASSISTANT: sure — what is it?',
    'USER: api_key = abcdefghijklmnop for the staging env.',
    'ASSISTANT: noted.',
  ].join('\n');
  const out = redactSecrets(transcript);
  assert.match(out, /USER: hi, can you remember my preference/);
  assert.match(out, /ASSISTANT: noted\./);
  assert.match(out, /\[REDACTED_ASSIGNED_SECRET\]/);
  assert.ok(!out.includes('abcdefghijklmnop'), 'value bytes were scrubbed');
});