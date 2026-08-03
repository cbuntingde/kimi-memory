// Retry logic for fault-tolerant operations like auto-extract and LLM calls.
// Uses exponential backoff with jitter to avoid thundering herd problems.

import { logAutoExtractRetry, logAutoExtractError } from './diagnostics.js';

// Exponential backoff calculator: delay doubles each attempt, plus jitter.
// attempt: 0-indexed (0 is first retry, 1 is second, etc.)
// baseDelayMs: starting delay (e.g. 1000ms)
// maxDelayMs: cap on delay (e.g. 60000ms)
// jitterFraction: random factor applied to delay (e.g. 0.1 = ±10%)
export function calculateBackoffMs(attempt, baseDelayMs = 1000, maxDelayMs = 60000, jitterFraction = 0.1) {
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
// fn: async function that may throw
// maxAttempts: total attempts (default 3)
// baseDelayMs: initial delay between retries (default 1000)
// maxDelayMs: max delay cap (default 60000)
// jitterFraction: ±randomness factor (default 0.1)
// diagnosticContext: { projectKey?, operationType?, extra? } for logging
// shouldRetry: (error) => boolean to decide if error is retryable (default: always true)
export async function withRetry(
  fn,
  {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 60000,
    jitterFraction = 0.1,
    diagnosticContext = {},
    shouldRetry = () => true,
  } = {}
) {
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = shouldRetry(error);

      if (!retryable || attempt === maxAttempts - 1) {
        // Either not retryable or this was the last attempt.
        throw error;
      }

      // Calculate backoff and retry.
      const delayMs = calculateBackoffMs(attempt, baseDelayMs, maxDelayMs, jitterFraction);
      const { projectKey, operationType, extra } = diagnosticContext;

      // Log the retry for observability.
      if (projectKey && operationType) {
        await logAutoExtractRetry(
          projectKey,
          attempt + 1,
          delayMs,
          `${operationType}: ${error?.code || error?.name || 'unknown'}`
        ).catch(() => {});
      }

      await sleep(delayMs);
    }
  }

  // Should never reach here, but just in case:
  throw lastError;
}

// Wrapper for auto-extract retry with semantic error classification.
// Errors are classified as retryable (e.g. network timeout) or permanent (e.g. config missing).
export async function withAutoExtractRetry(fn, { projectKey, maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  return withRetry(fn, {
    maxAttempts,
    baseDelayMs,
    diagnosticContext: { projectKey, operationType: 'auto_extract' },
    shouldRetry: (error) => {
      const code = error?.code || error?.name || '';
      const message = error?.message || '';

      // Retryable error codes/conditions:
      const retryableCodes = [
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ETIMEDOUT',
        'EHOSTUNREACH',
        'TIMEOUT',
        'RATE_LIMIT',
      ];

      // Don't retry auth errors, missing config, or semantic errors.
      const nonRetryableCodes = ['EAUTH', 'ENOENT', 'ENOCONFIG', 'EPERM', 'EACCES'];

      for (const code of nonRetryableCodes) {
        if (message.includes(code) || message.includes(code.toLowerCase())) {
          return false;
        }
      }

      for (const code of retryableCodes) {
        if (message.includes(code) || message.includes(code.toLowerCase())) {
          return true;
        }
      }

      // Default: assume transient. This is conservative — we retry on unknown errors.
      return true;
    },
  });
}

// Wrapper for LLM call retry with specific handling for API errors.
export async function withLlmRetry(
  fn,
  { projectKey, maxAttempts = 3, baseDelayMs = 2000 } = {}
) {
  return withRetry(fn, {
    maxAttempts,
    baseDelayMs,
    maxDelayMs: 30000, // LLM calls are slower; cap delay lower
    diagnosticContext: { projectKey, operationType: 'llm_call' },
    shouldRetry: (error) => {
      const message = error?.message || '';

      // Don't retry auth errors.
      if (message.includes('unauthorized') || message.includes('forbidden') || message.includes('invalid_api_key')) {
        return false;
      }

      // Retry on rate limits, timeouts, and connection errors.
      return (
        message.includes('timeout') ||
        message.includes('rate') ||
        message.includes('connection') ||
        message.includes('temporarily unavailable') ||
        (error?.code && error.code >= 500) // Server errors
      );
    },
  });
}

// Wrapper for database operations with retry on SQLITE_BUSY.
export async function withDbRetry(fn, { maxAttempts = 5, baseDelayMs = 100 } = {}) {
  return withRetry(fn, {
    maxAttempts,
    baseDelayMs,
    maxDelayMs: 5000, // DB locks usually resolve quickly
    jitterFraction: 0.05,
    shouldRetry: (error) => {
      const message = error?.message || '';
      // SQLite busy errors: database is locked
      return message.includes('SQLITE_BUSY') || message.includes('database is locked');
    },
  });
}
