// Shared hook runner. One Node script consumed by every Kimi hook event
// this plugin declares. The Kimi runtime sets the hook's working
// directory to the plugin root, and exposes KIMI_PLUGIN_ROOT + the
// standard payload on stdin. We always fail open: any error is logged
// to a plugin-owned diagnostics file and the process exits 0.
//
// SessionStart / UserPromptSubmit emit a compact status line plus a
// bounded number of preview lines so the agent can recall context
// without us echoing raw prompts or full memory bodies. Stop /
// SessionEnd / PreCompact / Interrupt / StopFailure stay quiet on
// stdout and run idempotent ingest so the project's session archive
// grows without blocking Kimi's lifecycle.
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { kimiHome, readStdin, safeJsonParse, nowIso, asString, PATH_REGEX } from '../util.js';
import {
  canonicalizeRoot,
  deriveProjectKey,
  ensureProjectDir,
  projectDbPath,
  globalDbPath,
  GLOBAL_PROJECT_KEY,
} from '../project-key.js';
import {
  openDb,
  closeDb,
  saveMemory,
  listMemories,
  searchMemories,
  listWorkingMemory,
  getWorkingMemory,
  listConversations,
  memoryCounts,
  loadIngestState,
  saveIngestState,
  recordConversationEvent,
  updateConversationProgress,
  upsertConversation,
  decayMemories,
  recordProjectPath,
  detectReclone,
  reinforceIfStale,
  linkMemory,
  mergeMemory,
} from '../persist.js';
import { locateSessionArchive, walkWire, readSessionIndex } from '../wire.js';
import { runAutoExtract } from '../extract.js';
import { maybeWriteWorkLog, recordWorkLogResult } from '../work-log.js';
import {
  captureSessionFocus,
  recordSessionFocusResult,
  readLatestSessionFocus,
  buildSessionFocusLine,
  formatFocusSegment,
} from '../session-focus.js';
import { matchAdvisor, logAdvisorDiag } from '../advisor/detect.js';
import { runConsolidate } from '../consolidate.js';
import { runAutoGc } from '../auto-gc.js';
import { runToolRecall, formatToolRecallLines } from './tool-recall.js';
import { logHookDiag } from '../diagnostics.js';

const EVENT = asString(process.env.KM_HOOK_EVENT) || 'unknown';
const HOME = kimiHome();

// Safety caps. Previews are bounded because the SessionStart payload is
// forwarded to model context; we never want a runaway payload.
const STATUS_RECENT_MEMORIES = 4;
const STATUS_RECENT_WM_SLOTS = 5;
const STATUS_RECENT_GLOBAL = 4;
const PROMPT_RECALL_LIMIT = 4;
const PROMPT_TOKEN_LIMIT = 6;

// Field names Kimi has used across versions for the project's working
// directory in hook payloads. Keep them in one place so payloadProjectRoot
// stays the single point that knows about historical renames.
const PAYLOAD_CWD_KEYS = [
  'cwd',
  'workdir',
  'workDir',
  'project_root',
  'projectRoot',
  'workspace',
  'cwd_path',
];
const PAYLOAD_SESSION_KEYS = ['session_id', 'sessionId', 'session', 'id'];
const PAYLOAD_PROMPT_KEYS = ['prompt', 'user_prompt', 'text', 'input'];

