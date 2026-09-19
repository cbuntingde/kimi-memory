// Lazy tool registry helpers for the v10 `memory_tools_list` surface.
//
// `buildToolRegistry(defs)` indexes a TOOL_DEFS-shaped array (the same
// shape used in `src/server.js`) by tool name and exposes only the
// fields callers need (`name`, `desc`, `inputSchema`). Storing the
// schema separately lets the agent's tool-listing response omit the
// heavy input object for lazy load — clients request the schema only
// when they intend to call the tool.
//
// `filterToolRegistry(reg, query)` returns lightweight entries (`name`
// + `desc` only, no inputSchema). A non-empty query filters by case-
// insensitive substring against name and desc; an empty query returns
// every entry capped at TOOL_LIST_MAX so a misbehaving caller cannot
// enumerate every tool at once.
//
// Lives in its own module so both `src/persist.js` and `src/server.js`
// can import the helpers without creating a circular dependency.

const TOOL_LIST_MAX = 100;

// Build a Map<name, {name, desc, inputSchema}> from an array of
// `{name, desc, input}` entries. Entries without a name are skipped —
// they cannot be called by name and would pollute the index.
export function buildToolRegistry(defs) {
  const reg = new Map();
  if (!Array.isArray(defs)) return reg;
  for (const d of defs) {
    if (!d || typeof d !== 'object') continue;
    if (typeof d.name !== 'string' || d.name.length === 0) continue;
    reg.set(d.name, {
      name: d.name,
      desc: typeof d.desc === 'string' ? d.desc : '',
      inputSchema: d.input || null,
    });
  }
  return reg;
}

// Return lightweight `{name, desc}` entries filtered by query. The
// query is a case-insensitive substring against name and desc; empty
// query returns every entry. Result is capped at TOOL_LIST_MAX.
export function filterToolRegistry(registry, query = '') {
  if (!registry || typeof registry.get !== 'function') return [];
  const all = [...registry.values()].map((entry) => ({
    name: entry.name,
    desc: entry.desc,
  }));
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const filtered = q
    ? all.filter((e) => e.name.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q))
    : all;
  return filtered.slice(0, TOOL_LIST_MAX);
}
