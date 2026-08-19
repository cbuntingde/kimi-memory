// Structured error logging for kimi-memory. Writes JSON-line records to
// $KIMI_CODE_HOME/kimi-memory/_diagnostics/hooks.log for observability
// of hook failures, auto-extract issues, and embedding errors.
//
// All logging is fail-safe: errors writing to the log file do not propagate.
// This module is designed to be called from hooks and MCP handlers.

import { promises as fs, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { kimiHome, nowIso } from './util.js';

const LOG_DIR = path.join(kimiHome(), 'kimi-memory', '_diagnostics');
const HOOKS_LOG = path.join(LOG_DIR, 'hooks.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50 MB
// Backups older than this are deleted on the next append. Mirrors the
// `ARCHIVE_CONVERSATION_EVENTS_DAYS = 180` convention in auto-gc.js
// (180 days for conversation events; 90 is enough for diagnostic
// backups since they're rotated snapshots of the same content).
const BACKUP_MAX_AGE_DAYS = 90;

// Ensure log directory exists (synchronous for hook context).
function ensureLogDir() {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

// Append a JSON-line record. Asynchronous but fail-safe.
//
// Rotation: when the log file is near MAX_LOG_SIZE the current file
// is renamed to a backup. The backup name mixes the ISO timestamp
// (millisecond precision is not unique under burst writes) with a
// process-local monotonic counter and a random suffix so two rotations
// inside the same millisecond on Windows (where `fs.rename` to an
// existing target throws `EEXIST`) cannot collide. (Audit fix
// BUG-9.)
//
// Pruning: on every rotation we also sweep the LOG_DIR for backup
// files older than BACKUP_MAX_AGE_DAYS. Bounded by a 1-hour cooldown
// so the directory listing does not run on every append. (Audit fix.)
let rotationCounter = 0;
let lastPruneAt = 0;
const PRUNE_COOLDOWN_MS = 60 * 60 * 1000;
async function maybePruneOldBackups() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_COOLDOWN_MS) return;
  lastPruneAt = now;
  const cutoffMs = now - BACKUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = readdirSync(LOG_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('hooks-') || !name.endsWith('.log')) continue;
    const full = path.join(LOG_DIR, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoffMs) await fs.unlink(full);
    } catch {
      /* ignore — another process may have already pruned it */
    }
  }
}
async function appendLog(record) {
  ensureLogDir();
  try {
    const line = JSON.stringify(record) + '\n';
    // Check size before appending; if too large, rotate by backing up the current file.
    try {
      const stat = await fs.stat(HOOKS_LOG);
      if (stat.size + line.length > MAX_LOG_SIZE) {
        const timestamp = nowIso().replace(/[:.]/g, '-');
        const seq = (++rotationCounter).toString(36);
        // Append a per-call random suffix so simultaneous rotations
        // from concurrent hook invocations / MCP handlers never
        // target the same backup path. process is cached in the
        // require cache; importing it lazily keeps the diagnostics
        // module zero-deps at module-load time.
        const { randomBytes } = await import('node:crypto');
        const suffix = randomBytes(3).toString('hex');
        const backup = path.join(LOG_DIR, `hooks-${timestamp}-${seq}-${suffix}.log`);
        await fs.rename(HOOKS_LOG, backup);
        // Sweep stale backups out-of-band of the rotation write.
        await maybePruneOldBackups();
      }
    } catch (err) {
      // ENOENT is normal (first write); other errors are silent.
      if (err && err.code !== 'ENOENT') {
        /* ignore */
      }
    }
    await fs.appendFile(HOOKS_LOG, line, 'utf8');
  } catch {
    // Silent failure: do not disrupt the hook or MCP handler.
  }
}

// Public entry point so auto-gc can drive the prune on its schedule
// instead of waiting for a rotation. The internal cooldown in
// `maybePruneOldBackups` keeps this cheap.
export async function pruneOldLogBackups() {
  ensureLogDir();
  await maybePruneOldBackups();
}

// Structured record types for different failure modes.

export async function logHookError(event, hookName, error, context = {}) {
  const record = {
    timestamp: nowIso(),
    type: 'hook_error',
    event, // e.g. 'SessionStart', 'Stop', 'UserPromptSubmit'
    hook_name: hookName,
    error_code: error?.code || error?.name || 'unknown',
    error_message: (error && error.message) || String(error),
    stack: error?.stack || null,
    context,
  };
  await appendLog(record);
}

