// Compatibility barrel for the hook-handler helper split.
//
// The original module held every DB-coupled reader, payload adapter,
// and runner in one file. It is now split into cohesive siblings:
//
//   - payload.js     — hook payload adapters + safe DB open + diag
//   - recall.js      — recall query, ranking, gap filter, context lines
//   - render.js      — counts / status / summary / thread rendering
//   - dream-hooks.js — Dream enqueue / dreaming / ready-job apply
//   - stop.js        — wire ingest, auto-GC throttle, auto-extract
//
// This file re-exports every name so `_helpers.js` (`export *`) and
// every per-event handler keep resolving the same surface. Pure
// constants and pure formatters live in `constants.js` and `format.js`
// respectively.

export {
  logDiag,
  isPlainObject,
  payloadProjectRoot,
  payloadSessionId,
  payloadPrompt,
  safeOpenDb,
  pluralize,
} from './payload.js';
export {
  applyScoreGapFilter,
  derivePromptTokens,
  buildRecallQuery,
  readRecentFilePaths,
  diversifyHitsByType,
  buildRecallSummary,
  buildRecallContextLines,
  RECALL_FENCE_BEGIN,
  RECALL_FENCE_END,
  stripRecallMarkers,
} from './recall.js';
export {
  buildCounts,
  zeroCounts,
  buildStatusLine,
  buildRecentSummary,
  buildWorkingMemoryPreview,
  buildStaleMemoryLine,
  buildSessionThread,
  readLatestStats,
  emitLines,
} from './render.js';
export { maybeEnqueueDream, maybeDreaming, maybeApplyReadyDream } from './dream-hooks.js';
export {
  runAutoGcThrottled,
  safeHandleStop,
  buildTranscript,
  latestEventAgeMs,
  handleAutoExtract,
} from './stop.js';

// `truncate`, `firstContentLine`, and `singleLine` live in
// `src/util.js`; re-export them so the hook layer keeps a single
// import path for all three. `singleLine` is the sanitizer every
// memory-derived field must pass through before it is rendered into
// injected context.
export { truncate, firstContentLine, singleLine } from '../../../util.js';