// Diagnostics route through the shared `diagnostics.js` logger so
// every hook entry lands in the same `<kimiHome>/kimi-memory/_diagnostics/hooks.log`
// the `memory_diagnostics` MCP tool reads. The previous implementation
// wrote a parallel log into `<pluginRoot>/_diagnostics/hooks.log` that
// the user-facing MCP surface could not see. (Audit SG-4.)
async function logDiag(level, message, extra) {
  await logHookDiag(EVENT, level, message, extra || {}).catch(() => {});
  if (level === 'error') {
    try {
      process.stderr.write('[kimi-memory:hook:' + EVENT + '] ' + message + '\n');
    } catch {
      /* ignore */
    }
  }
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function payloadProjectRoot(payload) {
  if (!isPlainObject(payload)) return null;
  // PAYLOAD_CWD_KEYS lists every field name Kimi has shipped for the
  // project's working directory across hook-payload versions. Keep
  // it in sync with the table above.
  for (const key of PAYLOAD_CWD_KEYS) {
    const r = canonicalizeRoot(payload[key]);
    if (r) return r;
  }
  return null;
}

function payloadSessionId(payload) {
  if (!isPlainObject(payload)) return null;
  for (const key of PAYLOAD_SESSION_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function payloadPrompt(payload) {
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
function safeOpenDb(dbPath) {
  try {
    if (!existsSync(dbPath)) return null;
    return openDb(dbPath);
  } catch {
    return null;
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Pick the first non-empty line of a memory body and squeeze it onto
// one line so it can ride on the bounded [recall: i/N] line. Newlines
// are collapsed to single spaces; tabs and runs of spaces become one
// space. The result is trimmed. Returns '' for empty / missing bodies
// so the caller can omit the trailing " — …" when there is nothing
// useful to quote.
function firstContentLine(content) {
  if (typeof content !== 'string' || !content) return '';
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0);
  if (!first) return '';
  return first.length > 120 ? first.slice(0, 120) + '…' : first;
}

// Used by the brief summary lines. We deliberately do NOT emit the
// per-memory content in stdout — the agent can pull full content via
// `memory_recall` if it needs it, and the chat stays uncluttered.
// Irregular plurals are passed explicitly; everything else takes the
// default "s" suffix.
function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural || singular + 's'}`;
}

function derivePromptTokens(prompt) {
  if (!prompt) return [];
  const tokens = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 32);
  return tokens.slice(0, PROMPT_TOKEN_LIMIT);
}

// Build the composite recall query for a UserPromptSubmit. The
// legacy behaviour used prompt tokens only; the v9 "brain" model
// adds three more sources so recall picks up cues the prompt alone
// would miss:
//
//   1. Prompt tokens (the user's literal words).
//   2. Working-memory slot values (what's "live" right now).
//   3. Last session-focus title (what we were just doing).
//   4. Recent file paths from tool-call events (what files we
//      touched recently — a strong cue for path-tagged memories).
//
// Tokens are de-duplicated case-insensitively. The result is a single
// space-joined string that the existing searchMemories() consumes as
// if it were a normal query; we do NOT add quotes around the joined
// string because the underlying search already tokenises and quotes
// each token individually (see persist.js#searchMemories).
function buildRecallQuery({ prompt, workingSlots, focusRow, recentFiles }) {
  const seen = new Set();
  const push = (text) => {
    if (!text) return;
    for (const t of derivePromptTokens(text)) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(t);
    }
  };
  const tokens = [];
  push(prompt);
  if (Array.isArray(workingSlots)) {
    for (const slot of workingSlots) {
      push(slot && slot.value);
    }
  }
  if (focusRow && focusRow.title) push(focusRow.title);
  if (Array.isArray(recentFiles)) {
    for (const p of recentFiles) push(p);
  }
  // Cap at 24 to keep the FTS MATCH expression bounded. The
  // underlying searchMemories() also caps at 16 — any further tokens
  // are silently dropped.
  return tokens.slice(0, 24).join(' ');
}

// Pull the last N distinct file paths from conversation_events of
// kind='tool_call'. Used to bias the recall query toward path-tagged
// memories when the agent is editing files.
//
// Cheap; reads at most LIMIT rows from the index on
// (session_id, project_key, role). Returns basenames + their parent
// directory tokens so path-based memories (e.g. "src/hooks/run.js
// should never...") match.
function readRecentFilePaths(projectDb, projectKey, { limit = 5 } = {}) {
  if (!projectDb) return [];
  // (Audit finding F-011 / B3-7.)
  const TOOL_PAYLOAD_LIMIT = 64 * 1024;
  const MAX_PATHS_PER_ROW = 16;
  let rows;
  try {
    // Bound the projected payload in SQL, not after materialisation,
    // so a multi-MB tool_call blob never enters Node memory in full.
    // (Audit finding F-006.)
    rows = projectDb
      .prepare(
        `SELECT substr(payload, 1, ?) AS payload
         FROM conversation_events
         WHERE project_key = ? AND kind = 'tool_call'
         ORDER BY line_no DESC LIMIT ?`,
      )
      .all(TOOL_PAYLOAD_LIMIT, projectKey, limit);
  } catch {
    return [];
  }
  // Bound the JSON.parse + path-match cost: large tool-call payloads
  // (heredocs, big file blobs, …) ship multi-MB strings into this
  // hook on every UserPromptSubmit. Cap the parse and the regex
  // match to a per-row ceiling, and skip rows that exceed it.
  const out = [];
  const seen = new Set();
  const pathRegex = PATH_REGEX;
  for (const r of rows) {
    if (!r.payload) continue;
    let text = r.payload;
    if (text.length > TOOL_PAYLOAD_LIMIT) {
      // Truncate to the head; cheaper than skipping outright.
      text = text.slice(0, TOOL_PAYLOAD_LIMIT);
    }
    if (text.length > 0 && text[0] === '{') {
      try {
        const parsed = JSON.parse(text);
        text = JSON.stringify(parsed);
      } catch {
        /* keep raw text */
      }
    }
    const matches = (text.match(pathRegex) || []).slice(0, MAX_PATHS_PER_ROW);
    for (const m of matches) {
      // Normalise: collapse Windows backslashes for the tokeniser.
      const norm = m.replace(/\\/g, '/').toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(m.replace(/\\/g, '/'));
      // Add the basename + parent dir as separate tokens so a memory
      // tagged with the file name or its folder also matches.
      const parts = m.replace(/\\/g, '/').split('/').filter(Boolean);
      const tail = parts.slice(-2).join('/');
      if (tail && !seen.has(tail.toLowerCase())) {
        seen.add(tail.toLowerCase());
        out.push(tail);
      }
      if (out.length >= limit * 2) break;
    }
    if (out.length >= limit * 2) break;
  }
  return out;
}

// Round-robin diversify a hit list so the top 3 the user sees spans
// multiple memory types. Without this a single high-confidence row
// can crowd out the rest; with it, the agent sees a mix of
// conventions, procedures, working notes, and conclusions.
//
// `hits` is an array of memory objects with at least { id, type,
// score }. Returns a new array of up to `topN` items, picking the
// highest-scoring row of each type in turn. Order within a type is
// preserved; ties broken by score desc.
function diversifyHitsByType(hits, { topN = 3 } = {}) {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const byType = new Map();
  for (const h of hits) {
    const t = h.type || 'unknown';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(h);
  }
  for (const arr of byType.values()) {
    arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  const picks = [];
  const types = [...byType.keys()];
  let i = 0;
  while (picks.length < topN && i < 64) {
    let added = false;
    for (const t of types) {
      if (picks.length >= topN) break;
      const arr = byType.get(t);
      if (!arr || arr.length === 0) continue;
      const next = arr.shift();
      if (next) {
        picks.push(next);
        added = true;
      }
    }
    if (!added) break;
    i += 1;
  }
  return picks;
}

// Format the consolidation result for the status line. Mirrors the
// extract / focus segment shape: terse, never empty.
function formatConsolidateSegment(consolidate) {
  if (!consolidate) return 'none';
  if (consolidate.saved && consolidate.saved > 0) {
    const merged = consolidate.merged ? `/merged:${consolidate.merged}` : '';
    return `saved:${consolidate.saved}/skipped:${consolidate.skipped || 0}${merged}`;
  }
  if (consolidate.clusters && consolidate.clusters > 0) {
    return `kept:0/of:${consolidate.clusters}`;
  }
  if (consolidate.skipped) return `skip:${consolidate.skipped}`;
  if (consolidate.error) return `err:${consolidate.error}`;
  return 'none';
}

// Format the auto-GC segment for the status line. The shape mirrors
// the consolidate segment: a short token string the user can read at
// a glance. When the heavy passes are throttled, the segment reads
// "heavy:throttled" so the user knows the pipeline is running but
// skipped on this open. Errors are surfaced as `err:…`.
function formatAutoGcSegment(autoGc) {
  if (!autoGc) return 'none';
  if (autoGc.error) return `err:${autoGc.error}`;
  const prune = autoGc.prune || {};
  const archive = autoGc.archive || {};
  const tier = autoGc.tier || {};
  const pruned =
    (prune.pruned_deleted || 0) +
    (prune.pruned_superseded || 0) +
    (prune.pruned_embed_failed || 0) +
    (prune.pruned_cold || 0) +
    (prune.pruned_orphans || 0);
  const archived =
    (archive.archived_conversation_events || 0) +
    (archive.archived_skill_invocations || 0) +
    (archive.archived_persona_promotions || 0);
  const promoted =
    (tier.promoted_l0_to_l1 || 0) + (tier.promoted_l1_to_l2 || 0) + (tier.promoted_l2_to_l3 || 0);
  const demoted = tier.demoted_to_l0 || 0;
  if (prune.skipped === 'throttled' && archive.skipped === 'throttled') {
    return `tier:prom:${promoted}/dem:${demoted}/heavy:throttled`;
  }
  if (pruned === 0 && archived === 0 && promoted === 0 && demoted === 0) {
    return 'none';
  }
  return `prune:${pruned}/archive:${archived}/tier:prom:${promoted}/dem:${demoted}`;
}

// Build a "[thread]" line listing the last few distinct sessions
// for the project. Each entry shows the session's session-focus
// title (if any) and a snippet of its body so the agent sees the
// project's narrative timeline without an explicit query.
//
// Returns null when the project has fewer than 2 sessions on file
// (a one-session project has no "thread" to surface — that's a
// single focus line, which is already emitted).
//
// Output shape:
//   [thread] (3 sessions, oldest → newest)
//   [thread: 1/3] "<title>" — <snippet>
//   [thread: 2/3] ...
//   [thread: 3/3] ...
//
// Bounded to MAX_THREAD_SESSIONS so the status block stays short.
const MAX_THREAD_SESSIONS = 3;

function buildSessionThread(projectDb, projectKey) {
  if (!projectDb) return null;
  let conversations;
  try {
    conversations = listConversations(projectDb, projectKey, { limit: MAX_THREAD_SESSIONS });
  } catch {
    return null;
  }
  if (!conversations || conversations.length < 2) return null;

  const lines = [];
  // conversations is ordered newest → newest by listConversations;
  // reverse so the thread reads oldest → newest.
  const ordered = [...conversations].reverse();
  lines.push(`[thread] (${ordered.length} sessions, oldest → newest)`);
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    let focus = null;
    try {
      // v12 + session_focus column: match this session's focus row by
      // the top-level `session_id` column (which captureSessionFocus
      // now writes), and fall back to the most-recent focus via the
      // `is_session_focus` column for older projects whose capture
      // predates the column write. The OR was the previous shape; an
      // AND would lock older rows out of the fallback path entirely.
      focus = projectDb
        .prepare(
          `SELECT id, title, content, session_id, is_session_focus FROM memories
           WHERE project_key = ? AND status = 'active' AND type = 'working'
             AND is_session_focus = 1 AND (session_id = ? OR session_id IS NULL)
           ORDER BY (session_id = ?) DESC, datetime(updated_at) DESC LIMIT 1`,
        )
        .get(projectKey, c.session_id, c.session_id);
    } catch {
      /* ignore — fall back to the title only */
    }
    const title = (focus && focus.title) || `Session ${i + 1}`;
    const snippet = firstContentLine((focus && focus.content) || '');
    const tail = snippet ? ` — ${snippet}` : '';
    lines.push(`[thread: ${i + 1}/${ordered.length}] "${truncate(title, 80)}"${tail}`);
  }
  return lines;
}

function formatIngestSegment(ingest) {
  if (!ingest) return 'none';
  if (ingest.ingested && ingest.ingested > 0) return `ok:${ingest.ingested}`;
  if (ingest.skipped) return `skip:${ingest.skipped}`;
  if (ingest.archive_not_found) return `skip:archive_not_found`;
  if (ingest.ok) return 'ok:0';
  return 'skipped';
}

// Format the auto-extract result for the status line. Keeps it terse —
// the agent gets the same shape from `memory_recall` if it wants
// details. Distinguishes "LLM had no candidates" (clean skip) from
// "LLM returned candidates but we kept N / dropped M / scrubbed K".
function formatExtractSegment(extract) {
  if (!extract) return 'none';
  if (extract.saved && extract.saved > 0)
    return `saved:${extract.saved}/dup:${extract.duplicates || 0}${
      extract.secrets_dropped ? `/sec:${extract.secrets_dropped}` : ''
    }`;
  if (extract.extracted && extract.extracted > 0)
    return `kept:0/dup:${extract.duplicates || 0}/of:${extract.extracted}`;
  if (extract.skipped) return `skip:${extract.skipped}`;
  if (extract.error) return `err:${extract.error}`;
  return 'none';
}

// Format the work-log result for the status line. Same terseness rule
// as extract — full report goes to `logDiag`.
function formatWorkLogSegment(wl) {
  if (!wl) return 'none';
  if (wl.written && wl.written > 0) {
    return wl.updated ? 'updated' : 'saved';
  }
  if (wl.skipped) return `skip:${wl.skipped}`;
  return 'none';
}

// ---- Snapshot builders ----

function buildCounts({ projectDb, globalDb, key }) {
  const project = projectDb ? memoryCounts(projectDb, key) : zeroCounts();
  const global = globalDb ? memoryCounts(globalDb, GLOBAL_PROJECT_KEY) : zeroCounts();
  const wm = projectDb ? listWorkingMemory(projectDb, key) : [];
  const conv = projectDb
    ? projectDb.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_key=?').get(key).n
    : 0;
  const events = projectDb
    ? projectDb
        .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
        .get(key).n
    : 0;
  return { project, global, wm, conv, events };
}

function zeroCounts() {
  return {
    total: 0,
    active: 0,
    retained: 0,
    expired: 0,
    superseded: 0,
    deleted: 0,
    by_type: {},
    by_status: {},
    latest_update_at: null,
  };
}

function buildStatusLine({
  event,
  key,
  cwd,
  counts,
  ingest,
  recall,
  extract,
  workLog,
  focus,
  consolidate,
  autoGc,
}) {
  const ingestSeg = formatIngestSegment(ingest);
  const recallSeg = recall ? ` recall project:${recall.project} global:${recall.global}` : '';
  // Extract + work-log + focus + consolidate are surfaced only when
  // set, so the line stays short for callers that don't plumb them
  // through. Consolidate segment rides next to extract because they
  // share the "memory was touched" semantics.
  const extractSeg = extract ? ` extract=${formatExtractSegment(extract)}` : '';
  const workLogSeg = workLog ? ` work_log=${formatWorkLogSegment(workLog)}` : '';
  const focusSeg = focus ? ` focus=${formatFocusSegment(focus)}` : '';
  const consolidateSeg = consolidate ? ` consolidate=${formatConsolidateSegment(consolidate)}` : '';
  const autoGcSeg = autoGc ? ` auto_gc=${formatAutoGcSegment(autoGc)}` : '';
  return [
    `[kimi-memory] event=${event}`,
    `project_key=${key}`,
    `pmem.active=${counts.project.active}`,
    `gmem.active=${counts.global.active}`,
    `wm=${counts.wm.length}`,
    `conv=${counts.conv}`,
    `events=${counts.events}`,
    `ingest=${ingestSeg}${extractSeg}${workLogSeg}${focusSeg}${consolidateSeg}${autoGcSeg}${recallSeg}`,
    `cwd=${cwd}`,
  ].join(' ');
}

function buildRecentSummary(projectDb, globalDb, key) {
  const projectRecent = projectDb
    ? listMemories(projectDb, key, { limit: STATUS_RECENT_MEMORIES })
    : [];
  const globalRecent = globalDb
    ? listMemories(globalDb, GLOBAL_PROJECT_KEY, { limit: STATUS_RECENT_GLOBAL })
    : [];
  const total = projectRecent.length + globalRecent.length;
  if (total === 0) return 'No recent memories.';
  const parts = [];
  if (projectRecent.length) parts.push(`${projectRecent.length} project`);
  if (globalRecent.length) parts.push(`${globalRecent.length} global`);
  return `Loaded ${pluralize(total, 'recent memory', 'recent memories')}. (${parts.join(', ')}.)`;
}

function buildWorkingMemoryPreview(projectDb, key) {
  if (!projectDb) return [];
  const slots = listWorkingMemory(projectDb, key).slice(0, STATUS_RECENT_WM_SLOTS);
  return slots.map((s) => `- WM ${s.slot}: ${truncate(s.value, 200)}`);
}

// Re-clone detection: if the canonical project root was created after
// kimi-memory first stamped the per-project DB, the memories, working
// memory, and session archive belong to a previous incarnation of the
// repo. Surface a one-line warning so the user knows to call
// memory_reset_project before working on the new project.
//
// Returns null when the project is healthy, or a `[stale-memory]`
// status line otherwise. Best-effort: any error inside detectReclone
// is swallowed and treated as "no warning" so the hook never blocks
// the agent's turn.
function buildStaleMemoryLine(projectDb, key, cwd) {
  if (!projectDb || !key || !cwd) return null;
  let r;
  try {
    r = detectReclone(projectDb, key, cwd);
  } catch {
    return null;
  }
  if (!r || !r.isReclone) return null;
  return (
    `[stale-memory] ${cwd} appears to have been re-cloned after kimi-memory first saw it. ` +
    `Per-project memory (memories, working memory, session archive) belongs to the previous incarnation. ` +
    `Call memory_reset_project (with confirm=true) to start clean, or memory_status to see what's on file. ` +
    `(reason: ${r.reason || 'directory birthtime is newer than first_seen_at'})`
  );
}

async function buildRecallSummary({ projectDb, globalDb, key, prompt }) {
  // v9: composite query built from prompt + working-memory slots +
  // session-focus + recent file paths. Each source independently may
  // be empty; the search still runs as long as any token survives
  // tokenisation. We still respect the legacy behaviour of "no
  // tokens → no recall" so a degenerate prompt (emoji only, control
  // chars, etc.) does not spam the agent.
  const workingSlots = projectDb ? listWorkingMemory(projectDb, key) : [];
  const focusRow = projectDb ? readLatestSessionFocus(projectDb, key) : null;
  const recentFiles = readRecentFilePaths(projectDb, key, { limit: 5 });
  const query = buildRecallQuery({ prompt, workingSlots, focusRow, recentFiles });
  if (!query || !query.trim()) {
    return {
      summary: null,
      projectHits: [],
      globalHits: [],
      recallLines: [],
      perTypeCounts: {},
      query: '',
    };
  }
  // Use perType + includeScore: the hook should surface a balanced
  // selection across memory types (so the agent sees conventions AND
  // procedures AND working notes, not five rows of the same type),
  // and the scores feed the "[recall: i/N]" title lines the user
  // sees below. PROMPT_RECALL_LIMIT is the per-scope cap; we cast a
  // wider net here than the legacy implementation so the diversifier
  // has room to pick from.
  const RECALL_CANDIDATE_LIMIT = 8;
  const projectHits = projectDb
    ? await searchMemories(projectDb, key, query, {
        limit: RECALL_CANDIDATE_LIMIT,
        perType: true,
        includeScore: true,
      })
    : [];
  const globalHits = globalDb
    ? await searchMemories(globalDb, GLOBAL_PROJECT_KEY, query, {
        limit: RECALL_CANDIDATE_LIMIT,
        perType: true,
        includeScore: true,
      })
    : [];
  const allHits = [...projectHits, ...globalHits];
  const total = allHits.length;

  // Per-type breakdown across both scopes. The agent uses this to
  // describe the recall in its reply ("I found 2 conventions and a
  // procedure …"); the human reads the same line on the hook status.
  const perTypeCounts = {};
  for (const m of allHits) perTypeCounts[m.type] = (perTypeCounts[m.type] || 0) + 1;

  let summary;
  if (total === 0) {
    summary = 'No recall hits.';
  } else {
    const parts = [];
    if (projectHits.length) parts.push(`${projectHits.length} project`);
    if (globalHits.length) parts.push(`${globalHits.length} global`);
    const typeParts = Object.entries(perTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}: ${n}`);
    const typeStr = typeParts.length ? ` [${typeParts.join(', ')}]` : '';
    summary =
      `Recalled ${pluralize(total, 'memory', 'memories')}. (${parts.join(', ')}.) ${typeStr}`.trim();
  }

  // Diversify the top 3 across types so the user doesn't see the
  // same row thrice. The diversifier preserves the per-scope ratio
  // (project first, global second) when types tie.
  const projectIdSet = new Set(projectHits.map((m) => m.id));
  const orderedForDiversify = [
    ...projectHits.sort((a, b) => (b.score || 0) - (a.score || 0)),
    ...globalHits.sort((a, b) => (b.score || 0) - (a.score || 0)),
  ];
  const topHits = diversifyHitsByType(orderedForDiversify, { topN: 3 });
  const recallLines = [];
  for (let i = 0; i < topHits.length; i++) {
    const m = topHits[i];
    const scope = projectIdSet.has(m.id) ? 'project' : 'global';
    const raw = (m.title || '').trim() || (m.content || '').slice(0, 80);
    const truncated = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
    const score = m.score != null ? `, score=${m.score.toFixed(2)}` : '';
    const snippet = firstContentLine(m.content);
    const tail = snippet ? ` — ${snippet}` : '';
    recallLines.push(
      `[recall: ${i + 1}/${total}] "${truncated}" (${m.type}, ${scope}${score})${tail}`,
    );
  }

  // Auto-reinforce the top *project* hit (only project — global rows
  // are cross-user and the hook should not bump them). reinforceIfStale
  // debounces within 60s so re-typing the same prompt doesn't hammer
  // the DB. Best-effort; failures are swallowed.
  if (projectDb && topHits.length > 0) {
    const top = topHits[0];
    if (top && top.id && projectIdSet.has(top.id)) {
      try {
        reinforceIfStale(projectDb, key, top.id);
      } catch {
        /* swallow — the recall surfaced fine even if reinforce failed */
      }
    }
  }

  // Annotate topHits with scope + snippet so the caller can build
  // the AI-facing context without re-deriving either. Keeps the
  // user-facing line format (recallLines) and the AI-facing format
  // (additionalContext) using the same source of truth.
  const annotatedTopHits = topHits.map((m) => ({
    id: m.id,
    type: m.type,
    title: (m.title || '').trim() || (m.content || '').slice(0, 80),
    snippet: firstContentLine(m.content),
    score: m.score,
    scope: projectIdSet.has(m.id) ? 'project' : 'global',
  }));

  return {
    summary,
    projectHits,
    globalHits,
    recallLines,
    perTypeCounts,
    query,
    topHits: annotatedTopHits,
  };
}

// Build the AI-facing recall context. The hook emits this as
// `hookSpecificOutput.additionalContext` so the model sees a
// structured summary of what was retrieved on its behalf. Without
// this, recall happens behind the model's back and it has no way
// to know "I recall X" — the user sees the recall lines but the
// model's reply never acknowledges them.
//
// Returns null when there are no hits, so the caller can skip the
// `additionalContext` field entirely (no "no recall hits" spam on
// every turn).
//
// Format choice: numbered list with (type, scope, score) per row,
// followed by a one-line permission to cite. The model is told
// explicitly that a memory may be wrong, so it can speak up if
// recall is stale or off-topic.
function buildRecallContextLines(recall, topHits) {
  if (!topHits || topHits.length === 0) return null;
  const total = recall.projectHits.length + recall.globalHits.length;
  const lines = [];
  lines.push(
    `[kimi-memory recall] ${total} memories surfaced — briefly acknowledge what you remember when relevant. If a memory is wrong or stale, say so and we can update it.`,
  );
  for (let i = 0; i < topHits.length; i++) {
    const m = topHits[i];
    const score = m.score != null ? `, score=${m.score.toFixed(2)}` : '';
    const tail = m.snippet ? ` — ${m.snippet}` : '';
    lines.push(`${i + 1}. (${m.type}, ${m.scope}${score}) "${m.title}"${tail}`);
  }
  return lines.join('\n');
}

// Throttle window for heavy auto-GC passes (prune + archive). The
// tier-promotion step is cheap (a few prepared statements) and runs
// every SessionStart; the prune + archive steps touch more rows and
// only run once per AUTO_GC_THROTTLE_HOURS hours per project.
const AUTO_GC_THROTTLE_HOURS = 6;

// Run auto-GC, with the heavy passes (prune + archive) gated on a
// per-project timestamp stored in schema_meta. Tier promotion
// (cheap) runs every open. The timestamp is round-tripped through
// the same DB so a project that has never been GC'd runs on its
// first open.
function runAutoGcThrottled(db, projectKey) {
  if (!db || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_AUTO_GC === 'off') {
    return { skipped: 'env_opt_out' };
  }

  const now = new Date();
  // Tier promotion is cheap; always run it.
  const tier = runAutoTier(db, projectKey, { now });

  // Prune + archive are throttled. The previous shape read the
  // last-run timestamp, decided whether to skip, ran the pass,
  // and stamped the timestamp in three separate statements — two
  // SessionStart invocations running concurrently (e.g. one from
  // the hook, one from MCP) could both read a stale stamp, both
  // decide to run, and double-stamp. The prune pass is mostly
  // idempotent, but the wasted CPU on a 5k-row project was the
  // visible symptom. (Audit fix L3.)
  //
  // The fix wraps the read + the bypass check + the run + the
  // stamp in a single `BEGIN IMMEDIATE` transaction so the second
  // caller blocks until the first commits, then reads a fresh
  // stamp and observes the throttle. node:sqlite routes
  // `BEGIN IMMEDIATE` correctly even when the call site is also
  // holding a `BEGIN` (e.g. from `runAutoTier`'s outer tx); the
  // inner BEGIN collapses to a no-op savepoint.
  let prune = null;
  let archive = null;
  try {
    db.exec('BEGIN IMMEDIATE');
    let lastRun = null;
    try {
      const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('auto_gc_last_run');
      if (row && row.value) {
        const t = Date.parse(row.value);
        if (Number.isFinite(t)) lastRun = new Date(t);
      }
    } catch {
      /* missing — first run */
    }
    const throttleMs = AUTO_GC_THROTTLE_HOURS * 60 * 60 * 1000;
    const isThrottled = lastRun && now - lastRun < throttleMs;
    if (isThrottled) {
      prune = { skipped: 'throttled' };
      archive = { skipped: 'throttled' };
    } else {
      try {
        const r = runAutoGc(db, projectKey, { now });
        prune = r.prune || { skipped: 'no_db' };
        archive = r.archive || { skipped: 'no_db' };
        // Stamp the last-run time inside the same transaction so the
        // next reader observes the update.
        db.prepare(
          `INSERT INTO schema_meta (key, value) VALUES ('auto_gc_last_run', ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        ).run(new Date().toISOString());
      } catch (e) {
        prune = { error: e && e.message ? e.message : String(e) };
        archive = { error: e && e.message ? e.message : String(e) };
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    prune = { error: e && e.message ? e.message : String(e) };
    archive = { error: e && e.message ? e.message : String(e) };
  }

  return { prune, archive, tier };
}

function emitLines(lines) {
  if (!lines || lines.length === 0) return;
  try {
    process.stdout.write(lines.join('\n') + '\n');
  } catch {
    /* ignore */
  }
}

// ---- Handlers ----

async function handleSessionStart(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) {
    // Surface a bounded skip-line so the user / agent can see why the
    // hook produced nothing — otherwise this is a silent no-op and the
    // harness sees an empty stdout, indistinguishable from "hook ran
    // fine and found nothing to report". (Audit fix.)
    emitLines([`[kimi-memory] event=${EVENT} skipped: no project cwd in payload`]);
    return { ok: false, reason: 'no project cwd in payload' };
  }
  // Opportunistic ingest of any leftover archive from a previous
  // session start mid-archive — usually 0, never blocks the agent.
  const ingest = await safeHandleStop(payload, cwd);
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const projectDbPath = path.join(HOME, 'kimi-memory', key, 'memory.sqlite');
  const globalDbPath2 = path.join(HOME, 'kimi-memory', '_global', 'memory.sqlite');
  const projectDb = safeOpenDb(projectDbPath);
  const globalDb = safeOpenDb(globalDbPath2);
  // Decay pass on the project DB: the only mutating action at
  // SessionStart. Runs once per SessionStart, idempotent (re-running
  // on already-decayed rows is a no-op). Failures are logged but
  // never block the status emit below.
  let decay = null;
  if (projectDb) {
    try {
      decay = decayMemories(projectDb, key);
    } catch (e) {
      decay = { error: e && e.message };
    }
  }
  const counts = buildCounts({ projectDb, globalDb, key });
  const recentSummary = buildRecentSummary(projectDb, globalDb, key);
  const {
    extract: latestExtract,
    workLog: latestWorkLog,
    focus: latestFocus,
  } = await readLatestStats(cwd);
  // v9 consolidation ("dream pass"): cluster related memories and
  // synthesise a conclusion row per cluster. Cheap (no LLM); the
  // embedding model is already loaded for recall. Idempotent — a
  // re-run on a project with existing conclusions is a no-op via the
  // memory_synthesizes coverage check.
  //
  // When the cluster is tight enough (cosine ≥ 0.85, tag overlap ≥ 2,
  // ≥ 3 members), the consolidate pass also calls mergeMemory to
  // collapse the siblings into the highest-confidence one. The
  // merged target's content is replaced by the conclusion body; the
  // siblings are soft-superseded (never hard-deleted) so the
  // operator can un-merge by walking the merged_from provenance.
  let consolidate = null;
  if (projectDb) {
    try {
      consolidate = await runConsolidate({
        db: projectDb,
        projectKey: key,
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      if (consolidate && (consolidate.saved || consolidate.skipped || consolidate.merged)) {
        await logDiag('info', 'consolidate result', { key, consolidate });
      }
    } catch (e) {
      consolidate = { error: e && e.message };
    }
  }

  // Auto-GC: prune dead rows, archive old audit tables, and
  // migrate tiers. Throttled by a per-DB timestamp so the heavy
  // passes run at most once per AUTO_GC_THROTTLE_HOURS hours.
  // The decay / consolidate / tier-promotion steps are cheap (a
  // handful of prepared statements) and run every open; the prune
  // + archive steps are throttled.
  let autoGc = null;
  if (projectDb) {
    try {
      autoGc = runAutoGcThrottled(projectDb, key);
      if (autoGc && (autoGc.pruned || autoGc.archived || autoGc.prune || autoGc.archive)) {
        await logDiag('info', 'auto-gc result', { key, autoGc });
      }
    } catch (e) {
      autoGc = { error: e && e.message };
    }
  }
  const lines = [];
  lines.push(
    buildStatusLine({
      event: 'SessionStart',
      key,
      cwd,
      counts,
      ingest,
      extract: latestExtract,
      workLog: latestWorkLog,
      focus: latestFocus,
      consolidate,
      autoGc,
    }),
  );
  lines.push(recentSummary);
  // "Where we left off" — surface the most recent session-focus row
  // so a user who closes kimi-code and reopens can ask the agent to
  // continue without first asking "what were we doing?". Emitted
  // right after the recent summary so it is the most prominent
  // signal the agent sees on a fresh start.
  const focus = readLatestSessionFocus(projectDb, key);
  const focusLine = buildSessionFocusLine(focus);
  if (focusLine) lines.push(focusLine);
  // v9 cross-session thread: list the last few sessions in the
  // project so the agent has a sense of *where* in the project
  // timeline the user is picking up. Emitted after focus so the
  // agent reads the most-recent action first, then the broader
  // context.
  const threadLines = buildSessionThread(projectDb, key);
  if (threadLines) {
    for (const l of threadLines) lines.push(l);
  }
  // Opportunistic recall of project build/stack memories so the agent
  // can see saved project context before it acts.
  if (projectDb) {
    try {
      const recallHits = await searchMemories(
        projectDb,
        key,
        'build command stack dependencies update',
        { limit: 2, perType: true, includeScore: true },
      );
      const topRecall = [...recallHits].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 2);
      for (const m of topRecall) {
        const raw = (m.title || '').trim() || (m.content || '').slice(0, 80);
        const truncated = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
        const snippet = firstContentLine(m.content);
        const tail = snippet ? ` — ${snippet}` : '';
        lines.push(`[recall: project] "${truncated}" (${m.type}, project)${tail}`);
      }
    } catch {
      // recall is best-effort at SessionStart
    }
  }
  const wm = buildWorkingMemoryPreview(projectDb, key);
  for (const l of wm) lines.push(l);
  // Re-clone warning (best-effort). Emitted after the WM preview so the
  // user sees the most relevant signal first; the warning is
  // intentionally a one-liner that names the next action.
  const staleMemoryLine = buildStaleMemoryLine(projectDb, key, cwd);
  if (staleMemoryLine) lines.push(staleMemoryLine);
  emitLines(lines);
  if (decay) await logDiag('info', 'decay pass result', { key, decay });
  return {
    ok: true,
    key,
    counts,
    recent: recentSummary,
    wm: wm.length,
    focus: focusLine ? true : false,
    ingest,
    decay,
    extract: latestExtract,
    workLog: latestWorkLog,
    stale_memory: staleMemoryLine ? true : false,
  };
}

async function handleUserPromptSubmit(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) {
    emitLines([`[kimi-memory] event=${EVENT} skipped: no project cwd in payload`]);
    return { ok: false, reason: 'no project cwd in payload' };
  }
  // Capture the ingest result this time instead of discarding it.
  const ingest = await safeHandleStop(payload, cwd);
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const projectDbPath = path.join(HOME, 'kimi-memory', key, 'memory.sqlite');
  const globalDbPath2 = path.join(HOME, 'kimi-memory', '_global', 'memory.sqlite');
  const projectDb = safeOpenDb(projectDbPath);
  const globalDb = safeOpenDb(globalDbPath2);
  const counts = buildCounts({ projectDb, globalDb, key });
  const prompt = payloadPrompt(payload);
  const recall = await buildRecallSummary({ projectDb, globalDb, key, prompt });
  // Pull the most recent extract + work-log + focus stats so the
  // status line can advertise what the previous Stop hook did. Cheap
  // file read; never throws.
  const {
    extract: latestExtract,
    workLog: latestWorkLog,
    focus: latestFocus,
  } = await readLatestStats(cwd);
  // Advisor keyword detection runs here, in-process, on the same payload
  // the memory recall just used. One matched keyword → one extra stdout
  // line so the agent knows to consider loading skill `advisor`. No-match
  // is silent. Detection is fail-open: any error is logged and ignored.
  let advisorMatch = null;
  try {
    advisorMatch = matchAdvisor(prompt);
  } catch (e) {
    // Fire-and-forget — the call site must not block on the
    // diagnostics pipeline.
    logAdvisorDiag('matchAdvisor threw: ' + (e && e.message)).catch(() => {});
  }
  const lines = [];
  lines.push(
    buildStatusLine({
      event: 'UserPromptSubmit',
      key,
      cwd,
      counts,
      ingest,
      extract: latestExtract,
      workLog: latestWorkLog,
      focus: latestFocus,
      recall: {
        project: recall.projectHits.length,
        global: recall.globalHits.length,
      },
    }),
  );
  if (recall.summary) lines.push(recall.summary);
  // Per-memory previews (the verbose `[recall: i/N] "title" …` lines)
  // are NOT emitted to the human-readable status block anymore. The
  // v9.6+ design routes them through `hookSpecificOutput.additionalContext`
  // (below) so the model sees exactly what was retrieved, but the
  // terminal stays clean. The legacy format was loud and the new
  // format is intentionally terse.
  // "Where we left off" — surface the latest session-focus row so the
  // agent can pick up after a session restart. Always emitted (not
  // gated on keyword recall) because it is the answer to "continue"
  // and "what were we doing" without a query-dependent path.
  const focus = readLatestSessionFocus(projectDb, key);
  const focusLine = buildSessionFocusLine(focus);
  if (focusLine) lines.push(focusLine);
  if (advisorMatch) {
    lines.push(
      `[advisor] matched: "${advisorMatch}" — /advisor or ask naturally; skill \`advisor\` is loaded`,
    );
  }
  const wm = buildWorkingMemoryPreview(projectDb, key);
  for (const l of wm) lines.push(l);
  // Re-clone warning: emitted after the WM preview so the user sees
  // the most relevant signal first. The line names the next action
  // (memory_reset_project with confirm=true) so the user does not
  // have to dig through docs to find the fix.
  const staleMemoryLine = buildStaleMemoryLine(projectDb, key, cwd);
  if (staleMemoryLine) lines.push(staleMemoryLine);
  emitLines(lines);
  // Build the AI-facing recall context. Only injected when there are
  // actual hits — emitting "no recall hits" on every turn trains the
  // model to ignore the signal. The context tells the model what was
  // retrieved AND gives it permission to acknowledge/correct, so
  // "I recall X" stops being a behavior we hope for and starts being
  // a behavior the model is told to do.
  const additionalContext = buildRecallContextLines(recall, recall.topHits);
  // Emit a JSON object the harness can parse. `systemMessage` is the
  // existing human-readable status line stack (harness shows it to the
  // user; emitLines above prints it directly to stdout for clients that
  // don't parse the JSON). `hookSpecificOutput.additionalContext`
  // injects the recall summary into the model's prompt for this turn.
  const output = {
    systemMessage: lines.join('\n'),
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      ...(additionalContext ? { additionalContext } : {}),
    },
  };
  try {
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch {
    /* stdout closed; not fatal */
  }
  return {
    ok: true,
    key,
    counts,
    ingest,
    recall_hits: {
      project: recall.projectHits.length,
      global: recall.globalHits.length,
    },
    recall_lines: recall.recallLines,
    per_type: recall.perTypeCounts,
    focus: focusLine ? true : false,
    advisor: advisorMatch,
    stale_memory: staleMemoryLine ? true : false,
    additional_context: additionalContext,
  };
}

async function handleStop(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) {
    emitLines([`[kimi-memory] event=${EVENT} skipped: no project cwd in payload`]);
    return { ok: false, reason: 'no project cwd in payload' };
  }
  const sessionId = payloadSessionId(payload);
  const ingest = await safeHandleStop(payload, cwd);
  // Auto-extract piggybacks on the ingest pass: the conversation_events
  // table is now up to date, so we can read the last few exchanges and
  // ask the LLM whether anything durable is worth saving. Failures here
  // are non-fatal — we never throw out of the hook.
  let extract = null;
  if (sessionId && ingest && ingest.ok !== false && !ingest.skipped) {
    try {
      extract = await handleAutoExtract(cwd, sessionId);
    } catch (e) {
      extract = { skipped: 'extract_threw', error: e && e.message };
    }
  }
  if (extract) await logDiag('info', 'auto_extract result', { extract });

  // Work-log piggybacks on the same pass: with conversation_events
  // updated, today's activity + commits are deterministic sources for a
  // date-titled episodic memory. Idempotent within the day via
  // supersede=true. Same fail-open contract — never throws out.
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

  // Session-focus piggybacks on the same pass: with conversation_events
  // updated, the most recent user prompts are a deterministic source
  // for a `working`-typed "where we left off" memory. SessionStart
  // and UserPromptSubmit surface the latest focus row, so a user who
  // closes kimi-code and reopens sees the thread of the last session
  // in their first hook status line. Idempotent via supersede=true
  // (same session, same title → replace). Same fail-open contract.
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

  // Persist the latest extract + work-log + focus stats into the
  // per-project ingest-state file so the next UserPromptSubmit (a
  // separate process) can surface them on its status line. We keep
  // just enough to render the segment — full reports still live in
  // the diagnostics log. Best-effort; any failure here is logged,
  // not thrown.
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

  return { ok: true, ingest, extract, workLog, focus };
}

