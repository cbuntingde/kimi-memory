// Per-project working memory: a small key/value store scoped to the
// project (composite primary key (project_key, slot)). Used by the
// agent for in-flight context like `current_focus`, `active_task`, or
// `recent_decision`. Different from durable memory: working slots are
// not subject to decay and have no embedding.
import { nowIso } from '../util.js';

export function setWorkingMemory(db, projectKey, slot, value) {
  const now = nowIso();
  db.prepare(
    `
    INSERT INTO working_memory (slot, project_key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_key, slot) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `,
  ).run(slot, projectKey, value, now);
  return { slot, value, updated_at: now };
}

export function getWorkingMemory(db, projectKey, slot) {
  const row = db
    .prepare('SELECT * FROM working_memory WHERE slot=? AND project_key=?')
    .get(slot, projectKey);
  if (!row) return null;
  return { slot: row.slot, value: row.value, updated_at: row.updated_at };
}

export function clearWorkingMemory(db, projectKey, slot) {
  const r = db
    .prepare('DELETE FROM working_memory WHERE slot=? AND project_key=?')
    .run(slot, projectKey);
  return r.changes > 0;
}

export function listWorkingMemory(db, projectKey) {
  // The secondary `rowid DESC` sort is a tie-breaker for the common
  // case where many slots were set in the same millisecond — without
  // it, slots inserted back-to-back can return in non-deterministic
  // order across calls, and the UserPromptSubmit preview line for
  // "current_focus" can flicker. rowid is the auto-incrementing
  // physical position so the newest write on ties still wins.
  return db
    .prepare(
      'SELECT slot, value, updated_at FROM working_memory WHERE project_key=? ORDER BY updated_at DESC, rowid DESC',
    )
    .all(projectKey);
}
