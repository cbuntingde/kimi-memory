// Transaction helpers shared by the persist layer, auto-GC, and Dream.
//
// The one rule this module exists to enforce: a savepoint that has been
// rolled back is still open. `ROLLBACK TO SAVEPOINT` rewinds the work
// but leaves the savepoint (and any write transaction the `SAVEPOINT`
// itself started) on the connection stack, so the caller must still
// `RELEASE` it. A connection left in that state makes the *next*
// `BEGIN` on the same handle throw
// ("cannot start a transaction within a transaction"), which is how a
// single failed write used to poison every later write in the process.

// Run `fn` inside `SAVEPOINT name`, releasing it on both the success and
// the failure path. `fn` must be synchronous — `node:sqlite` has no async
// transaction primitive and awaiting inside a savepoint would let other
// statements interleave with it. The value returned by `fn` is returned
// to the caller; an error thrown by `fn` propagates after the savepoint
// has been unwound.
export function withSavepoint(db, name, fn) {
  // The name is interpolated — savepoints cannot be parameterized —
  // so validate once at the choke point. All in-domain callers pass
  // literals today, but out-of-domain callers build from `label`.
  // (Review finding F8.)
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`withSavepoint: invalid savepoint name: ${String(name).slice(0, 64)}`);
  }
  db.exec(`SAVEPOINT ${name}`);
  let out;
  try {
    out = fn();
  } catch (e) {
    // ROLLBACK TO alone is not enough to end the savepoint, and a
    // failure from either statement must not mask the original error —
    // the caller cares about why the work failed, not about the cleanup.
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch {
      /* savepoint already gone */
    }
    try {
      db.exec(`RELEASE SAVEPOINT ${name}`);
    } catch {
      /* already released by an enclosing rollback */
    }
    throw e;
  }
  db.exec(`RELEASE SAVEPOINT ${name}`);
  return out;
}
