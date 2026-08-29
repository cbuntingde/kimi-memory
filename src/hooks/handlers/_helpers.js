// Backward-compat re-export shim.
//
// The original `_helpers.js` (1,088 lines, 51 named exports) is split
// into three focused files:
//
//   - lib/constants.js — pure constants + HOME / EVENT / setContext
//   - lib/format.js    — the 6 pure status-line segment formatters
//   - lib/pipeline.js  — DB-coupled readers, payload adapters, runners
//
// Per-event handlers (session-start.js, user-prompt-submit.js,
// stop.js, post-tool-use.js), the dispatcher (src/hooks/run.js), and
// every test that imports a helper from this path continue to resolve
// the same names. AGENTS.md explicitly endorses this shape for the
// hook split.

// eslint-disable-next-line import/extensions
export * from './lib/constants.js';
export * from './lib/format.js';
export * from './lib/pipeline.js';
