// Session-focus auto-capture.
//
// Goal: every session ends with a `working`-type memory that captures
// "what we were working on" so the next SessionStart can show the
// user where they left off. Auto-extract deliberately skips transient
// tasks (per EXTRACT_SYSTEM_PROMPT in extract.js), and the work-log
// only summarises daily activity (commits + event counts + memory
// titles). Neither answers "what were we doing?" — this module fills
// that gap.
//
// Deterministic, no LLM call: pulls the most recent user prompt
// summaries from `conversation_events` and writes a single memory
// with type='working', title 'Last focus: <truncated prompt>', and a
// body that lists the last few user prompts so the next session has
// the thread to pick up.
//
// Idempotency: the title is derived from the latest user prompt, so
// the same session's Stop hook re-running lands on the same
// (type, title) and the row is updated (supersede=true via
// saveMemory). Across sessions with different focuses, each session
// gets a fresh row; the most recent by `updated_at` is what
// SessionStart / UserPromptSubmit surfaces.
//
// Trigger thresholds (wired in run.js):
//   - At least SESSION_FOCUS_MIN_PROMPTS user prompts in the session
//     AND at least one has a non-empty summary. The wire ingest pass
//     populates `summary` for textual events; tool-only sessions
//     cleanly skip.
//
// Fail-open: every step is wrapped so a missing DB, no events, or a
// save error never throws out of the hook. Returns
// `{ skipped, written, updated, reason, id?, title? }`.

import { nowIso } from './util.js';
import { extractSummary } from './wire.js';

// Slice a string on a UTF-16 code-point boundary so a surrogate pair
// is never split in half. The previous shape used `s.slice(0, N)`
// directly, which can leave a lone high surrogate at the boundary
// and produce an invalid UTF-16 sequence on the next character —
// the agent's terminal renders the result as a `?` replacement on
// recall. (Audit fix BUG-10.)
function sliceCodePointSafe(s, n) {
  if (!s || s.length <= n) return s;
  let cut = n;
  while (cut > 0 && (s.charCodeAt(cut - 1) & 0xfc00) === 0xdc00) cut -= 1;
  return s.slice(0, cut);
}

export const SESSION_FOCUS_MIN_PROMPTS = 1;
export const SESSION_FOCUS_TAKE_PROMPTS = 3; // how many to surface in body
export const SESSION_FOCUS_TITLE_MAX = 100; // truncated for title
export const SESSION_FOCUS_TTL_DAYS = 30; // expires_at horizon
export const SESSION_FOCUS_TAG = 'session-focus'; // membership tag

