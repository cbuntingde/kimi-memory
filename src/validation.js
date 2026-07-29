// Input validation shared between MCP tools and tests.
import { canonicalizeRoot } from './project-key.js';

const TYPES = new Set(['working', 'episodic', 'semantic', 'procedural']);
const STATUSES = new Set(['active', 'superseded', 'deleted']);
const SLOTS = new Set(['current_focus', 'active_task', 'recent_decision', 'context_note', 'open_questions']);
const CONV_ROLES = new Set(['user', 'assistant', 'tool', 'system']);

// Memory scope vocabulary. Read tools (memory_recall/list/get) accept
// "all" so a default caller can see project+global in one shot. Write
// tools (memory_save/update/delete) require an explicit target because
// merging or guessing the write target would leak cross-project data.
const SCOPES_WRITE = new Set(['project', 'global']);
const SCOPES_READ = new Set(['project', 'global', 'all']);

export function resolveProjectRoot(input) {
  // Accept either an object with cwd/root, a string, or null.
  if (!input) return { ok: false, error: 'project cwd is required' };
  if (typeof input === 'string') {
    const c = canonicalizeRoot(input);
    if (!c) return { ok: false, error: `invalid project cwd: ${input}` };
    return { ok: true, value: c };
  }
  if (typeof input === 'object') {
    const c = canonicalizeRoot(input.cwd ?? input.root ?? input.projectRoot);
    if (!c) return { ok: false, error: 'project cwd is required (must be absolute)' };
    return { ok: true, value: c };
  }
  return { ok: false, error: 'project cwd is required' };
}

export function coerceString(v, max = 200000) {
  if (typeof v !== 'string') return null;
  if (v.length === 0 || v.length > max) return null;
  return v;
}

export function validateType(v) {
  if (!TYPES.has(v)) return { ok: false, error: `type must be one of: ${[...TYPES].join(', ')}` };
  return { ok: true, value: v };
}

export function validateStatus(v) {
  if (v == null) return { ok: true, value: 'active' };
  if (!STATUSES.has(v)) return { ok: false, error: `status must be one of: ${[...STATUSES].join(', ')}` };
  return { ok: true, value: v };
}

export function validateSlot(v) {
  if (!v || typeof v !== 'string') return { ok: false, error: 'slot is required' };
  if (!SLOTS.has(v)) return { ok: true, value: v, warning: `non-standard slot '${v}'` };
  return { ok: true, value: v };
}

export function validateRole(v) {
  if (v == null) return { ok: true, value: null };
  if (!CONV_ROLES.has(v)) return { ok: false, error: `role must be one of: ${[...CONV_ROLES].join(', ')}` };
  return { ok: true, value: v };
}

export function validateConfidence(v) {
  if (v == null) return { ok: true, value: 0.8 };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return { ok: false, error: 'confidence must be a number in [0, 1]' };
  return { ok: true, value: n };
}

export function validateLimit(v, lo, hi, fallback) {
  if (v == null) return { ok: true, value: fallback };
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return { ok: false, error: `limit must be an integer in [${lo}, ${hi}]` };
  return { ok: true, value: Math.trunc(n) };
}

export function validateOffset(v) {
  if (v == null) return { ok: true, value: 0 };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'offset must be a non-negative integer' };
  return { ok: true, value: Math.trunc(n) };
}

export function validateTags(v) {
  if (v == null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, error: 'tags must be an array of strings' };
  const out = [];
  for (const t of v) {
    if (typeof t !== 'string' || t.length === 0) continue;
    if (t.length > 64) return { ok: false, error: 'each tag must be 1-64 characters' };
    out.push(t);
    if (out.length >= 32) break;
  }
  return { ok: true, value: out };
}

export function validateMetadata(v) {
  if (v == null) return { ok: true, value: {} };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'metadata must be an object' };
  return { ok: true, value: v };
}

export function validateProvenance(v) {
  return validateMetadata(v);
}

export function validateExpiresAt(v) {
  if (v == null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: 'expires_at must be an ISO-8601 string' };
  const t = Date.parse(v);
  if (Number.isNaN(t)) return { ok: false, error: 'expires_at must be a parseable ISO-8601 string' };
  return { ok: true, value: new Date(t).toISOString() };
}

export function validateId(v) {
  if (typeof v !== 'string' || v.length < 4 || v.length > 64) return { ok: false, error: 'id must be a 4-64 char string' };
  return { ok: true, value: v };
}

export function validatePriority(v) {
  if (v == null) return { ok: true, value: 0 };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, error: 'priority must be an integer' };
  return { ok: true, value: Math.trunc(n) };
}

export function validateScope(v, { read = false } = {}) {
  const fallback = read ? 'all' : 'project';
  if (v == null) return { ok: true, value: fallback };
  const allowed = read ? SCOPES_READ : SCOPES_WRITE;
  if (!allowed.has(v)) {
    const list = [...allowed].join(', ');
    return { ok: false, error: `scope must be one of: ${list}` };
  }
  return { ok: true, value: v };
}

export function toError(error) {
  return { ok: false, error: typeof error === 'string' ? error : (error && error.message) ? error.message : 'unknown error' };
}
