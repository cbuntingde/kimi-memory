// Pure constants + dispatcher-supplied module state for hook handlers.
//
// HOME / EVENT are mutated by setContext() at module load time (the
// dispatcher calls it once per dispatch) so every per-event handler
// sees the same value. The `let` export is a live ESM binding — other
// modules can `import { HOME } from './constants.js'` and read the
// current value, but they must NOT reassign it (setContext is the
// only authorised writer).

import { kimiHome, asString } from '../../../util.js';

export let HOME = kimiHome();
export let EVENT = asString(process.env.KM_HOOK_EVENT) || 'unknown';

export function setContext({ home, event }) {
  if (home) HOME = home;
  if (event) EVENT = event;
}

// ---- Safety caps ----

export const STATUS_RECENT_MEMORIES = 4;
export const STATUS_RECENT_WM_SLOTS = 5;
export const STATUS_RECENT_GLOBAL = 4;
export const PROMPT_RECALL_LIMIT = 4;
export const PROMPT_TOKEN_LIMIT = 6;

// ---- Recall tuning (UserPromptSubmit hook) ----
//
// (Audit fix — recall always returned 8 hits once a project had 8+
// memories.) The recall surface had a hard `8` per-DB constant
// regardless of pool size, so a project with 8 saved memories
// surfaced 8 hits on every prompt even when only 1 was actually
// relevant. The new shape is pool-aware + score-gap filtered; see
// `src/hooks/handlers/lib/pipeline.js:buildRecallSummary`.
//
// env: KIMI_MEMORY_RECALL_BASE_LIMIT. Hard ceiling per DB call.
// The previous default. Set above the pool-aware cap so large pools
// still surface a useful mix without flooding the agent's context.
export const RECALL_BASE_LIMIT = (() => {
  const v = Number(process.env.KIMI_MEMORY_RECALL_BASE_LIMIT);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 8;
})();
// env: KIMI_MEMORY_RECALL_MIN_HITS. Floor on the per-DB limit. A
// tiny pool (1–5 memories) should not be artificially capped below
// 3, or the user sees a single hit and assumes recall is broken
// when more rows exist. The pool-aware cap is
// `Math.ceil(poolSize * 0.5)` which is < 3 below poolSize=6; this
// floor keeps the surface usable.
export const RECALL_MIN_HITS = (() => {
  const v = Number(process.env.KIMI_MEMORY_RECALL_MIN_HITS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3;
})();
// env: KIMI_MEMORY_RECALL_GAP_FACTOR. Score-gap elbow. After
// per-type selection, drop any hit whose `score` is below
// `topScore * RECALL_GAP_FACTOR`. A hit at 40% of the top hit's
// RRF score is judged marginal and trimmed; one at 50% or above
// is judged relevant. Conservative default keeps broad-recall
// prompts from going silent; tune down for noisier corpora. Set
// to 0 to disable the gap filter entirely.
export const RECALL_GAP_FACTOR = (() => {
  const v = Number(process.env.KIMI_MEMORY_RECALL_GAP_FACTOR);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.4;
})();

// ---- Payload field name tables ----
//
// Field names Kimi has used across versions for the project's working
// directory, session id, and user prompt in hook payloads. Keep them in
// one place so the adapters stay the single point that knows about
// historical renames.

export const PAYLOAD_CWD_KEYS = [
  'cwd',
  'workdir',
  'workDir',
  'project_root',
  'projectRoot',
  'workspace',
  'cwd_path',
];
export const PAYLOAD_SESSION_KEYS = ['session_id', 'sessionId', 'session', 'id'];
export const PAYLOAD_PROMPT_KEYS = ['prompt', 'user_prompt', 'text', 'input'];

// ---- Status-line caps ----

export const MAX_THREAD_SESSIONS = 3;

// Throttle window for heavy auto-GC passes (prune + archive).
export const AUTO_GC_THROTTLE_HOURS = 6;

// Cost guards before we spend an LLM call on extraction. Tuned
// 2026-08-02: previous bounds (min=6 events, latency=5min) made the
// extract skip almost every real-world session.
export const EXTRACT_MIN_EVENTS = 4;
export const EXTRACT_MIN_AGE_MS = 0;
export const EXTRACT_MAX_LATENCY_MS =
  Number(process.env.KIMI_MEMORY_EXTRACT_MAX_LATENCY_MS) || 30 * 60 * 1000;
