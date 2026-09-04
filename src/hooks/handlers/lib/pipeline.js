// Pipeline helpers for hook handlers.
//
// This file holds every helper that touches the DB, runs an LLM call,
// or threads state through per-event dispatch — i.e. the side-effectful
// surface of the hook layer. Pure constants and pure formatters live
// in `constants.js` and `format.js` respectively; this module imports
// from both and stitches them together for the per-event handlers.
//
// The shared session-focus helpers (`buildSessionFocusLine`,
// `formatFocusSegment`, `readLatestSessionFocus`) are re-exported here
// so per-event handlers can pull them from one place. They are also
// re-exported from `session-focus.js` directly.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { nowIso, readStdin, safeJsonParse, PATH_REGEX } from '../../../util.js';
import {
  canonicalizeRoot,
  deriveProjectKey,
  ensureProjectDir,
  GLOBAL_PROJECT_KEY,
  globalDbPath,
} from '../../../project-key.js';
import {
  openDb,
  closeDb,
  saveMemory,
  listMemories,
  searchMemories,
  listWorkingMemory,
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
  resetProject,
  wipeProjectLifecycleLogs,
} from '../../../persist.js';
import { locateSessionArchive, walkWire, readSessionIndex } from '../../../wire.js';
import { runAutoExtract } from '../../../extract.js';
import { maybeWriteWorkLog, recordWorkLogResult } from '../../../work-log.js';
import {
  captureSessionFocus,
  recordSessionFocusResult,
  readLatestSessionFocus,
  buildSessionFocusLine,
  formatFocusSegment,
} from '../../../session-focus.js';
import {
  STATUS_RECENT_MEMORIES,
  STATUS_RECENT_WM_SLOTS,
  STATUS_RECENT_GLOBAL,
  PROMPT_TOKEN_LIMIT,
  PAYLOAD_CWD_KEYS,
  PAYLOAD_SESSION_KEYS,
  PAYLOAD_PROMPT_KEYS,
  MAX_THREAD_SESSIONS,
  AUTO_GC_THROTTLE_HOURS,
  EXTRACT_MIN_EVENTS,
  EXTRACT_MAX_LATENCY_MS,
  HOME,
  EVENT,
  RECALL_BASE_LIMIT,
  RECALL_MIN_HITS,
  RECALL_GAP_FACTOR,
} from './constants.js';
import {
  formatConsolidateSegment,
  formatAutoGcSegment,
  formatIngestSegment,
  formatDreamSegment,
  formatExtractSegment,
  formatWorkLogSegment,
} from './format.js';

export { buildSessionFocusLine, formatFocusSegment, readLatestSessionFocus };

import { runConsolidate } from '../../../consolidate.js';
import { runAutoGc, runAutoTier } from '../../../auto-gc.js';
import {
  enqueueDreamJob,
  generateProposalsForJob,
  applyDreamJob,
  findReadyJob,
  buildDreamStatus,
  shouldEnqueue as shouldEnqueueDream,
  lastDreamEnqueuedAt,
  getAutoApplyConfidence,
} from '../../../dream.js';
import { runDreaming } from '../../../dreaming.js';
import { logHookDiag } from '../../../diagnostics.js';

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

// ---- String utilities ----

