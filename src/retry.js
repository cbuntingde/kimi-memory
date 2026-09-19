// Retry logic for fault-tolerant operations like auto-extract and LLM calls.
// Uses exponential backoff with jitter to avoid thundering herd problems.

import { logAutoExtractRetry } from './diagnostics.js';

// Exponential backoff calculator: delay doubles each attempt, plus jitter.
// attempt: 0-indexed (0 is first retry, 1 is second, etc.)
// baseDelayMs: starting delay (e.g. 1000ms)
// maxDelayMs: cap on delay (e.g. 60000ms)
// jitterFraction: random factor applied to delay (e.g. 0.1 = ±10%)
export function calculateBackoffMs(
  attempt,
  baseDelayMs = 1000,
  maxDelayMs = 60000,
  jitterFraction = 0.1,
) {
  if (attempt < 0) return 0;
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = capped * jitterFraction * (Math.random() * 2 - 1); // ±jitterFraction
  return Math.max(0, Math.round(capped + jitter));
}

// Sleep for ms milliseconds.
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry a function with exponential backoff.
// fn: async function that may throw OR may resolve to a falsy outcome
// (e.g. null). The previous shape only retried on thrown errors; any
// caller that swallows failures into null/undefined (the LLM
// `callChat`, for example) never saw its retry budget consumed, and a
// single flapping provider silently dropped every extract call.
// (Audit fix.) `shouldRetry` may inspect either a thrown error or a
// resolved value via the same predicate — both `thrown` and
// `resolved` falsy/exception states are routed through the same
// retry classifier.
// maxAttempts: total attempts (default 3)
// baseDelayMs: initial delay between retries (default 1000)
// maxDelayMs: max delay cap (default 60000)
// jitterFraction: ±randomness factor (default 0.1)
// diagnosticContext: { projectKey?, operationType?, extra? } for logging
// shouldRetry: (error|outcome) => boolean to decide if the failure is retryable
// (default: retries on either thrown errors OR null/undefined outcomes).
export async function withRetry(
  fn,
  {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 60000,
    jitterFraction = 0.1,
    diagnosticContext = {},
    shouldRetry = (state) => {
      // `state` is `{ error?: Error, value?: any }` — retry when either
      // a real exception was thrown OR the resolved outcome is missing.
      // Throwing is the legacy path; the resolved-null path is what the
      // LLM retry needs to fire today.
      return Boolean(state && (state.error || state.value == null));
    },
  } = {},
) {
  let lastError = null;
  let lastValue;
  let lastHadValue = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let outcome;
    try {
      outcome = { value: await fn() };
    } catch (error) {
      outcome = { error };
    }
    const { error, value } = outcome;
    lastError = error || null;
    lastValue = value;
    lastHadValue = !error;

    // Success: an exception-free call that returned a defined value is
    // a final answer. Return immediately.
    if (!error && value != null) return value;

    // Build the (error|outcome) view that shouldRetry expects.
    const state = error ? { error } : { value };
    const retryable = shouldRetry(state);

    if (!retryable || attempt === maxAttempts - 1) {
      // Either not retryable or last attempt. Propagate the original
      // error if one was thrown; otherwise resolve to the last
      // (likely-null) outcome so the caller can still inspect it.
      if (error) throw error;
      return value;
    }

    const delayMs = calculateBackoffMs(attempt, baseDelayMs, maxDelayMs, jitterFraction);
    const { projectKey, operationType, extra } = diagnosticContext;
    if (projectKey && operationType) {
      await logAutoExtractRetry(
        projectKey,
        attempt + 1,
        delayMs,
        `${operationType}: ${error ? error.code || error.name || 'error' : 'no_reply'}`,
      ).catch(() => {});
    }
    await sleep(delayMs);
  }

  // Final attempt path: return the last resolved value (likely null)
  // so a caller that distinguishes "got an empty reply" from "errored"
  // can still tell. Errors thrown on the final attempt were already
  // propagated by the in-loop branch above.
  if (lastError) throw lastError;
  return lastHadValue ? lastValue : undefined;
}

