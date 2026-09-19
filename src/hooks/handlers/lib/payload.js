// Hook payload adapters + safe DB open + diagnostics route.
//
// Field-name tables live in `constants.js`; this module is the single
// point that knows about historical payload renames. `safeOpenDb` and
// `logDiag` are the two side-effectful primitives every per-event
// handler reaches for, so they live here next to the adapters rather
// than in a separate module.

import { existsSync } from 'node:fs';
import { canonicalizeRoot } from '../../../project-key.js';
import { openDb } from '../../../persist.js';
import { logHookDiag } from '../../../diagnostics.js';
import { EVENT, PAYLOAD_CWD_KEYS, PAYLOAD_SESSION_KEYS, PAYLOAD_PROMPT_KEYS } from './constants.js';

// ---- Diagnostics route ----

// Diagnostics route through the shared `diagnostics.js` logger so
// every hook entry lands in the same `<kimiHome>/kimi-memory/_diagnostics/hooks.log`
// the `memory_diagnostics` MCP tool reads.
export async function logDiag(level, message, extra) {
  await logHookDiag(EVENT, level, message, extra || {}).catch(() => {});
}

// ---- Payload adapters ----

export function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function payloadProjectRoot(payload) {
  if (!isPlainObject(payload)) return null;
  for (const key of PAYLOAD_CWD_KEYS) {
    const r = canonicalizeRoot(payload[key]);
    if (r) return r;
  }
  return null;
}

export function payloadSessionId(payload) {
  if (!isPlainObject(payload)) return null;
  for (const key of PAYLOAD_SESSION_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export function payloadPrompt(payload) {
  if (!isPlainObject(payload)) return '';
  for (const key of PAYLOAD_PROMPT_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

// Open a database only if it already exists. We never lazy-create the
// global store at hook time: a count against an uninitialised global
// DB would be misleading, and creating an empty file from a hook is a
// confusing side effect.
export function safeOpenDb(dbPath) {
  try {
    if (!existsSync(dbPath)) return null;
    return openDb(dbPath);
  } catch {
    return null;
  }
}

// ---- Shared string helpers ----
//
// Used by the brief summary lines. We deliberately do NOT emit the
// per-memory content in stdout — the agent can pull full content via
// `memory_recall` if it needs it, and the chat stays uncluttered.
//
// Lives here (rather than in `render.js`) so the recall and render
// modules can both use it without importing each other.
export function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural || singular + 's'}`;
}
