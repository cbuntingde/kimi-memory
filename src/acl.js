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
import { VISIBILITY_LEVELS, PRINCIPAL_KINDS, PRINCIPAL_KIND_SET } from './vocabulary.js';

// Five visibility levels mirroring TencentDB-Agent-Memory's
// `AssetVisibility` enum, and the memories_acl principal kinds. Both
// vocabularies live in ./vocabulary.js so the schema CHECK constraint,
// the Set-based validators, and the MCP tool schemas cannot disagree.
export { VISIBILITY_LEVELS, PRINCIPAL_KINDS };

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
 *
 * Returns `{ value, dropped }` so callers can surface a warning when
 * input was silently discarded (non-string, empty, too long, or past
 * the 32-entry cap). (Audit finding B4-10.)
 */
export function validateSharedWith(v) {
  if (v == null) return { value: [], dropped: [] };
  if (!Array.isArray(v)) {
    throw new Error('shared_with must be an array of strings');
  }
  const value = [];
  const dropped = [];
  const seen = new Set();
  // entries() gives us the original index so we know where to pick up
  // when we hit the cap.
  for (const [idx, entry] of v.entries()) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 128) {
      dropped.push(entry);
      continue;
    }
    const trimmed = entry.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    value.push(trimmed);
    if (value.length >= 32) {
      // The cap ate the rest. Push every remaining entry to dropped
      // and stop iterating.
      for (let i = idx + 1; i < v.length; i++) dropped.push(v[i]);
      break;
    }
  }
  return { value, dropped };
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
  // Defence-in-depth: the MCP surface validates principal_kind upstream
  // via validatePrincipalKind, but a stray call site passing a
  // malformed kind would no-op (the WHERE never matches) and return
  // false — the caller would interpret that as "grant didn't exist"
  // when in reality the input was bogus. Validate up-front so the
  // error matches the grant path. (Audit fix M3.)
  if (!PRINCIPAL_KIND_SET.has(principalKind)) {
    throw new Error(
      `invalid principal_kind: ${principalKind} (must be one of: ${PRINCIPAL_KINDS.join(', ')})`,
    );
  }
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