// Read the most recently persisted extract + work-log + session-focus
// stats for this project. Returns nulls for fields that have never
// been written.
async function readLatestStats(cwd) {
  if (!cwd) return { extract: null, workLog: null, focus: null };
  try {
    const key = deriveProjectKey(cwd);
    const state = await loadIngestState(HOME, key);
    return {
      extract: state.latest_extract || null,
      workLog: state.latest_work_log || null,
      focus: state.latest_session_focus || null,
    };
  } catch {
    return { extract: null, workLog: null, focus: null };
  }
}

async function safeHandleStop(payload, cwd) {
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const sessionId = payloadSessionId(payload);
  if (!sessionId) return { ok: true, skipped: 'no_session_id', session_id: null, project_key: key };
  const state = await loadIngestState(HOME, key);
  if (!state.sessions) state.sessions = {};
  const prev = state.sessions[sessionId] || {};
  let wdk = prev.work_dir_key || null;
  if (!wdk) {
    const idx = await readSessionIndex(HOME);
    const hit = idx.find(
      (e) => e && (e.sessionId === sessionId || e.session_id === sessionId || e.id === sessionId),
    );
    if (hit && (hit.work_dir_key || hit.workDirKey)) wdk = hit.work_dir_key || hit.workDirKey;
  }
  const archive = await locateSessionArchive(HOME, wdk, sessionId);
  if (!archive) {
    return {
      ok: true,
      skipped: 'archive_not_found',
      session_id: sessionId,
      work_dir_key: wdk,
      project_key: key,
    };
  }
  const db = openDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  // Stamp the canonical project root so memory_prune (run via the MCP
  // server or /kimi-memory:prune) can later detect orphan project DBs.
  // No-op if `cwd` is missing or non-canonical.
  if (cwd) recordProjectPath(db, key, cwd);
  upsertConversation(db, key, sessionId, cwd);
  const startByte = prev.byte_offset || 0;
  let lineNo = prev.line_count || 0;
  let lastEventAt = prev.last_event_at || null;
  let finalOffset = startByte;
  let newEvents = 0;
  const lineBase = lineNo;
  for await (const ev of walkWire(archive, startByte, lineBase)) {
    finalOffset = ev.nextByteOffset;
    lineNo = ev.lineNo;
    recordConversationEvent(db, key, sessionId, ev.lineNo, ev.byteOffset, ev);
    newEvents += 1;
    if (ev.created_at) lastEventAt = ev.created_at;
  }
  updateConversationProgress(db, key, sessionId, finalOffset, lineNo, lastEventAt);
  state.sessions[sessionId] = {
    work_dir_key: wdk,
    byte_offset: finalOffset,
    line_count: lineNo,
    last_event_at: lastEventAt,
    last_import_at: nowIso(),
  };
  await saveIngestState(HOME, key, state);
  return { ok: true, ingested: newEvents, session_id: sessionId, archive, project_key: key };
}

