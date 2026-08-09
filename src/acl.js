// ACL / visibility helpers for the kimi-memory memories table.
//
// Mirrors the v10 schema additions:
//   memories.visibility     TEXT CHECK IN ('private','team','restricted','agent','task')
//   memories.shared_with    TEXT (JSON array of principal descriptors)
//   memories_acl            explicit grant table (memory_id × principal_kind × principal_id)
//
// The functions here are pure-ish: they wrap SQL with validation, but
// they never call out to embedding, network, or filesystem APIs.
// Higher-level callers (server.js / cli.js) wire them into MCP tools
// and CLI subcommands.

import { nowIso } from './util.js';

// Five visibility levels mirroring TencentDB-Agent-Memory's
// `AssetVisibility` enum. The string set is the single source of
// truth — saveMemory's default fallback reads from here.
export const VISIBILITY_LEVELS = ['private', 'team', 'restricted', 'agent', 'task'];

// Principal kinds accepted by memories_acl.principal_kind CHECK.
// `role` is for Role-Based Access Control descriptors
// (e.g. "role:editor"); `user`, `team`, `agent` are 1:1 with the
// identity columns on the memories table.
export const PRINCIPAL_KINDS = ['user', 'team', 'role', 'agent'];

const VISIBILITY_SET = new Set(VISIBILITY_LEVELS);
const PRINCIPAL_KIND_SET = new Set(PRINCIPAL_KINDS);

/**
 * Validate a visibility string. Returns the canonical string on
 * success or throws with a friendly message on failure. Accepts
 * `undefined` and returns `'private'` so callers can pass raw input.
 */
export function validateVisibility(v) {
  if (v == null || v === '') return 'private';
  if (!VISIBILITY_SET.has(v)) {
    throw new Error(`invalid visibility: ${v} (must be one of: ${VISIBILITY_LEVELS.join(', ')})`);
  }
  return v;
}

/**
 * Validate a principal kind string. Throws on invalid input.
 */
export function validatePrincipalKind(v) {
  if (!PRINCIPAL_KIND_SET.has(v)) {
    throw new Error(`invalid principal_kind: ${v} (must be one of: ${PRINCIPAL_KINDS.join(', ')})`);
  }
  return v;
}

/**
 * Validate the shared_with array. Each entry is a string descriptor
 * in the form "{kind}:{id}" (e.g. "user:alice", "role:editor").
 * Returns the cleaned array (defaults to [] on missing input).
 */
export function validateSharedWith(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    throw new Error('shared_with must be an array of strings');
  }
  const out = [];
  const seen = new Set();
  for (const entry of v) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 128) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 32) break;
  }
  return out;
}

/**
 * Grant an ACL entry for a memory. Inserts (or no-ops via UNIQUE
 * constraint) into memories_acl. Returns the resulting row.
 *
 * Throws if the memory_id is missing, the principal_kind is invalid,
 * or the principal_id is empty.
 */
export function grantMemoryAcl(db, projectKey, memoryId, principalKind, principalId) {
  if (!memoryId) throw new Error('grantMemoryAcl: memory_id is required');
  validatePrincipalKind(principalKind);
  if (!principalId || typeof principalId !== 'string') {
    throw new Error('grantMemoryAcl: principal_id is required');
  }
  const trimmedId = principalId.trim();
  if (trimmedId.length === 0 || trimmedId.length > 128) {
    throw new Error('grantMemoryAcl: principal_id must be 1-128 chars');
  }
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO memories_acl (memory_id, principal_kind, principal_id, granted_at)
     VALUES (?, ?, ?, ?)`,
  ).run(memoryId, principalKind, trimmedId, now);
  const row = db
    .prepare(
      `SELECT memory_id, principal_kind, principal_id, granted_at
       FROM memories_acl
       WHERE memory_id = ? AND principal_kind = ? AND principal_id = ?`,
    )
    .get(memoryId, principalKind, trimmedId);
  return row;
}

/**
 * Revoke an ACL entry. Returns true if a row was deleted.
 */
export function revokeMemoryAcl(db, projectKey, memoryId, principalKind, principalId) {
  const r = db
    .prepare(
      `DELETE FROM memories_acl
       WHERE memory_id = ? AND principal_kind = ? AND principal_id = ?`,
    )
    .run(memoryId, principalKind, principalId);
  return r.changes > 0;
}

/**
 * List every ACL grant on a memory. Returns an array of rows.
 */
export function listMemoryAcls(db, projectKey, memoryId) {
  return db
    .prepare(
      `SELECT memory_id, principal_kind, principal_id, granted_at
       FROM memories_acl
       WHERE memory_id = ?
       ORDER BY granted_at ASC, principal_kind ASC, principal_id ASC`,
    )
    .all(memoryId);
}

/**
 * Resolve a principal descriptor like "user:alice" into its parts.
 * Returns { kind, id } on success or null on parse failure.
 */
export function parsePrincipalDescriptor(descriptor) {
  if (typeof descriptor !== 'string') return null;
  const idx = descriptor.indexOf(':');
  if (idx <= 0 || idx >= descriptor.length - 1) return null;
  const kind = descriptor.slice(0, idx);
  const id = descriptor.slice(idx + 1);
  if (!PRINCIPAL_KIND_SET.has(kind)) return null;
  if (id.length === 0 || id.length > 128) return null;
  return { kind, id };
}
