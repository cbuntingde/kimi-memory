// Shared vocabulary for the memory row's enum columns.
//
// These values were declared in four places that had to agree but were
// kept in sync by hand: `src/acl.js` (array), `src/persist/share.js`
// (Set), `src/persist/memories.js` + `src/persist/search.js` (imported
// from share.js), and six hardcoded Zod enums in `src/mcp/tool-defs.js`.
//
// Besides the duplication, `memories.js` importing the vocabulary from
// `share.js` while `share.js` imported `rowToMemory`/`getMemory` from
// `memories.js` was a genuine import cycle — the two modules could not
// be loaded or tested independently. The vocabulary lives here instead:
// a leaf module with no imports, so any layer may depend on it.

export const VISIBILITY_LEVELS = Object.freeze(['private', 'team', 'restricted', 'agent', 'task']);
export const VISIBILITY_SET = new Set(VISIBILITY_LEVELS);

// Tier is the persona-promotion ladder: L0 (working context) up to L3
// (durable persona fact).
export const TIER_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);
export const TIER_SET = new Set(TIER_LEVELS);

// Principal kinds accepted by the memories_acl.principal_kind CHECK.
// `role` carries Role-Based Access Control descriptors (e.g.
// "role:editor"); `user`, `team` and `agent` map 1:1 to the identity
// columns on the memories table.
export const PRINCIPAL_KINDS = Object.freeze(['user', 'team', 'role', 'agent']);
export const PRINCIPAL_KIND_SET = new Set(PRINCIPAL_KINDS);
