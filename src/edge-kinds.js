// Canonical `memory_edges.kind` vocabulary.
//
// Single source of truth for three consumers that used to declare the
// list independently and had already drifted apart:
//
//   * src/validation.js         — the MCP input validator
//   * src/persist/edges.js      — the graph primitives
//   * src/persist/connection.js — the SQL CHECK constraint
//
// The validator listed only the five memory kinds, while the schema and
// the graph layer also accept the three CodeGraph kinds (`imports`,
// `calls`, `defines`). `validateEdgeKind` therefore rejected kinds the
// database was perfectly happy to store.
//
// Leaf module: no imports, so any layer may depend on it.

export const EDGE_KINDS = Object.freeze([
  'related',
  'supports',
  'contradicts',
  'supersedes',
  'synthesizes',
  'imports',
  'calls',
  'defines',
]);

export const EDGE_KIND_SET = new Set(EDGE_KINDS);

export function isValidEdgeKind(kind) {
  return EDGE_KIND_SET.has(kind);
}

// The `('related','supports',…)` fragment for the SQL CHECK constraint.
// Derived so the schema cannot disagree with the vocabulary it enforces.
export function edgeKindSqlList() {
  return EDGE_KINDS.map((k) => `'${k}'`).join(',');
}
