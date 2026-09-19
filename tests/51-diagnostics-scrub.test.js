// Regression coverage for the diagnostics-log scrubber.
//
// The README promises the diagnostics log carries no absolute paths,
// host names, URLs, or credentials. That promise was false: every
// `log*Error` helper wrote `error.message` and the full `error.stack`
// verbatim, and `logHookDiag` wrote an arbitrary caller-supplied context
// object. The log sits on disk for 90 days.
//
// `diagnostics.js` resolves its log directory at module load from
// `kimiHome()`, so the temp home has to be in place before the module is
// first evaluated — hence the dynamic import below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { mkTempHome, rmRf } from './_helpers.js';

const home = mkTempHome('km-diag-');
process.env.KIMI_CODE_HOME = home;
const { logHookError, logHookDiag, logPersistError } = await import('../src/diagnostics.js');

const LOG_FILE = path.join(home, 'kimi-memory', '_diagnostics', 'hooks.log');

function readLog() {
  if (!existsSync(LOG_FILE)) return '';
  return readFileSync(LOG_FILE, 'utf8');
}

test('logHookError scrubs paths, URLs and credentials out of message and stack', async () => {
  const err = new Error(
    'ECONNREFUSED calling https://api.internal.example.com/v1/chat with key sk-abcdefghijklmnopqrstuvwxyz0123456789',
  );
  err.code = 'ECONNREFUSED';
  err.stack =
    'Error: boom\n    at open (/Users/alice/secrets/kimi-memory/src/persist/connection.js:42:7)';
  await logHookError('SessionStart', 'session-start.js', err, {
    note: 'retrying against https://api.internal.example.com/v2',
  });

  const log = readLog();
  assert.ok(log.length > 0, 'nothing was written to the log');
  // The path fragment, the host and the key must all be gone.
  assert.equal(log.includes('/Users/alice/'), false, 'absolute path leaked into the log');
  assert.equal(log.includes('kimi-memory/src/persist'), false, 'source path leaked into the log');
  assert.equal(log.includes('api.internal.example.com'), false, 'hostname leaked into the log');
  assert.equal(
    log.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'),
    false,
    'credential leaked into the log',
  );
  // The useful parts survive: the error code and a scrubbed shape.
  assert.match(log, /ECONNREFUSED/);
});

test('logPersistError scrubs a credential embedded in an error message', async () => {
  const err = new Error('auth failed for MY_SERVICE_TOKEN=abcdef1234567890');
  await logPersistError('save_memory', err, { project_key: 'abc' });
  const log = readLog();
  assert.equal(log.includes('abcdef1234567890'), false, 'credential leaked via persist error');
});

test('logHookDiag scrubs nested context values, not just the message', async () => {
  await logHookDiag('Stop', 'info', 'checking config', {
    nested: { deep: ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'] },
    url: 'https://internal.example.com/health',
  });
  const log = readLog();
  assert.equal(log.includes('wJalrXUtnFEMI'), false, 'credential leaked via nested context');
  assert.equal(log.includes('internal.example.com'), false, 'hostname leaked via context');
  assert.match(log, /checking config/, 'the diagnostic message itself must survive');
});

test('scrubbing leaves a clean error message readable', async () => {
  const err = new Error('database is locked');
  await logPersistError('open_db', err, { project_key: 'deadbeefdeadbeef' });
  const log = readLog();
  assert.match(log, /database is locked/);
  assert.match(log, /deadbeefdeadbeef/);
});

test.after(() => {
  rmRf(home);
});
