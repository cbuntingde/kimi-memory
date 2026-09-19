// Backward-compat re-export shim.
//
// The original `_helpers.js` (1,088 lines, 51 named exports) is split
// into focused files:
//
//   - lib/constants.js   — pure constants + HOME / EVENT / setContext
//   - lib/format.js      — the 6 pure status-line segment formatters
//   - lib/payload.js     — hook payload adapters + safe DB open + diag
//   - lib/recall.js      — recall query, ranking, gap filter
//   - lib/render.js      — counts / status / summary / thread rendering
//   - lib/dream-hooks.js — Dream enqueue / dreaming / ready-job apply
//   - lib/stop.js        — wire ingest, auto-GC throttle, auto-extract
//   - lib/pipeline.js    — compatibility barrel re-exporting the above
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

// Re-exported directly (rather than via lib/pipeline.js) so the hook
// layer and `session-focus.js` share one identity for these helpers.
export {
  buildSessionFocusLine,
  formatFocusSegment,
  readLatestSessionFocus,
} from '../../session-focus.js';
