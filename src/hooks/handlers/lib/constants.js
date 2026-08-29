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
