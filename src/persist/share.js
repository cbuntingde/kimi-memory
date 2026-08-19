// Visibility / tier vocabulary + share + tier management.
//
// The two vocabularies (VISIBILITY_VALUES, TIER_VALUES) live here
// because they describe the share / tier feature surface. Other modules
// (CRUD, search) import these Sets directly.
import { nowIso, hashId, shortId } from '../util.js';
import { looksLikeSecret } from '../extract.js';
import { openSharedDb } from './connection.js';
import { rowToMemory, getMemory } from './memories.js';
import crypto from 'node:crypto';

// v10 ACL / visibility vocabulary. Five visibility levels mirroring
// TencentDB-Agent-Memory's `AssetVisibility` enum (private, team,
// restricted, agent, task). saveMemory falls back to 'private' when
// the input is missing or out-of-vocabulary, so a save never produces
// a row that bypasses the principal gate.
export const VISIBILITY_VALUES = new Set(['private', 'team', 'restricted', 'agent', 'task']);

export function validVisibilityLevels() {
  return [...VISIBILITY_VALUES];
}

// v10 tier model (Chat Memory L0→L1→L2→L3). The four levels mirror
// TencentDB-Agent-Memory's distillation pipeline:
//   L0 — raw save (a memory just landed; no promotion yet)
//   L1 — Stop-hook auto-extract promoted it to working state
//   L2 — access pattern promoted it to durable state
//   L3 — explicitly promoted by the agent or operator (curated)
// Every new save lands at L0; promote / demote move it along the
// chain with an audit row in persona_promotions.
const TIER_VALUES = new Set(['L0', 'L1', 'L2', 'L3']);

export function validTiers() {
  return [...TIER_VALUES];
}

export function isValidTier(v) {
  return TIER_VALUES.has(v);
}

// Internal-but-exported handle so the memories module can validate
// input tier values without re-declaring the vocabulary. The valid
// public API is `validTiers()` / `isValidTier()`; the constant is
// exposed only for cross-module consistency checks.
export const TIER_VALUES_INTERNAL = TIER_VALUES;

