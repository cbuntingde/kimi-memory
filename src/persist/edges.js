// Typed edges between memories.
//
// memory_edges is the canonical graph primitive (related | supports |
// contradicts | supersedes | synthesizes + the three codegraph kinds
// imports | calls | defines). Uses raw SQL only — no helper imports.
import { nowIso, hashId, shortId } from '../util.js';
import { EDGE_KINDS as EDGE_KIND_LIST, EDGE_KIND_SET } from '../edge-kinds.js';

// Allowed kinds for memory_edges. The vocabulary itself lives in
// ../edge-kinds.js (shared with the MCP validator and the SQL CHECK
// constraint); this module re-exports the accessors it has always
// exposed.
const EDGE_KINDS = EDGE_KIND_SET;

export function validEdgeKinds() {
  return [...EDGE_KIND_LIST];
}

export function isValidEdgeKind(kind) {
  return EDGE_KINDS.has(kind);
}

// Deterministic id for an edge. Same (project_key, from, to, kind)
// always hashes to the same id, so two writers that link the same
// quadruple target the same primary key. Combined with the INSERT OR
// IGNORE in linkMemory, the loser of a race reads back the winner's row
// instead of raising a PRIMARY KEY / UNIQUE error.
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
//
// The insert is INSERT OR IGNORE rather than a read-then-INSERT: two
// processes can both miss the read and race on the deterministic id,
// and the loser's plain INSERT would raise a PRIMARY KEY error that
// propagates out of mergeMemory's savepoint and aborts the whole merge.
// With OR IGNORE the loser silently yields and we re-read the row the
// winner wrote.
export function linkMemory(db, projectKey, fromId, toId, kind, { weight = 1.0 } = {}) {
  if (!EDGE_KINDS.has(kind)) throw new Error(`invalid edge kind: ${kind}`);
  if (!fromId || !toId) throw new Error('linkMemory: fromId and toId are required');
  if (fromId === toId) throw new Error('linkMemory: fromId and toId must differ');
  const id = edgeId(projectKey, fromId, toId, kind);
  const now = nowIso();
  const w = Number.isFinite(weight) ? weight : 1.0;
  db.prepare(
    `
    INSERT OR IGNORE INTO memory_edges (id, project_key, from_id, to_id, kind, weight, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, projectKey, fromId, toId, kind, w, now);
  const edge = readEdge(db, projectKey, id);
  if (!edge) {
    // INSERT OR IGNORE yields on a row-constraint conflict, so a missing
    // row means the row was never written at all — a CHECK / NOT NULL
    // rejection, or a concurrent delete between the insert and this read.
    // Callers read `.id` off the result, so surface the anomaly instead
    // of handing back a null edge.
    throw new Error(`linkMemory: edge ${id} was not written (insert ignored)`);
  }
  // Idempotent: same (project, from, to, kind) converges on one row. If
  // the caller passed a new weight, update it in place.
  if (Number.isFinite(weight) && Math.abs((edge.weight || 1.0) - w) > 1e-9) {
    db.prepare('UPDATE memory_edges SET weight=? WHERE id=? AND project_key=?').run(
      w,
      id,
      projectKey,
    );
    edge.weight = w;
  }
  return edge;
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
