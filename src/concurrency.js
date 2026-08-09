// Concurrency utilities for kimi-memory.
// Handles database locking, concurrent write detection, and better timeout reporting.

import { logPersistError, logPerformanceMetric } from './diagnostics.js';

// Track concurrent write attempts for diagnostics.
const activeWrites = new Map(); // dbPath -> { count, startMs, operations: [] }

export function recordWriteStart(dbPath, operation) {
  const now = Date.now();
  const entry = activeWrites.get(dbPath) || { count: 0, startMs: now, operations: [] };
  entry.count += 1;
  entry.operations.push({ op: operation, startMs: now });
  activeWrites.set(dbPath, entry);
  return entry.count;
}

export function recordWriteEnd(dbPath, operation, durationMs) {
  const entry = activeWrites.get(dbPath);
  if (!entry) return;

  entry.count = Math.max(0, entry.count - 1);
  if (entry.count === 0) {
    activeWrites.delete(dbPath);

    // Log the total write session duration if it was slow.
    const totalDurationMs = Date.now() - entry.startMs;
    if (totalDurationMs > 1000) {
      logPerformanceMetric(`db_write_session`, totalDurationMs, {
        dbPath,
        operation_count: entry.operations.length,
      }).catch(() => {});
    }
  }
}

// Get current concurrency status for a database.
export function getConcurrencyStatus(dbPath) {
  const entry = activeWrites.get(dbPath);
  return {
    dbPath,
    active_writes: entry?.count || 0,
    start_ms: entry?.startMs || null,
    elapsed_ms: entry ? Date.now() - entry.startMs : null,
    operations: entry?.operations || [],
  };
}

// Wrapper for write operations with logging and contention detection.
export async function withWriteTracking(fn, { dbPath, operation, timeoutMs = 5000 } = {}) {
  const count = recordWriteStart(dbPath, operation);
  const isContending = count > 1;
  const startMs = Date.now();

  try {
    // If we're contending with other writers, log a warning.
    if (isContending) {
      await logPerformanceMetric(`db_write_contention`, 0, {
        dbPath,
        operation,
        concurrent_writers: count,
      }).catch(() => {});
    }

    // Execute the write operation.
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        setTimeout(() => {
          const err = new Error(
            `write operation timeout after ${timeoutMs}ms: ${operation}. ` +
              `${count} concurrent writers active.`,
          );
          err.code = 'WRITE_TIMEOUT';
          reject(err);
        }, timeoutMs);
      }),
    ]);

    return result;
  } catch (error) {
    // Log write errors with concurrency context.
    const durationMs = Date.now() - startMs;
    await logPersistError(operation, error, {
      dbPath,
      concurrent_writers: count,
      duration_ms: durationMs,
    }).catch(() => {});
    throw error;
  } finally {
    const durationMs = Date.now() - startMs;
    recordWriteEnd(dbPath, operation, durationMs);
  }
}

// Enhanced saveMemoryBulk result that includes per-item status.
export function makeBulkSaveResult(items, errors = []) {
  const successful = items.length - errors.length;
  return {
    total: items.length,
    saved: successful,
    failed: errors.length,
    errors: errors.map((e, idx) => ({
      index: e.index,
      item: items[e.index],
      error_code: e.error?.code || e.error?.name || 'unknown',
      error_message: (e.error && e.error.message) || String(e.error),
    })),
  };
}

// Detect SQLITE_BUSY errors for smarter retry logic.
export function isSqliteBusyError(error) {
  if (!error) return false;
  const message = String(error.message || error).toLowerCase();
  return message.includes('sqlite_busy') || message.includes('database is locked');
}