// Promote one or more memories to a new visibility level. Two modes:
//
//   toSharedPool: false (default)
//     Update the row in-place. The memory stays in its project DB but
//     `visibility` and `shared_with` change so the read paths can see
//     it through the new ACL gate. `sharedWith` is a JSON-encoded list
//     of principal descriptors (e.g. ['user:alice','role:editor']).
//
//   toSharedPool: true
//     Move the row out of the project DB into the cross-project shared
//     DB at _shared/memory.sqlite with project_key='_shared'. The row
//     keeps the same id so callers holding the id don't break. FTS5
//     rows are re-created on the target DB and dropped on the source.
//
// Returns { moved, updated }. `moved` is the count of rows physically
// relocated (toSharedPool=true path). `updated` is the count of rows
// whose visibility was rewritten in place. They sum to the number of
// ids the call acted on; ids that did not exist in `projectKey` are
// silently skipped (idempotent — re-running with the same ids is a
// no-op). Throws on an invalid visibility level; the caller is
// expected to validate input before invoking.
export function shareMemory(db, projectKey, ids, opts = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return { moved: 0, updated: 0 };
  const visibility = opts.visibility;
  if (!VISIBILITY_VALUES.has(visibility)) {
    throw new Error(`invalid visibility: ${visibility}`);
  }
  const sharedWith = Array.isArray(opts.sharedWith) ? opts.sharedWith : [];
  const toSharedPool = !!opts.toSharedPool;
  const kimiHomeDir = opts.kimiHomeDir;

  if (toSharedPool) {
    if (!kimiHomeDir) {
      throw new Error('shareMemory: toSharedPool=true requires kimiHomeDir');
    }
    // Defence-in-depth: refuse to promote a row whose title or content
    // matches a known credential shape. The save-side `assertNoSecret`
    // already blocks the original write, but a row could have been
    // saved under an older scanner revision, or the operator may have
    // imported via the legacy bulk path. Re-checking here keeps the
    // README's "the check is enforced at the lowest layer" claim true
    // for the cross-DB promotion path too.
    const idSet = new Set(ids);
    const candidates = db
      .prepare(
        `SELECT id, title, content FROM memories WHERE project_key = ? AND id IN (${[...idSet]
          .map(() => '?')
          .join(',')})`,
      )
      .all(projectKey, ...idSet);
    for (const r of candidates) {
      if (looksLikeSecret(r.title || '') || looksLikeSecret(r.content || '')) {
        const err = new Error(
          `secret_detected: refusing to share memory ${r.id} — title or content matches a known credential shape. Remove the secret and retry, or set KIMI_MEMORY_SECRET_SCAN=off to bypass.`,
        );
        err.code = 'KIMI_MEMORY_SECRET_DETECTED';
        throw err;
      }
    }

    const sharedDb = openSharedDb(kimiHomeDir);
    // Two-phase commit with compensation: the shared-DB writes run
    // inside their own transaction *first*, then the source-DB
    // deletes run inside a second transaction. If the source-DB
    // transaction fails after the shared writes committed, we undo
    // the shared writes in a third compensation pass so the
    // operation is effectively atomic from the caller's view.
    //
    // node:sqlite uses one native connection per dbPath, so the two
    // databases cannot share a transaction; explicit compensation
    // is the only way to keep both stores consistent on the failure
    // path. The compensating delete is idempotent (memories_acl on
    // the shared DB has no FK to memories, so an interrupted undo
    // leaves the shared DB rows orphaned but harmless — the next
    // shareMemory call for the same id no-ops via INSERT OR IGNORE).
    // (Audit fix — the previous shape interleaved shared + source
    // writes inside a single source transaction with no
    // compensation; a mid-loop failure left the shared DB with
    // rows whose source rows still existed.)
    const now = nowIso();
    let moved = 0;
    const sharedWrittenIds = [];
    sharedDb.exec('BEGIN');
    try {
      for (const id of ids) {
        const row = db
          .prepare('SELECT * FROM memories WHERE id=? AND project_key=?')
          .get(id, projectKey);
        if (!row) continue;
        let rowAfterMove = row;
        try {
          const ins = sharedDb
            .prepare(
              `INSERT OR IGNORE INTO memories (
                id, project_key, type, title, content, tags, metadata, provenance,
                confidence, status, priority, supersedes, superseded_by,
                created_at, updated_at, expires_at,
                embedding, embedding_model, embedding_dim, embedded_at,
                access_count, last_accessed_at,
                stability_days, last_rehearsed_at,
                last_embed_error,
                visibility, shared_with,
                team_id, agent_id, user_id, session_id, task_id,
                tier, persona_id
              ) VALUES (?, '_shared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              row.id,
              row.type,
              row.title,
              row.content,
              row.tags,
              row.metadata,
              row.provenance,
              row.confidence,
              row.status,
              row.priority,
              row.supersedes,
              row.superseded_by,
              row.created_at,
              now,
              row.expires_at,
              row.embedding,
              row.embedding_model,
              row.embedding_dim,
              row.embedded_at,
              row.access_count,
              row.last_accessed_at,
              row.stability_days,
              row.last_rehearsed_at,
              row.last_embed_error,
              visibility,
              JSON.stringify(sharedWith),
              row.team_id,
              row.agent_id,
              row.user_id,
              row.session_id,
              row.task_id,
              row.tier,
              row.persona_id,
            );
          if (ins.changes === 0) {
            const existing = sharedDb
              .prepare(
                "SELECT type, title, content, tags FROM memories WHERE id=? AND project_key='_shared'",
              )
              .get(id);
            if (!existing) {
              throw new Error(
                `shareMemory: insert OR IGNORE produced no row and no existing row for ${id}`,
              );
            }
            rowAfterMove = existing;
          } else {
            rowAfterMove = row;
          }
        } catch (e) {
          throw new Error(
            `shareMemory: failed to insert into shared DB for ${id}: ${e && e.message}`,
          );
        }
        const ftsSrc = rowAfterMove;
        let tagTokens = '';
        try {
          const tagArr = JSON.parse(ftsSrc.tags || '[]');
          tagTokens = Array.isArray(tagArr) ? tagArr.join(' ') : '';
        } catch {
          /* ignore */
        }
        sharedDb.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
        sharedDb
          .prepare(
            'INSERT INTO memories_fts (id, project_key, type, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(id, '_shared', ftsSrc.type, ftsSrc.title || '', ftsSrc.content || '', tagTokens);
        sharedWrittenIds.push(id);
      }
      sharedDb.exec('COMMIT');
    } catch (e) {
      try {
        sharedDb.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    // Phase 2: source-DB deletes. On COMMIT failure, compensate by
    // undoing the shared writes so the caller observes atomicity.
    db.exec('BEGIN');
    try {
      for (const id of sharedWrittenIds) {
        db.prepare('DELETE FROM memories WHERE id=? AND project_key=?').run(id, projectKey);
        db.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
        moved += 1;
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      // Compensate the shared DB writes.
      try {
        sharedDb.exec('BEGIN');
        for (const id of sharedWrittenIds) {
          sharedDb.prepare("DELETE FROM memories WHERE id=? AND project_key='_shared'").run(id);
          sharedDb.prepare('DELETE FROM memories_fts WHERE id=?').run(id);
        }
        sharedDb.exec('COMMIT');
      } catch {
        try {
          sharedDb.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
    return { moved, updated: 0 };
  }

  // In-place update path: rewrite visibility + shared_with on every id
  // that exists in the source DB. Ids that don't exist are skipped
  // silently so the call is idempotent (re-running with the same ids
  // is a no-op).
  const now = nowIso();
  let updated = 0;
  const stmt = db.prepare(
    `UPDATE memories SET visibility = ?, shared_with = ?, updated_at = ?
     WHERE id = ? AND project_key = ?`,
  );
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const r = stmt.run(visibility, JSON.stringify(sharedWith), now, id, projectKey);
      if (r.changes > 0) updated += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { moved: 0, updated };
}

// v10: tier (Chat Memory L0→L1→L2→L3) management. Every transition
// writes a row to persona_promotions so memory_tier_history can
// reconstruct the lineage. promote/demote compute the next tier from
// the current one (L0→L1→L2→L3 in either direction); setMemoryTier is
// the explicit override.
//
// All three return { memory, transition } where transition is the
// audit row, or { memory: null } when the memory is missing / soft-
// deleted. Throws on invalid tier input; the caller is expected to
// validate before invoking.

function recordPromotion(db, memoryId, fromTier, toTier, reason) {
  // Mix ms + ns + a random int into the id stamp so two transitions
  // in the same second produce different ids. Same pattern as
  // recordSkillInvocation. INSERT OR IGNORE keeps the PRIMARY KEY
  // safety net for the rare ms-collision case.
  // (Audit finding B2-6.)
  const stamp = `${nowIso()}:${Date.now() % 1e9}:${crypto.randomUUID()}`;
  const id = shortId(hashId('promo', memoryId, fromTier, toTier, reason || '', stamp), 16);
  db.prepare(
    `INSERT OR IGNORE INTO persona_promotions (id, memory_id, from_tier, to_tier, reason, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, memoryId, fromTier, toTier, reason || null, nowIso());
  return {
    id,
    memory_id: memoryId,
    from_tier: fromTier,
    to_tier: toTier,
    reason: reason || null,
    at: nowIso(),
  };
}

export function setMemoryTier(db, projectKey, memoryId, targetTier, { reason } = {}) {
  if (!TIER_VALUES.has(targetTier)) {
    throw new Error(`invalid tier: ${targetTier}`);
  }
  const row = db
    .prepare("SELECT id, tier FROM memories WHERE id=? AND project_key=? AND status='active'")
    .get(memoryId, projectKey);
  if (!row) return { memory: null, transition: null };
  if (row.tier === targetTier) {
    return {
      memory: getMemory(db, projectKey, memoryId),
      transition: null,
    };
  }
  db.prepare(`UPDATE memories SET tier = ?, updated_at = ? WHERE id = ? AND project_key = ?`).run(
    targetTier,
    nowIso(),
    memoryId,
    projectKey,
  );
  const transition = recordPromotion(db, memoryId, row.tier, targetTier, reason);
  return {
    memory: getMemory(db, projectKey, memoryId),
    transition,
  };
}

// Promote one tier up (capped at L3). Returns { memory, transition }.
export function promoteMemory(db, projectKey, memoryId, { reason } = {}) {
  const row = db
    .prepare("SELECT tier FROM memories WHERE id=? AND project_key=? AND status='active'")
    .get(memoryId, projectKey);
  if (!row) return { memory: null, transition: null };
  const order = ['L0', 'L1', 'L2', 'L3'];
  const idx = order.indexOf(row.tier);
  if (idx < 0 || idx === order.length - 1) {
    return {
      memory: getMemory(db, projectKey, memoryId),
      transition: null,
    };
  }
  return setMemoryTier(db, projectKey, memoryId, order[idx + 1], { reason });
}

// Demote one tier down (floor at L0). Returns { memory, transition }.
export function demoteMemory(db, projectKey, memoryId, { reason } = {}) {
  const row = db
    .prepare("SELECT tier FROM memories WHERE id=? AND project_key=? AND status='active'")
    .get(memoryId, projectKey);
  if (!row) return { memory: null, transition: null };
  const order = ['L0', 'L1', 'L2', 'L3'];
  const idx = order.indexOf(row.tier);
  if (idx <= 0) {
    return {
      memory: getMemory(db, projectKey, memoryId),
      transition: null,
    };
  }
  return setMemoryTier(db, projectKey, memoryId, order[idx - 1], { reason });
}

// Return the audit log of tier transitions for a memory, oldest-first.
export function listTierHistory(db, projectKey, memoryId, { limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT id, memory_id, from_tier, to_tier, reason, at
       FROM persona_promotions
       WHERE memory_id = ?
       ORDER BY datetime(at) ASC, id ASC
       LIMIT ?`,
    )
    .all(memoryId, Math.max(1, Math.min(500, limit)));
  return rows;
}