async function handleSessionEnd(payload) {
  // SessionEnd is the final chance to ingest this session. Idempotent
  // and silent on stdout; the only side effect is the project DB.
  return handleStop(payload);
}

async function handlePreCompact(payload) {
  // PreCompact: snapshot the transcript before context compaction. We
  // run the same idempotent ingest and stay silent on stdout.
  const result = await handleStop(payload);
  return { ok: true, snapshot: result };
}

async function handleInterrupt(payload) {
  const cwd = payloadProjectRoot(payload);
  const snapshot = await handleStop(payload);
  await logDiag('info', 'interrupt observed', { cwd, snapshot });
  return { ok: true, snapshot };
}

async function handleStopFailure(payload) {
  const cwd = payloadProjectRoot(payload);
  const snapshot = await handleStop(payload);
  await logDiag('warn', 'stop-failure observed', { cwd, snapshot });
  return { ok: true, snapshot };
}

// Mid-turn recall: when the agent invokes a tool (read, edit,
// shell), look up matching stored memories and emit a small set of
// [tool-recall] lines on stdout before the model continues. Mimics
// hippocampal replay during task-relevant cues.
//
// The PostToolUse event is part of the Kimi hook surface; older
// versions may not declare it. When the handler is never invoked
// the plugin degrades to the current behaviour silently — no error
// is surfaced because there is nothing for the hook to do.
const TOOL_ARGS_KEYS = [
  'tool_input',
  'toolInput',
  'input',
  'args',
  'arguments',
  'command',
  'file_path',
  'path',
];