export function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Pick the first non-empty line of a memory body and squeeze it onto
// one line so it can ride on the bounded [recall: i/N] line. Newlines
// are collapsed to single spaces; tabs and runs of spaces become one
// space. Returns '' for empty / missing bodies so the caller can omit
// the trailing " — …" when there is nothing useful to quote.
export function firstContentLine(content) {
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
export function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural || singular + 's'}`;
}

// Score-gap elbow. Pure helper so the gap filter is unit-testable
// without going through the full FTS+embedding pipeline (where
// producing a clean score gap is fragile). Given an array of hits
// with `id` and `score` fields, returns a new array containing only
// hits whose score is >= `topScore * factor`. `factor = 0` disables
// the filter (returns the input unchanged). `factor` is clamped to
// [0, 1] so a typo'd config can't produce weird results.
export function applyScoreGapFilter(hits, factor) {
  if (!Array.isArray(hits) || hits.length <= 1) return hits;
  const f = Math.max(0, Math.min(1, Number(factor) || 0));
  if (f === 0) return hits;
  // Use `.toSorted()` (Node 24+) so the input array is not mutated.
  const sorted = hits.toSorted((a, b) => (b.score || 0) - (a.score || 0));
  const topScore = sorted[0].score || 0;
  const elbow = topScore * f;
  const keep = new Set();
  for (const m of sorted) {
    if ((m.score || 0) >= elbow) keep.add(m.id);
  }
  return hits.filter((m) => keep.has(m.id));
}
export function derivePromptTokens(prompt) {
  if (!prompt) return [];
  const tokens = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 32);
  return tokens.slice(0, PROMPT_TOKEN_LIMIT);
}

// ---- Recall: composite query builder + diversifier ----

// Build the composite recall query for a UserPromptSubmit. The legacy
// behaviour used prompt tokens only; v9 adds three more sources so
// recall picks up cues the prompt alone would miss: prompt tokens,
// working-memory slot values, last session-focus title, recent file
// paths from tool-call events.
//
// Tokens are de-duplicated case-insensitively. The result is a single
// space-joined string that the existing searchMemories() consumes as
// if it were a normal query.
export function buildRecallQuery({ prompt, workingSlots, focusRow, recentFiles }) {
  const seen = new Set();
  const tokens = [];
  const push = (text) => {
    if (!text) return;
    for (const t of derivePromptTokens(text)) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(t);
    }
  };
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
// directory tokens so path-based memories match.
export function readRecentFilePaths(projectDb, projectKey, { limit = 5 } = {}) {
  if (!projectDb) return [];
  const TOOL_PAYLOAD_LIMIT = 64 * 1024;
  const MAX_PATHS_PER_ROW = 16;
  let rows;
  try {
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
  const out = [];
  const seen = new Set();
  const pathRegex = PATH_REGEX;
  for (const r of rows) {
    if (!r.payload) continue;
    let text = r.payload;
    if (text.length > TOOL_PAYLOAD_LIMIT) text = text.slice(0, TOOL_PAYLOAD_LIMIT);
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
      const norm = m.replace(/\\/g, '/').toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(m.replace(/\\/g, '/'));
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
export function diversifyHitsByType(hits, { topN = 3 } = {}) {
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

export async function buildRecallSummary({ projectDb, globalDb, key, prompt }) {
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
      topHits: [],
    };
  }
  // (Audit fix — recall always returned 8 hits once a project had 8+
  // memories.) Pool-aware per-DB limit + score-gap elbow. The previous
  // behaviour was a hard `8` per DB regardless of how many memories
  // the project actually had, so an 8-memory project surfaced 8 hits
  // on every prompt even when only 1 was actually relevant. The new
  // shape:
  //   - Cap per DB at `RECALL_BASE_LIMIT` (the previous default).
  //   - For small pools, lower the cap so we don't surface ~75% of
  //     every saved memory on every prompt — `ceil(poolSize / 2)`,
  //     with a `RECALL_MIN_HITS` floor so a project with one memory
  //     still gets surfaced (it's the only thing to show).
  //   - The cap is the SQL `limit` so we don't even read the padding
  //     rows off disk. The gap filter (top-N by score elbow) trims
  //     the tail further once search returns.
  const projectActive = projectDb ? memoryCounts(projectDb, key).active || 0 : 0;
  const globalActive = globalDb ? memoryCounts(globalDb, GLOBAL_PROJECT_KEY).active || 0 : 0;
  // poolSize is the denominator for the `Recalled N of M.` summary
  // line so the user sees how representative the hits are. 0 on a
  // fresh install (neither DB exists).
  const poolSize = projectActive + globalActive;
  const projectLimit = Math.max(
    RECALL_MIN_HITS,
    Math.min(RECALL_BASE_LIMIT, Math.ceil(projectActive / 2)),
  );
  const globalLimit = Math.max(
    RECALL_MIN_HITS,
    Math.min(RECALL_BASE_LIMIT, Math.ceil(globalActive / 2)),
  );

  const rawProjectHits = projectDb
    ? await searchMemories(projectDb, key, query, {
        limit: projectLimit,
        perType: true,
        includeScore: true,
      })
    : [];
  const rawGlobalHits = globalDb
    ? await searchMemories(globalDb, GLOBAL_PROJECT_KEY, query, {
        limit: globalLimit,
        perType: true,
        includeScore: true,
      })
    : [];

  // Score-gap elbow. After per-type bucketing has produced the
  // balanced candidate list, drop any hit whose RRF score is below
  // `topScore * RECALL_GAP_FACTOR`. The intuition: a hit at <40% of
  // the top hit's relevance is probably a noisy keyword/embedding
  // match, not a real connection the agent should surface. Disabled
  // when factor = 0 (tests + opt-out escape hatch). See
  // `applyScoreGapFilter` for the pure helper + test coverage.
  let projectHits = rawProjectHits;
  let globalHits = rawGlobalHits;
  if (RECALL_GAP_FACTOR > 0 && rawProjectHits.length + rawGlobalHits.length > 1) {
    const allRaw = [...rawProjectHits, ...rawGlobalHits];
    const trimmedAll = applyScoreGapFilter(allRaw, RECALL_GAP_FACTOR);
    const keep = new Set(trimmedAll.map((m) => m.id));
    projectHits = rawProjectHits.filter((m) => keep.has(m.id));
    globalHits = rawGlobalHits.filter((m) => keep.has(m.id));
  }

  const allHits = [...projectHits, ...globalHits];
  const total = allHits.length;

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
    const ofTotal = poolSize > 0 ? ` of ${poolSize}` : '';
    summary =
      `Recalled ${pluralize(total, 'memory', 'memories')}${ofTotal}. (${parts.join(', ')}.) ${typeStr}`.trim();
  }
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

// Build the AI-facing recall context for `hookSpecificOutput.additionalContext`.
// Returns null when there are no hits so the caller can skip the
// `additionalContext` field entirely.
export function buildRecallContextLines(recall, topHits) {
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

// ---- Snapshot builders ----

export function buildCounts({ projectDb, globalDb, key }) {
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

export function zeroCounts() {
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

export function buildStatusLine({
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
  dream,
}) {
  const ingestSeg = formatIngestSegment(ingest);
  const recallSeg = recall ? ` recall project:${recall.project} global:${recall.global}` : '';
  const extractSeg = extract ? ` extract=${formatExtractSegment(extract)}` : '';
  const workLogSeg = workLog ? ` work_log=${formatWorkLogSegment(workLog)}` : '';
  const focusSeg = focus ? ` focus=${formatFocusSegment(focus)}` : '';
  const consolidateSeg = consolidate ? ` consolidate=${formatConsolidateSegment(consolidate)}` : '';
  const autoGcSeg = autoGc ? ` auto_gc=${formatAutoGcSegment(autoGc)}` : '';
  const dreamSeg = dream ? ` dream=${formatDreamSegment(dream)}` : '';
  return [
    `[kimi-memory] event=${event}`,
    `project_key=${key}`,
    `pmem.active=${counts.project.active}`,
    `gmem.active=${counts.global.active}`,
    `wm=${counts.wm.length}`,
    `conv=${counts.conv}`,
    `events=${counts.events}`,
    `ingest=${ingestSeg}${extractSeg}${workLogSeg}${focusSeg}${consolidateSeg}${autoGcSeg}${dreamSeg}${recallSeg}`,
    `cwd=${cwd}`,
  ].join(' ');
}

export function buildRecentSummary(projectDb, globalDb, key) {
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

export function buildWorkingMemoryPreview(projectDb, key) {
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
// Auto-reset (default on, opt-out via KIMI_MEMORY_AUTO_RESET_ON_RECLONE=off):
// when detectReclone fires, wipe the project's per-row tables in a
// single transaction and report what was deleted. The reset itself
// is one-shot per re-clone event — resetProject updates first_seen_at
// to now, which neutralises detectReclone on the next SessionStart
// so subsequent sessions don't re-fire.
//
// Default on: most users who re-clone a repo want the prior
// incarnation's memories wiped, not silently carried forward. Set
// the env to `off` to keep the manual `[stale-memory]` hint instead.
export function buildStaleMemoryLine(projectDb, key, cwd) {
  if (!projectDb || !key || !cwd) return null;
  let r;
  try {
    r = detectReclone(projectDb, key, cwd);
  } catch {
    return null;
  }
  if (!r || !r.isReclone) return null;

  if (process.env.KIMI_MEMORY_AUTO_RESET_ON_RECLONE === 'off') {
    return (
      `[stale-memory] ${cwd} appears to have been re-cloned after kimi-memory first saw it. ` +
      `Per-project memory (memories, working memory, session archive) belongs to the previous incarnation. ` +
      `Call memory_reset_project (with confirm=true) to start clean, or memory_status to see what's on file. ` +
      `Set KIMI_MEMORY_AUTO_RESET_ON_RECLONE=off to keep the manual hint instead of auto-wiping. ` +
      `(reason: ${r.reason || 'directory birthtime is newer than first_seen_at'})`
    );
  }

  // Opt-in auto-reset path. Wrapped in try/catch so any wipe failure
  // falls back to the manual hint rather than crashing the session.
  let summary;
  let lifecycle;
  try {
    summary = resetProject(projectDb, key, { canonicalRoot: cwd });
    lifecycle = wipeProjectLifecycleLogs(projectDb, key);
  } catch (e) {
    return (
      `[stale-memory:auto-reset-failed] ${cwd} re-clone detected but reset failed: ` +
      `${e && e.message ? e.message : String(e)}. ` +
      `Call memory_reset_project (with confirm=true) to start clean. ` +
      `(reason: ${r.reason || 'directory birthtime is newer than first_seen_at'})`
    );
  }
  const total =
    (summary.memories_deleted || 0) +
    (summary.working_memory_deleted || 0) +
    (summary.conversations_deleted || 0) +
    (summary.conversation_events_deleted || 0) +
    (summary.memory_edges_deleted || 0) +
    (summary.memory_synthesizes_deleted || 0) +
    (lifecycle.dream_jobs_deleted || 0) +
    (lifecycle.dream_proposals_deleted || 0) +
    (lifecycle.consolidation_runs_deleted || 0);
  return (
    `[stale-memory:auto-reset] ${cwd} re-cloned; wiped ${total} per-project rows ` +
    `(memories:${summary.memories_deleted} wm:${summary.working_memory_deleted} ` +
    `sessions:${summary.conversations_deleted}/events:${summary.conversation_events_deleted} ` +
    `edges:${summary.memory_edges_deleted} synth:${summary.memory_synthesizes_deleted} ` +
    `dreams:${lifecycle.dream_jobs_deleted}/${lifecycle.dream_proposals_deleted} ` +
    `consolidation:${lifecycle.consolidation_runs_deleted}). Next session starts at 0. ` +
    `(reason: ${r.reason || 'directory birthtime is newer than first_seen_at'})`
  );
}