// Stable title derived from the latest user prompt. Used as the
// supersede key, so consecutive Stops within the same session land on
// the same row.
export function sessionFocusTitle(firstPrompt) {
  const clean = (firstPrompt || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Last focus: (no prompt summary)';
  const truncated =
    clean.length > SESSION_FOCUS_TITLE_MAX
      ? sliceCodePointSafe(clean, SESSION_FOCUS_TITLE_MAX) + '…'
      : clean;
  return `Last focus: ${truncated}`;
}

// Fetch the most recent user prompts for a session, oldest → newest.
// Reads from `conversation_events` (populated by the wire ingest).
//
// Summary extraction: the wire ingest populates `summary` via
// `extractSummary(parsed)` for textual events; non-textual events
// (tool calls, system) leave `summary` null. The previous shape
// dropped every row with an empty summary, which silently skipped
// sessions where the LLM call that produced summaries had failed or
// when the user prompt was a tool-only command with no text body.
// The permissive path:
//   1. SQL filter no longer rejects empty-summary rows.
//   2. Each row's prompt text is `summary` first; if summary is empty,
//      we re-run `extractSummary(JSON.parse(payload))` against the
//      stored raw payload as a body fallback.
//   3. After trim, rows whose final prompt is empty are dropped
//      post-fetch so the caller still sees a clean oldest→newest list.
export function readSessionUserPrompts(db, projectKey, sessionId, { limit = 5 } = {}) {
  if (!db || !projectKey || !sessionId) return [];
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT line_no, summary, payload FROM conversation_events
         WHERE project_key = ? AND session_id = ? AND role = 'user'
         ORDER BY line_no DESC LIMIT ?`,
      )
      .all(projectKey, sessionId, limit);
  } catch {
    return [];
  }
  // Reverse so the caller gets oldest → newest (matches the
  // conversation's natural reading order).
  const mapped = rows.reverse().map((r) => {
    const summaryText = (r.summary || '').replace(/\s+/g, ' ').trim();
    if (summaryText) {
      return { line_no: r.line_no, prompt: summaryText, source: 'summary' };
    }
    let payloadText = '';
    try {
      const parsed = JSON.parse(r.payload);
      const extracted = extractSummary(parsed);
      if (typeof extracted === 'string') {
        payloadText = extracted.replace(/\s+/g, ' ').trim();
      }
    } catch {
      /* malformed payload — fall through to empty prompt */
    }
    return { line_no: r.line_no, prompt: payloadText, source: payloadText ? 'payload' : 'empty' };
  });
  return mapped.filter((r) => r.prompt.length > 0);
}

// Build the body of the focus memory. List the last few prompts so
// the next session has the thread to pick up. Trimmed; no secrets
// (saveMemory runs looksLikeSecret, but the body is built from
// already-ingested user prompts so the secret scan applies too).
function buildSessionFocusBody(prompts) {
  const tail = prompts.slice(-SESSION_FOCUS_TAKE_PROMPTS);
  const lines = [
    'Most recent user requests in this session (oldest → newest):',
    ...tail.map((p) => `- ${p.prompt}`),
    '',
    'Pick up from the last item on next session.',
  ];
  return lines.join('\n');
}

// Top-level orchestrator. Caller passes the persist-layer `saveMemory`
// so this module stays free of node:sqlite imports.
//
// Inputs:
//   - db: open SQLite handle for the project DB
//   - projectKey: the project's kimi-memory key
//   - sessionId: the session whose events to summarise
//   - injections for tests:
//       saveMemory (required)
//       now (defaults to () => new Date())
//       isDisabled (env-driven; defaults to
//                   KIMI_MEMORY_DISABLE_SESSION_FOCUS === '1')
//       minPrompts (default SESSION_FOCUS_MIN_PROMPTS)
//
// Returns:
//   { skipped: string | null, written: 0|1, updated: 0|1,
//     reason: string, id?, title? }
export async function captureSessionFocus({
  db,
  projectKey,
  sessionId,
  saveMemory,
  now = () => new Date(),
  isDisabled = () => process.env.KIMI_MEMORY_DISABLE_SESSION_FOCUS === '1',
  minPrompts = SESSION_FOCUS_MIN_PROMPTS,
}) {
  if (!db || !projectKey || !sessionId) {
    return {
      skipped: 'missing_inputs',
      written: 0,
      updated: 0,
      reason: null,
    };
  }
  if (isDisabled()) {
    return { skipped: 'env_opt_out', written: 0, updated: 0, reason: null };
  }
  if (!saveMemory) {
    return { skipped: 'no_persist', written: 0, updated: 0, reason: null };
  }
  const prompts = readSessionUserPrompts(db, projectKey, sessionId, { limit: 5 });
  if (prompts.length < minPrompts) {
    // Two distinct cases used to share `below_threshold`:
    //   (a) zero user prompts in the session at all
    //   (b) user prompts exist but none carry any text body
    // Splitting them keeps the diagnostic line unambiguous for the
    // operator scanning hook logs.
    const rawCount = (() => {
      try {
        return db
          .prepare(
            `SELECT COUNT(*) AS n FROM conversation_events
             WHERE project_key = ? AND session_id = ? AND role = 'user'`,
          )
          .get(projectKey, sessionId).n;
      } catch {
        return 0;
      }
    })();
    return {
      skipped: rawCount > 0 ? 'no_user_prompt_text' : 'below_threshold',
      written: 0,
      updated: 0,
      reason:
        rawCount > 0
          ? `prompts_with_text=${prompts.length} raw_user_events=${rawCount}`
          : `prompts=${prompts.length} min=${minPrompts}`,
    };
  }
  const title = sessionFocusTitle(prompts[prompts.length - 1].prompt);
  const content = buildSessionFocusBody(prompts);
  const ttlMs = SESSION_FOCUS_TTL_DAYS * 24 * 3600 * 1000;
  const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
  let saved;
  try {
    saved = saveMemory(db, projectKey, {
      type: 'working',
      title,
      content,
      tags: ['focus', SESSION_FOCUS_TAG, 'in-flight'],
      // Metadata stamp: buildSessionThread (and readLatestSessionFocus)
      // filter on `instr(metadata, '"session_focus":true') > 0` instead
      // of `tags LIKE '%session-focus%'`, so the tag predicate stops
      // being a full scan over working rows. The flag is set once at
      // capture time. (Audit finding F-009.)
      metadata: {
        session_focus: true,
        session_id: sessionId,
      },
      // Top-level session_id column: buildSessionThread uses this to
      // match a focus row to its session without falling back to
      // `is_session_focus = 1` (which would surface the project's
      // most-recent focus for every historical session). Without
      // this, `[thread: N/3]` lines echoed the same title for every
      // session in the project. (Audit fix.)
      session_id: sessionId,
      confidence: 0.7,
      priority: 1,
      expires_at: expiresAt,
      supersede: true,
      provenance: {
        source: 'session_focus_auto',
        session_id: sessionId,
        cwd: null,
        recorded_at: nowIso(),
      },
    });
  } catch (e) {
    return {
      skipped: 'save_failed',
      written: 0,
      updated: 0,
      reason: (e && e.message) || String(e),
    };
  }
  return {
    skipped: null,
    written: 1,
    updated: saved && saved.supersedes ? 1 : 0,
    reason: `prompts=${prompts.length}`,
    id: (saved && saved.id) || null,
    title,
  };
}

// Re-exportable for tests + observability: latest result per project.
// The hook runner reads it to surface extract/focus stats in the next
// UserPromptSubmit status line.
const _lastResultByKey = new Map();

export function recordSessionFocusResult(projectKey, result) {
  if (!projectKey) return;
  _lastResultByKey.set(projectKey, { at: Date.now(), result });
}

export function takeLastSessionFocusResult(projectKey) {
  if (!projectKey) return null;
  const v = _lastResultByKey.get(projectKey);
  return v || null;
}

export function _resetSessionFocusRegistryForTests() {
  _lastResultByKey.clear();
}

// Query the most recent active `working` memory carrying the
// `session-focus` tag. Returns null when none exists or any error
// fires. Used by SessionStart / UserPromptSubmit to surface the
// "where we left off" line.
export function readLatestSessionFocus(db, projectKey) {
  if (!db || !projectKey) return null;
  try {
    // Query by the dedicated is_session_focus column (v12) so the
    // lookup rides idx_memories_session_focus instead of evaluating
    // a function predicate against every working row. The metadata
    // flag is kept as the source of truth that saveMemory reads;
    // the column is a denormalised index-friendly mirror of it.
    // (Audit flag — session-focus indexability.)
    const row = db
      .prepare(
        `SELECT id, type, title, content, tags, updated_at
         FROM memories
         WHERE project_key = ?
           AND status = 'active'
           AND type = 'working'
           AND is_session_focus = 1
           AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
         ORDER BY datetime(updated_at) DESC, priority DESC
         LIMIT 1`,
      )
      .get(projectKey);
    if (!row) return null;
    let tags = [];
    try {
      tags = JSON.parse(row.tags || '[]');
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      type: row.type,
      title: row.title || '',
      content: row.content || '',
      tags,
      updated_at: row.updated_at,
    };
  } catch {
    return null;
  }
}

// Build the one-line `[focus] "<title>" — <body snippet>` preview that
// SessionStart / UserPromptSubmit emit on stdout. Returns null when
// there is no focus to surface, so the caller can omit the line.
export function buildSessionFocusLine(focus, { snippetChars = 120 } = {}) {
  if (!focus || !focus.title) return null;
  const t = focus.title.length > 80 ? sliceCodePointSafe(focus.title, 80) + '…' : focus.title;
  // First non-empty line of the body, condensed.
  const first = (focus.content || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0);
  const snippet = first
    ? first.length > snippetChars
      ? sliceCodePointSafe(first, snippetChars) + '…'
      : first
    : '';
  const tail = snippet ? ` — ${snippet}` : '';
  return `[focus] "${t}" (${focus.type})${tail}`;
}

// Short status-line segment. Mirrors the format used by extract and
// work-log so the user can grep for `focus=` / `extract=` / `work_log=`
// uniformly. Returns 'none' when no result was recorded yet (so the
// segment is never empty on the status line).
export function formatFocusSegment(focus) {
  if (!focus) return 'none';
  if (focus.skipped) return `skip:${focus.skipped}`;
  if (focus.written && focus.written > 0) {
    return focus.updated ? 'updated' : 'saved';
  }
  return 'none';
}