function payloadToolArgs(payload) {
  if (!isPlainObject(payload)) return null;
  for (const key of TOOL_ARGS_KEYS) {
    const v = payload[key];
    if (v == null) continue;
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'object') return v;
  }
  // Some Kimi versions nest tool input under a `tool_call` envelope.
  if (payload.tool_call && typeof payload.tool_call === 'object') {
    return payload.tool_call.input || payload.tool_call.args || null;
  }
  return null;
}

async function handlePostToolUse(payload) {
  const cwd = payloadProjectRoot(payload);
  if (!cwd) return { ok: false, reason: 'no project cwd in payload' };
  const toolArgs = payloadToolArgs(payload);
  if (toolArgs == null) return { ok: true, skipped: 'no_tool_args', lines: [] };
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const projectDb = safeOpenDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  const globalDb = safeOpenDb(path.join(HOME, 'kimi-memory', '_global', 'memory.sqlite'));
  let result;
  try {
    result = await runToolRecall({
      projectDb,
      globalDb,
      projectKey: key,
      toolArgs,
    });
  } catch (e) {
    await logDiag('warn', 'tool_recall threw', { error: e && e.message });
    return { ok: true, skipped: 'tool_recall_threw', lines: [] };
  }
  const lines = formatToolRecallLines(result);
  if (lines.length > 0) emitLines(lines);
  return { ok: true, hits: result.hits.length, lines };
}