// Build a "[thread]" line listing the last few distinct sessions
// for the project. Returns null when the project has fewer than 2
// sessions on file.
export function buildSessionThread(projectDb, projectKey) {
  if (!projectDb) return null;
  let conversations;
  try {
    conversations = listConversations(projectDb, projectKey, { limit: MAX_THREAD_SESSIONS });
  } catch {
    return null;
  }
  if (!conversations || conversations.length < 2) return null;

  const lines = [];
  const ordered = [...conversations].reverse();
  lines.push(`[thread] (${ordered.length} sessions, oldest → newest)`);
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    let focus = null;
    try {
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

// Read the most recently persisted extract + work-log + session-focus
// stats for this project. Returns nulls for fields that have never
// been written.
export async function readLatestStats(cwd) {
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

// Run auto-GC, with the heavy passes (prune + archive) gated on a
// per-project timestamp stored in schema_meta. Tier promotion runs
// every open. Wraps the read + bypass check + run + stamp in a single
// `BEGIN IMMEDIATE` so two SessionStart invocations cannot both run
// and double-stamp.
export function runAutoGcThrottled(db, projectKey) {
  if (!db || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_AUTO_GC === 'off') {
    return { skipped: 'env_opt_out' };
  }

  const now = new Date();
  const tier = runAutoTier(db, projectKey, { now });

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

// ---- Snapshot ingest (shared by SessionStart / UserPromptSubmit / Stop) ----
//
// Idempotent wire.jsonl ingest. Used by every event that wants the
// project's archive to be up to date before reading from it.
export async function safeHandleStop(payload, cwd) {
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

// ---- Stdout emitter ----

export function emitLines(lines) {
  if (!lines || lines.length === 0) return;
  try {
    process.stdout.write(lines.join('\n') + '\n');
  } catch {
    /* ignore */
  }
}

// ---- Dream helpers ----

// Phase-1 Dream enqueue. Called from Stop / SessionEnd after the
// extract + work-log + session-focus steps have completed. Failures
// are swallowed + logged.
export async function maybeEnqueueDream(projectDb, projectKey, cwd) {
  if (!projectDb || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_DREAM === 'off') return { skipped: 'env_opt_out' };
  if (!cwd) return { skipped: 'no_cwd' };
  let eventCount = 0;
  try {
    eventCount = projectDb
      .prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE project_key=?')
      .get(projectKey).n;
  } catch {
    return { skipped: 'snapshot_threw' };
  }
  let last;
  try {
    last = lastDreamEnqueuedAt(projectDb, projectKey);
  } catch {
    last = null;
  }
  const gate = shouldEnqueueDream(projectDb, projectKey, {
    lastEnqueuedAt: last,
    eventCount,
  });
  if (!gate.enqueue) {
    return { skipped: gate.reason };
  }
  let enqueue;
  try {
    enqueue = enqueueDreamJob(projectDb, projectKey, { triggered_by: 'lifecycle' });
  } catch (e) {
    return { skipped: 'enqueue_threw', error: e && e.message };
  }
  if (enqueue && enqueue.status === 'enqueued' && enqueue.job_id) {
    try {
      const r = await generateProposalsForJob(projectDb, projectKey, enqueue.job_id, {
        saveMemory,
        memoryLink: linkMemory,
        mergeMemory,
      });
      return { ...enqueue, generate: r };
    } catch (e) {
      return { ...enqueue, generate: { ok: false, reason: 'threw', error: e && e.message } };
    }
  }
  return enqueue;
}
// wall-clock floor or activity gate). Called from SessionStart. The
// orchestrator decides mode + interval + include set from the
// per-project state file at $KIMI_CODE_HOME/kimi-memory/<project>/
// dreaming.json (with the global _config/dreaming.json as fallback).
// Returns the run summary so the status line can render the result.
// (Fires when the floor has elapsed or `force` is true; otherwise
// returns `{ fired: false, skipped: 'below_interval' }`.)
export async function maybeDreaming({ projectDb, projectKey, cwd, force = false, kimiHomeDir }) {
  if (!projectDb || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_DREAMING === 'off') return { skipped: 'env_opt_out' };
  let result;
  try {
    result = await runDreaming({
      db: projectDb,
      projectKey,
      cwd,
      force,
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      kimiHomeDir,
    });
  } catch (e) {
    return { skipped: 'threw', error: e && e.message ? e.message : String(e) };
  }
  return result;
}
// Phase-1 Dream apply. Called from SessionStart. We only ever apply
// one job per SessionStart so the 8s hook budget is never overrun.
export async function maybeApplyReadyDream(projectDb, projectKey) {
  if (!projectDb || !projectKey) return { skipped: 'no_inputs' };
  if (process.env.KIMI_MEMORY_DREAM === 'off') return { skipped: 'env_opt_out' };
  let readyId;
  try {
    readyId = findReadyJob(projectDb, projectKey);
  } catch {
    return { skipped: 'lookup_threw' };
  }
  if (!readyId) return { skipped: 'no_ready' };
  try {
    const r = applyDreamJob(projectDb, projectKey, readyId, {
      saveMemory,
      memoryLink: linkMemory,
      mergeMemory,
      autoApplyConfidence: getAutoApplyConfidence(),
    });
    return { applied_job_id: readyId, apply: r };
  } catch (e) {
    return { applied_job_id: readyId, skipped: 'apply_threw', error: e && e.message };
  }
}

// ---- Auto-extract transcript helpers ----

// Build a short transcript from the most recent conversation events.
// Uses the pre-extracted `summary` field; falls back to a snippet of
// the raw payload for events that have no summary.
export function buildTranscript(db, projectKey, sessionId, { limit = 6 } = {}) {
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
export function latestEventAgeMs(db, projectKey, sessionId) {
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
//   - session has fewer than EXTRACT_MIN_EVENTS events → skip
//   - latest event older than EXTRACT_MAX_LATENCY_MS → skip
export async function handleAutoExtract(cwd, sessionId) {
  if (!cwd || !sessionId) return { skipped: 'missing_cwd_or_session', saved: 0 };
  const key = deriveProjectKey(cwd);
  await ensureProjectDir(HOME, key);
  const db = openDb(path.join(HOME, 'kimi-memory', key, 'memory.sqlite'));
  // Global DB is opened alongside the project DB so the auto-extract
  // dispatcher can route cross-project candidates to the right store.
  // The global DB may not exist on a fresh install — `openDb` is
  // called with the default create flag because `saveMemory` may need
  // to lazy-create it when the first global candidate lands. The
  // dispatcher itself tolerates a null handle: it treats the candidate
  // as a soft error rather than a save.
  let globalDb = null;
  try {
    globalDb = openDb(globalDbPath(HOME));
  } catch {
    globalDb = null;
  }
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
      globalDb,
      globalProjectKey: GLOBAL_PROJECT_KEY,
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
