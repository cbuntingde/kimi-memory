// Regression coverage for the retry classifiers.
//
// `withRetry` hands `shouldRetry` a `{ error } | { value }` state wrapper,
// not the raw error. All three wrappers in `src/retry.js` used to read
// `.code` / `.message` straight off that wrapper, so every classification
// silently fell through to its default branch:
//
//   * `withLlmRetry` NEVER retried anything — including the empty-reply
//     case the retry exists for — so a single provider flap lost the
//     whole auto-extract pass.
//   * `withAutoExtractRetry` ALWAYS retried, including on auth and
//     missing-config errors it explicitly meant to treat as permanent.
//   * `withDbRetry` never retried a busy lock.
//
// Every assertion here fails against the old code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, withLlmRetry, withDbRetry, withAutoExtractRetry } from '../src/retry.js';

// Tiny backoffs keep the suite fast; the classification is independent of
// the delay.
const FAST = { baseDelayMs: 1, maxDelayMs: 1 };

async function countAttempts(fn, wrapper) {
  let attempts = 0;
  let error = null;
  let value;
  try {
    value = await wrapper(async () => {
      attempts += 1;
      return fn(attempts);
    });
  } catch (e) {
    error = e;
  }
  return { attempts, error, value };
}

test('withLlmRetry retries an empty reply from the provider', async () => {
  // The empty-body case: no exception, no value. This is the failure the
  // retry was written for and the one it never handled.
  const { attempts } = await countAttempts(
    () => null,
    (fn) => withLlmRetry(fn, FAST),
  );
  assert.ok(attempts > 1, `an empty reply must be retried, got ${attempts} attempt(s)`);
});

test('withLlmRetry recovers when a retry succeeds', async () => {
  let n = 0;
  const out = await withLlmRetry(
    async () => {
      n += 1;
      return n === 1 ? null : 'reply';
    },
    { baseDelayMs: 1 },
  );
  assert.equal(out, 'reply');
  assert.equal(n, 2);
});

test('withLlmRetry does not retry an auth error', async () => {
  const { attempts, error } = await countAttempts(
    () => {
      throw new Error('unauthorized: invalid api key');
    },
    (fn) => withLlmRetry(fn, FAST),
  );
  assert.equal(attempts, 1, 'auth errors are permanent');
  assert.match(error.message, /unauthorized/);
});

test('withLlmRetry retries transient transport failures', async () => {
  const throwers = [
    ['timeout by message', () => new Error('request timeout')],
    ['ETIMEDOUT', () => Object.assign(new Error('socket stalled'), { code: 'ETIMEDOUT' })],
    ['ECONNRESET', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['HTTP 503', () => Object.assign(new Error('service unavailable'), { code: 503 })],
  ];
  for (const [label, make] of throwers) {
    const { attempts } = await countAttempts(
      () => {
        throw make();
      },
      (fn) => withLlmRetry(fn, FAST),
    );
    assert.ok(attempts > 1, `expected a retry for ${label}, got ${attempts} attempt(s)`);
  }
});

test('withLlmRetry stays inside the Stop hook budget', async () => {
  // The auto-extract pass runs inside the Stop hook, which the manifest
  // caps at 15s, and each attempt can burn 4s in extract.js. Two attempts
  // plus one short backoff is the ceiling that keeps the hook safe.
  const { attempts } = await countAttempts(
    () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    },
    (fn) => withLlmRetry(fn, FAST),
  );
  assert.ok(attempts <= 2, `attempt budget grew past the hook budget: ${attempts}`);
});

test('withDbRetry retries a busy lock until the budget is spent', async () => {
  const { attempts, error } = await countAttempts(
    () => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    },
    (fn) => withDbRetry(fn, FAST),
  );
  assert.ok(attempts > 1, `a busy lock must be retried, got ${attempts}`);
  assert.equal(error.code, 'SQLITE_BUSY');
});

test('withDbRetry does not retry a missing value or a non-busy error', async () => {
  const nullResult = await countAttempts(
    () => null,
    (fn) => withDbRetry(fn, FAST),
  );
  assert.equal(nullResult.attempts, 1, 'a null value is not a lock signal');

  const other = await countAttempts(
    () => {
      throw new Error('near "SELEC": syntax error');
    },
    (fn) => withDbRetry(fn, FAST),
  );
  assert.equal(other.attempts, 1, 'a syntax error is not retryable');
});

test('withAutoExtractRetry does not retry a permanent configuration error', async () => {
  for (const code of ['ENOCONFIG', 'EAUTH', 'ENOENT', 'EACCES']) {
    const { attempts } = await countAttempts(
      () => {
        throw Object.assign(new Error(`permanent: ${code}`), { code });
      },
      (fn) => withAutoExtractRetry(fn, FAST),
    );
    assert.equal(attempts, 1, `${code} must not be retried`);
  }
});

test('withAutoExtractRetry retries a transient failure and an empty reply', async () => {
  const transient = await countAttempts(
    () => {
      throw new Error('ECONNRESET');
    },
    (fn) => withAutoExtractRetry(fn, FAST),
  );
  assert.ok(transient.attempts > 1);

  const empty = await countAttempts(
    () => null,
    (fn) => withAutoExtractRetry(fn, FAST),
  );
  assert.ok(empty.attempts > 1, 'an empty reply is worth another attempt');
});

test('withRetry default classifier retries on error and on a missing value', async () => {
  const onError = await countAttempts(
    () => {
      throw new Error('boom');
    },
    (fn) => withRetry(fn, FAST),
  );
  assert.ok(onError.attempts > 1);

  const onNull = await countAttempts(
    () => null,
    (fn) => withRetry(fn, FAST),
  );
  assert.ok(onNull.attempts > 1);
});

test('withRetry returns a defined value without retrying', async () => {
  const { attempts, value } = await countAttempts(
    () => 'first',
    (fn) => withRetry(fn, FAST),
  );
  assert.equal(attempts, 1);
  assert.equal(value, 'first');
});