// Wrapper for auto-extract retry with semantic error classification.
// Errors are classified as retryable (e.g. network timeout) or permanent
// (e.g. config missing).
//
// `shouldRetry` receives the `{ error } | { value }` state wrapper that
// `withRetry` builds — NOT the raw error. Every wrapper in this file used
// to read `.code` / `.message` straight off the wrapper, so each
// classification silently fell through to its default branch: this one
// always retried (including on auth errors), and `withLlmRetry` below
// never retried at all.
export async function withAutoExtractRetry(
  fn,
  { projectKey, maxAttempts = 3, baseDelayMs = 1000 } = {},
) {
  return withRetry(fn, {
    maxAttempts,
    baseDelayMs,
    diagnosticContext: { projectKey, operationType: 'auto_extract' },
    shouldRetry: (state) => {
      const err = state && state.error;
      // An exception-free call that produced no reply is the common LLM
      // failure shape and is worth another attempt.
      if (!err) return true;
      const code = err.code || err.name || '';
      const message = err.message || '';
      // Don't retry auth errors, missing config, or semantic errors.
      const nonRetryable = ['EAUTH', 'ENOENT', 'ENOCONFIG', 'EPERM', 'EACCES'];
      for (const c of nonRetryable) {
        if (code === c || message.includes(c)) return false;
      }
      // Everything else is assumed transient.
      return true;
    },
  });
}

// Wrapper for LLM call retry with specific handling for API errors.
//
// The attempt budget is deliberately small. The only production caller is
// the auto-extract pass inside the Stop hook, which the manifest gives a
// 15s timeout, and each attempt can burn up to `LLM_TIMEOUT_MS` (4s) in
// `extract.js`. Two attempts plus one short backoff is ~8.5s worst case,
// leaving the hook room to finish. Three attempts at the old 2s base,
// with a 30s delay cap, could have overrun the hook timeout.
export async function withLlmRetry(
  fn,
  { projectKey, maxAttempts = 2, baseDelayMs = 500, maxDelayMs = 1000 } = {},
) {
  return withRetry(fn, {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    diagnosticContext: { projectKey, operationType: 'llm_call' },
    shouldRetry: (state) => {
      const err = state && state.error;
      // No exception and no reply — a flapping gateway returning an empty
      // body. This is the case the retry exists for.
      if (!err) return true;
      const message = String(err.message || '');
      const code = err.code;
      // Don't retry auth errors.
      if (
        message.includes('unauthorized') ||
        message.includes('forbidden') ||
        message.includes('invalid_api_key')
      ) {
        return false;
      }
      if (typeof code === 'number' && code >= 500) return true;
      if (typeof code === 'string' && /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(code)) {
        return true;
      }
      return (
        message.includes('timeout') ||
        message.includes('rate') ||
        message.includes('connection') ||
        message.includes('temporarily unavailable')
      );
    },
  });
}

// Two busy signatures reach us in practice: the driver's
// "database is locked" string and the codes-prefixed / structured
// (err.code) variants. Deliberately permissive — the caller always has
// a fallback — so slight string drift (e.g. "table is locked") still
// trips the detector.
export function isSqliteBusyError(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') return true;
  const msg = String(err.message || err);
  if (!msg) return false;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|table is locked/i.test(msg);
}

// Wrapper for database operations with retry on SQLITE_BUSY.
//
// Only a thrown busy error counts. A resolved-but-null value is not a
// lock signal, so this deliberately does not use `withRetry`'s default
// classifier, which treats any missing value as retryable.
export async function withDbRetry(fn, { maxAttempts = 5, baseDelayMs = 100 } = {}) {
  return withRetry(fn, {
    maxAttempts,
    baseDelayMs,
    maxDelayMs: 5000, // DB locks usually resolve quickly
    jitterFraction: 0.05,
    shouldRetry: (state) => isSqliteBusyError(state && state.error),
  });
}
