// Typed edges between memories. The five kinds — related, supports,
// contradicts, supersedes, synthesizes — are a stable vocabulary the
// dashboard and any external consumers key off. Edge ids are
// deterministic, so re-linking the same (project, from, to, kind)
// tuple is idempotent.
//
// Note: `mergeMemory` (in memory.js) calls `linkMemory` to record a
// supersedes edge when merging two memories. The dependency direction
// is edges.js → (nothing inside persist); memory.js imports from here.
import { hashId, shortId, nowIso } from '../util.js';

// Allowed kinds for memory_edges. Stable, versioned vocabulary — the
// dashboard and any external consumers key off these strings.
const EDGE_KINDS = new Set(['related', 'supports', 'contradicts', 'supersedes', 'synthesizes']);

export function validEdgeKinds() {
  return [...EDGE_KINDS];
}

export function isValidEdgeKind(kind) {
  return EDGE_KINDS.has(kind);
}

// Deterministic id for an edge. Same (project_key, from, to, kind)
// always hashes to the same id, which makes memory_link idempotent —
// re-linking returns the same edge instead of erroring on the UNIQUE
// constraint.
function edgeId(projectKey, fromId, toId, kind) {
  return shortId(hashId('edge', projectKey, fromId, toId, kind), 16);
}

// Read an edge by id; returns null if not found or cross-project.
function readEdge(db, projectKey, id) {
  return (
    db.prepare('SELECT * FROM memory_edges WHERE id=? AND project_key=?').get(id, projectKey) ||
    null
  );
}

// Insert (or no-op fetch) an edge from fromId -> toId. Returns the
// existing or newly-created edge. Validates kind up-front.
export function linkMemory(db, projectKey, fromId, toId, kind, { weight = 1.0 } = {}) {
  if (!EDGE_KINDS.has(kind)) throw new Error(`invalid edge kind: ${kind}`);
  if (!fromId || !toId) throw new Error('linkMemory: fromId and toId are required');
  if (fromId === toId) throw new Error('linkMemory: fromId and toId must differ');
  const id = edgeId(projectKey, fromId, toId, kind);
  const existing = readEdge(db, projectKey, id);
  if (existing) {
    // Idempotent: same (project, from, to, kind) is a no-op. If the
    // caller passed a new weight, update it in place.
    if (Number.isFinite(weight) && Math.abs((existing.weight || 1.0) - weight) > 1e-9) {
      db.prepare('UPDATE memory_edges SET weight=? WHERE id=? AND project_key=?').run(
        weight,
        id,
        projectKey,
      );
      existing.weight = weight;
    }
    return existing;
  }
  const now = nowIso();
  db.prepare(
    `
    INSERT INTO memory_edges (id, project_key, from_id, to_id, kind, weight, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, projectKey, fromId, toId, kind, Number.isFinite(weight) ? weight : 1.0, now);
  return {
    id,
    project_key: projectKey,
    from_id: fromId,
    to_id: toId,
    kind,
    weight: Number.isFinite(weight) ? weight : 1.0,
    created_at: now,
  };
}

// Remove an edge by id. Returns true if a row was deleted.
export function unlinkMemory(db, projectKey, id) {
  const r = db.prepare('DELETE FROM memory_edges WHERE id=? AND project_key=?').run(id, projectKey);
  return r.changes > 0;
}

// List every edge touching a memory in the given scope (project or
// global). direction is "out" (from_id = id), "in" (to_id = id), or
// "both" (default). kind is optional filter.
export function listEdges(db, projectKey, id, { direction = 'both', kind = null } = {}) {
  const where = ['project_key = ?'];
  const params = [projectKey];
  if (direction === 'out') where.push('from_id = ?');
  else if (direction === 'in') where.push('to_id = ?');
  else where.push('(from_id = ? OR to_id = ?)');
  if (direction === 'out' || direction === 'in') params.push(id);
  else params.push(id, id);
  if (kind) {
    if (!EDGE_KINDS.has(kind)) throw new Error(`invalid edge kind: ${kind}`);
    where.push('kind = ?');
    params.push(kind);
  }
  const rows = db
    .prepare(
      `SELECT * FROM memory_edges WHERE ${where.join(' AND ')} ORDER BY created_at DESC, kind ASC`,
    )
    .all(...params);
  return rows.map((r) => ({
    id: r.id,
    project_key: r.project_key,
    from_id: r.from_id,
    to_id: r.to_id,
    kind: r.kind,
    weight: r.weight,
    created_at: r.created_at,
    direction: r.from_id === id ? 'out' : 'in',
  }));
}
