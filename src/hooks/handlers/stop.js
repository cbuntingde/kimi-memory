// Stop handler (and SessionEnd / PreCompact / Interrupt /
// StopFailure). On every conversational close: idempotent ingest,
// work-log, session-focus, Dream enqueue — plus auto-extract, which
// only the events with the budget for it (Stop, SessionEnd) run. See
// `skipExtract` below.

import path from 'node:path';
import { deriveProjectKey } from '../../project-key.js';
import {
  HOME,
  EVENT,
  payloadProjectRoot,
  payloadSessionId,
  safeOpenDb,
  logDiag,
  maybeEnqueueDream,
  safeHandleStop,
  handleAutoExtract,
} from './_helpers.js';
import { saveMemory, loadIngestState, saveIngestState } from '../../persist.js';
import { nowIso } from '../../util.js';
import { maybeWriteWorkLog, recordWorkLogResult } from '../../work-log.js';
import { captureSessionFocus, recordSessionFocusResult } from '../../session-focus.js';

// `skipExtract` is set by the short-budget close events (PreCompact,
// Interrupt, StopFailure). Those hooks run on a 4 s dispatcher ceiling
// (5 s manifest budget — src/hooks/run.js + kimi.plugin.json) while the
// extract pass is bounded by 2 x LLM_TIMEOUT_MS (4 s) + a 1 s backoff
// ≈ 9 s (src/extract.js). Running it meant the timer killed the process
// mid-fetch: the provider kept billing the abandoned request, and every
// local step after the extract — the ingest-state write, work-log,
// session-focus and Dream enqueue — never ran. With `skipExtract` the
// events return `extract: null` and still do all of that local work.
export async function handleStop(payload, { skipExtract = false } = {}) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) {
    emitLinesMessage(`[kimi-memory] event=${EVENT} skipped: no project cwd in payload`);
    return { ok: false, reason: 'no project cwd in payload' };
  }
  const sessionId = payloadSessionId(payload);
  const ingest = await safeHandleStop(payload, cwd);

  let extract = null;
  if (!skipExtract && sessionId && ingest && ingest.ok !== false && !ingest.skipped) {
    try {
      extract = await handleAutoExtract(cwd, sessionId);
    } catch (e) {
      extract = { skipped: 'extract_threw', error: e && e.message };
    }
  }
  if (extract) await logDiag('info', 'auto_extract result', { extract });

  let workLog = null;
  if (ingest && ingest.ok !== false && cwd) {
    try {
      const key = deriveProjectKey(cwd);
      const dbPath = path.join(HOME, 'kimi-memory', key, 'memory.sqlite');
      const db = safeOpenDb(dbPath);
      if (db) {
        workLog = await maybeWriteWorkLog({
          db,
          projectKey: key,
          cwd,
          saveMemory,
        });
        recordWorkLogResult(key, workLog);
        await logDiag('info', 'work_log result', { key, workLog });
      }
    } catch (e) {
      workLog = { skipped: 'work_log_threw', error: e && e.message };
      await logDiag('warn', 'work_log threw', { error: e && e.message });
    }
  }

  let focus = null;
  if (ingest && ingest.ok !== false && cwd && sessionId) {
    try {
      const key = deriveProjectKey(cwd);
      const dbPath = path.join(HOME, 'kimi-memory', key, 'memory.sqlite');
      const db = safeOpenDb(dbPath);
      if (db) {
        focus = await captureSessionFocus({
          db,
          projectKey: key,
          sessionId,
          saveMemory,
        });
        recordSessionFocusResult(key, focus);
        await logDiag('info', 'session_focus result', { key, focus });
      }
    } catch (e) {
      focus = { skipped: 'session_focus_threw', error: e && e.message };
      await logDiag('warn', 'session_focus threw', { error: e && e.message });
    }
  }

  if (cwd && (extract || workLog || focus)) {
    try {
      const key = deriveProjectKey(cwd);
      const state = await loadIngestState(HOME, key);
      if (!state.sessions) state.sessions = {};
      if (extract) state.latest_extract = { ...extract, at: nowIso() };
      if (workLog) state.latest_work_log = { ...workLog, at: nowIso() };
      if (focus) state.latest_session_focus = { ...focus, at: nowIso() };
      await saveIngestState(HOME, key, state);
    } catch (e) {
      await logDiag('warn', 'failed to persist latest extract/work_log/focus', {
        error: e && e.message,
      });
    }
  }

  let dream = null;
  if (cwd) {
    try {
      const key = deriveProjectKey(cwd);
      const dbPath = path.join(HOME, 'kimi-memory', key, 'memory.sqlite');
      const db = safeOpenDb(dbPath);
      if (db) {
        dream = await maybeEnqueueDream(db, key, cwd);
        if (dream) await logDiag('info', 'dream enqueue result', { key, dream });
      }
    } catch (e) {
      dream = { skipped: 'dream_threw', error: e && e.message };
      await logDiag('warn', 'dream enqueue threw', { error: e && e.message });
    }
  }

  return { ok: true, ingest, extract, workLog, focus, dream };
}

// SessionEnd: idempotent ingest + the full pass, extract included —
// its 15 s manifest budget accommodates the ~9 s worst case. Silent on
// stdout.
export async function handleSessionEnd(payload) {
  return handleStop(payload);
}

// The three short-budget events below skip the extract pass: their 5 s
// manifest budget cannot cover it, and losing the local work that
// follows the extract is worse than losing the extract itself.
export async function handlePreCompact(payload) {
  const result = await handleStop(payload, { skipExtract: true });
  return { ok: true, snapshot: result };
}

export async function handleInterrupt(payload) {
  const cwd = payloadProjectRoot(payload);
  const snapshot = await handleStop(payload, { skipExtract: true });
  await logDiag('info', 'interrupt observed', { cwd, snapshot });
  return { ok: true, snapshot };
}

export async function handleStopFailure(payload) {
  const cwd = payloadProjectRoot(payload);
  const snapshot = await handleStop(payload, { skipExtract: true });
  await logDiag('warn', 'stop-failure observed', { cwd, snapshot });
  return { ok: true, snapshot };
}

// Inline stdout emitter so the dispatcher can stay slim without
// re-importing `emitLines` from `_helpers.js` here.
function emitLinesMessage(line) {
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* ignore */
  }
}