// Cost guards before we spend an LLM call on extraction.
//
// Tuned 2026-08-02: previous bounds (min=6 events, latency=5min) made
// the extract skip almost every real-world session — long pauses
// between turns would age the "in-flight" check out, and the minimum
// excluded single-question research sessions. The new bounds still
// avoid firing on genuinely tiny or stale sessions; raise the env
// override `KIMI_MEMORY_EXTRACT_MAX_LATENCY_MS` if a project wants
// stricter behavior.
const EXTRACT_MIN_EVENTS = 4; // need enough to be worth extracting from
const EXTRACT_MIN_AGE_MS = 0; // not used directly; see EXTRACT_MAX_LATENCY_MS
const EXTRACT_MAX_LATENCY_MS =
  Number(process.env.KIMI_MEMORY_EXTRACT_MAX_LATENCY_MS) || 30 * 60 * 1000; // events must be <30min old

// Build a short transcript from the most recent conversation events.
// Uses the pre-extracted `summary` field; falls back to a snippet of the
// raw payload for events that have no summary (tool calls etc).
function buildTranscript(db, projectKey, sessionId, { limit = 6 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT role, summary, payload, kind, created_at
    FROM conversation_events
    WHERE project_key = ? AND session_id = ?
    ORDER BY line_no DESC LIMIT ?
  `,
    )
    .all(projectKey, sessionId, limit);
  // Reverse so the transcript reads oldest → newest.
  rows.reverse();
  const out = [];
  for (const r of rows) {
    if (!r.summary) continue;
    const who =
      r.role === 'user'
        ? 'USER'
        : r.role === 'assistant'
          ? 'ASSISTANT'
          : (r.role || 'SYSTEM').toUpperCase();
    out.push(`${who}: ${r.summary}`);
  }
  return out.join('\n\n');
}

// Pull the most-recent event timestamp for the session. Used by the
// cost guard: if the latest exchange is older than EXTRACT_MAX_LATENCY_MS
// the user is no longer in flight, so we skip extraction.
function latestEventAgeMs(db, projectKey, sessionId) {
  const row = db
    .prepare(
      `
    SELECT created_at FROM conversation_events
    WHERE project_key = ? AND session_id = ?
    ORDER BY line_no DESC LIMIT 1
  `,
    )
    .get(projectKey, sessionId);
  if (!row || !row.created_at) return Infinity;
  const t = Date.parse(row.created_at);
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

// Triggered after the ingest pass. Cost guards:
//   - env opt-out (KIMI_MEMORY_AUTO_EXTRACT=off) → no-op
//   - config opt-out ([kimi-memory] disable_auto_extract = true) → no-op
//   - session has fewer than EXTRACT_MIN_EVENTS events → skip
//   - latest event older than EXTRACT_MAX_LATENCY_MS → skip
//   - LLM call timed out / failed → skip (counted via result.skipped)
//   - candidates are deduped against existing memories via the hybrid
//     recall (#1); duplicates are dropped, never re-saved
async function handleAutoExtract(cwd, sessionId) {
  if (!cwd || !sessionId) return { skipped: 'missing_cwd_or_session', saved: 0 };
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const db = openDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  try {
    const count = db
      .prepare(
        'SELECT COUNT(*) AS n FROM conversation_events WHERE project_key = ? AND session_id = ?',
      )
      .get(key, sessionId).n;
    if (count < EXTRACT_MIN_EVENTS) return { skipped: 'too_few_events', count };
    const age = latestEventAgeMs(db, key, sessionId);
    if (age > EXTRACT_MAX_LATENCY_MS) return { skipped: 'stale_session', age_ms: age };
    const transcript = buildTranscript(db, key, sessionId, { limit: 6 });
    if (!transcript) return { skipped: 'no_summary_text' };
    const existingTitles = db
      .prepare(
        "SELECT title FROM memories WHERE project_key = ? AND status = 'active' AND (title IS NOT NULL AND title != '') ORDER BY updated_at DESC LIMIT 50",
      )
      .all(key)
      .map((r) => r.title);
    const r = await runAutoExtract({
      homeDir: HOME,
      cwd,
      projectKey: key,
      db,
      transcript,
      existingTitles,
      saveMemory,
      searchMemories,
    });
    return r;
  } catch (e) {
    await logDiag('warn', 'auto_extract threw', { error: e && e.message });
    return { skipped: 'extract_threw', error: e && e.message };
  }
}

const HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  Stop: handleStop,
  SessionEnd: handleSessionEnd,
  PreCompact: handlePreCompact,
  Interrupt: handleInterrupt,
  StopFailure: handleStopFailure,
  PostToolUse: handlePostToolUse,
};

async function main() {
  const raw = await readStdin(256 * 1024);
  // Parse the stdin payload exactly once. The previous shape ran
  // safeJsonParse twice on every hook (once for `.ok`, then again for
  // `.value` on the success path), spending a stringify/parse cycle on
  // up-to 256 KiB of JSON unnecessarily. Stress-tests amplified the
  // cost because they call hooks in tight loops. (Audit fix.)
  let parsed;
  if (raw.length === 0) parsed = {};
  else {
    const r = safeJsonParse(raw);
    parsed = r.ok ? r.value : { _raw: raw };
  }
  const handler = HANDLERS[EVENT];
  if (!handler) {
    await logDiag('warn', 'no handler for event', { event: EVENT });
    return;
  }
  try {
    const result = await handler(parsed);
    await logDiag('info', 'handler ok', { event: EVENT, result });
  } catch (err) {
    // Fail open: log and exit 0 so Kimi isn't blocked.
    await logDiag('error', 'handler threw', { event: EVENT, error: err && err.message });
    try {
      process.stdout.write(`[kimi-memory] hook ${EVENT} failed: ${err && err.message}\n`);
    } catch {
      /* ignore */
    }
  } finally {
    // Release cached SQLite handles so subsequent hooks / processes
    // do not race with WAL cleanup.
    try {
      closeDb();
    } catch {
      /* ignore */
    }
  }
}

// Hard-timeout guard: if anything blocks, release cached SQLite
// handles (so any pending WAL writes flush) and exit cleanly after
// 8s. The timeout is shorter than the manifest-level hook timeouts
// (10–15s) on purpose — a slow hook that runs past 8s is most likely
// stuck on I/O we cannot recover from, and we'd rather emit a clean
// exit than be killed mid-write.
const t = setTimeout(() => {
  try {
    process.stderr.write('[kimi-memory:hook:' + EVENT + '] timeout, exiting\n');
  } catch {
    /* ignore */
  }
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
}, 8000);
t.unref?.();

// Only run the dispatcher when this module is loaded as a hook (i.e.
// KM_HOOK_EVENT is set by one of the hook shim entry points). Tests
// import the module for its helpers; without this guard the module
// would read stdin and exit before the test runner gets a turn.
if (process.env.KM_HOOK_EVENT) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

// Exported for unit tests (tests/22-brain-modes.test.js). These
// helpers have no side effects on import, so a test runner can pull
// them in directly without triggering the hook dispatcher above.
// Kept as a small, focused surface so tests don't have to drive the
// hook over stdio to exercise the pure helpers.
export {
  buildRecallQuery,
  diversifyHitsByType,
  readRecentFilePaths,
  buildSessionThread,
  formatConsolidateSegment,
};