export async function logAutoExtractError(projectKey, reason, error, context = {}) {
  const record = {
    timestamp: nowIso(),
    type: 'auto_extract_error',
    project_key: projectKey,
    reason, // e.g. 'llm_timeout', 'llm_auth', 'config_missing', 'parse_error'
    error_code: error?.code || error?.name || 'unknown',
    error_message: (error && error.message) || String(error),
    attempt: context.attempt || 1,
    max_attempts: context.max_attempts || 3,
    retry_in_ms: context.retry_in_ms || null,
    context: context.extra || {},
  };
  await appendLog(record);
}

export async function logEmbeddingError(projectKey, reason, error, context = {}) {
  const record = {
    timestamp: nowIso(),
    type: 'embedding_error',
    project_key: projectKey,
    reason, // e.g. 'timeout', 'model_load', 'dim_mismatch'
    error_code: error?.code || error?.name || 'unknown',
    error_message: (error && error.message) || String(error),
    context,
  };
  await appendLog(record);
}

export async function logPersistError(operation, error, context = {}) {
  const record = {
    timestamp: nowIso(),
    type: 'persist_error',
    operation, // e.g. 'save_memory', 'save_bulk', 'open_db'
    error_code: error?.code || error?.name || 'unknown',
    error_message: (error && error.message) || String(error),
    project_key: context.project_key || null,
    context,
  };
  await appendLog(record);
}

export async function logConversationIngestError(projectKey, sessionId, error, context = {}) {
  const record = {
    timestamp: nowIso(),
    type: 'conversation_ingest_error',
    project_key: projectKey,
    session_id: sessionId,
    error_code: error?.code || error?.name || 'unknown',
    error_message: (error && error.message) || String(error),
    context,
  };
  await appendLog(record);
}

export async function logAutoExtractRetry(projectKey, attempt, delayMs, reason) {
  const record = {
    timestamp: nowIso(),
    type: 'auto_extract_retry',
    project_key: projectKey,
    attempt,
    retry_in_ms: delayMs,
    reason, // brief description of why we're retrying
  };
  await appendLog(record);
}

// Free-form hook diagnostic. Used by the hook runner for info / warn
// entries that don't fit a specific failure shape. (Audit SG-4.)
export async function logHookDiag(event, level, message, context = {}) {
  const record = {
    timestamp: nowIso(),
    type: 'hook_diag',
    event,
    level,
    message,
    context,
  };
  await appendLog(record);
}

export async function logConfigValidationError(error, context = {}) {
  const record = {
    timestamp: nowIso(),
    type: 'config_validation_error',
    error_code: error?.code || error?.name || 'unknown',
    error_message: (error && error.message) || String(error),
    field: context.field || null,
    context,
  };
  await appendLog(record);
}

export async function logPerformanceMetric(name, durationMs, context = {}) {
  const record = {
    timestamp: nowIso(),
    type: 'perf_metric',
    metric_name: name,
    duration_ms: durationMs,
    context,
  };
  await appendLog(record);
}

// Query the log file. Returns recent records (most recent first).
export async function getRecentLogs(limit = 100, typeFilter = null) {
  ensureLogDir();
  try {
    const content = await fs.readFile(HOOKS_LOG, 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let filtered = lines;
    if (typeFilter) {
      filtered = lines.filter((r) => r.type === typeFilter);
    }

    // Most recent first
    return filtered.reverse().slice(0, limit);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    return [];
  }
}

// Summarize error counts by type for the last N hours.
export async function getErrorSummary(hoursBack = 24) {
  ensureLogDir();
  try {
    const content = await fs.readFile(HOOKS_LOG, 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const recent = lines.filter((r) => new Date(r.timestamp) >= cutoff);

    const summary = {};
    for (const record of recent) {
      if (record.type && record.type.endsWith('_error')) {
        const key = `${record.type}:${record.error_code || 'unknown'}`;
        summary[key] = (summary[key] || 0) + 1;
      }
    }
    return summary;
  } catch {
    return {};
  }
}
