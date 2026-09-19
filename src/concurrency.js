// Concurrency tracker for SQLite writes.
//
// SQLite under WAL allows one writer at a time; the rest wait on
// `busy_timeout` (set to 30s in connection.js#openDb). On top of that
// wait, the hook layer wants to know "how many writes are in flight
// right now" so the dashboard / diagnostics can show contention,
// and the durable layer wants a fast-path "is this error a busy
// conflict" check that doesn't have to re-parse the error string
// everywhere.
//
// This module is a thin process-local state holder. Two writers in
// the same process share the same Map; cross-process contention is
// invisible to this counter (that's what `busy_timeout` is for).

// Per-(dbPath, opName) write counter. The key shape mirrors the
// diagnostics log so an op can be traced from the counter to the log
// row.
const _activeWrites = new Map();
// Per-dbPath summary so callers can scope to a single DB.
const _byDb = new Map();

function bump(dbPath, opName, delta) {
  const key = `${dbPath}::${opName}`;
  const cur = _activeWrites.get(key) || { dbPath, opName, count: 0, total_ms: 0, samples: 0 };
  cur.count = Math.max(0, cur.count + delta);
  _activeWrites.set(key, cur);
  // The per-DB summary is recomputed lazily on read. We do not
  // eagerly maintain it because every recordWriteStart/End would
  // otherwise write through two maps.
  _byDb.delete(dbPath);
}

// Mark a write as started. Returns the active count for the op so
// callers can log it.
export function recordWriteStart(dbPath, opName) {
  if (!dbPath || !opName) return 0;
  bump(dbPath, opName, +1);
  return getConcurrencyStatus(dbPath).active_writes;
}

// Mark a write as finished. The durationMs is recorded into the
// per-op sample so the dashboard can show p50 / p95 latency per
// operation without re-querying the diagnostics log.
export function recordWriteEnd(dbPath, opName, durationMs = 0) {
  if (!dbPath || !opName) return;
  bump(dbPath, opName, -1);
  const key = `${dbPath}::${opName}`;
  const cur = _activeWrites.get(key);
  if (cur && durationMs > 0) {
    cur.total_ms += durationMs;
    cur.samples += 1;
  }
}

// Returns the current contention state for a DB. The shape is
// backwards-compatible with the original (audit findings) surface:
//   { active_writes: N, byOp: { opName: count, ... } }
export function getConcurrencyStatus(dbPath) {
  const byOp = {};
  let active = 0;
  for (const cur of _activeWrites.values()) {
    if (cur.dbPath !== dbPath) continue;
    if (cur.count > 0) {
      byOp[cur.opName] = cur.count;
      active += cur.count;
    }
  }
  return { active_writes: active, byOp };
}

// Reset the tracker. Used by tests; not exported for production use
// (the hook layer never resets on its own). Hidden behind the
// naming convention so Node's test runner can grab it.
export function _resetConcurrencyForTests() {
  _activeWrites.clear();
  _byDb.clear();
}

// Detect SQLITE_BUSY errors. The two signatures we see in practice:
//
//   Error: "database is locked"          — driver-emitted variant
//   Error: "SQLITE_BUSY: ..."            — codes-prefixed variant
//   Error: code === 'SQLITE_BUSY'        — node:sqlite structured
//
// Anything else returns false. The check is intentionally permissive
// — the caller always has a fallback — so slight string drift (e.g.
// "database table is locked") still trips the detector.
export function isSqliteBusyError(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') return true;
  const msg = String(err.message || err);
  if (!msg) return false;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|table is locked/i.test(msg);
}
