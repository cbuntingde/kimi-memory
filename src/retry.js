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

// Wrapper for LLM call retry with specific handling for API errors.
//
// Budget arithmetic — the Stop hook is the only production caller, and the
// dispatcher kills the process at its own ceiling before the manifest
// timeout fires (src/hooks/run.js: HOOK_TIMEOUTS_MS.Stop = 14000, under the
// 15s manifest budget in kimi.plugin.json):
//
//   worst case = maxAttempts x LLM_TIMEOUT_MS + one backoff
//              = 2 x 4000ms + min(1000 x 2^0, maxDelayMs) + jitter
//              = 8000ms + ~1100ms
//              ≈ 9.1s  →  ~5s of slack under the ceiling
//
// Three attempts at a 2000ms base with a 30s delay cap (the pre-audit
// shape) would have reached ~14s and been killed mid-flight. The defaults
// below match what `auto-extract` passes so a caller that forgets them
// cannot overrun the ceiling by accident.
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
      // A structured HTTP failure: `callChat` in extract.js attaches the
      // response status as `code`, so a 5xx / 408 / 429 is transient while
      // every other 4xx (401 auth, 404 missing model, 422 bad request) is
      // permanent and must not burn the rest of the budget.
      if (typeof code === 'number') return code >= 500 || code === 408 || code === 429;
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
